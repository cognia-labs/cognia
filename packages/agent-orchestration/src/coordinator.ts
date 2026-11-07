/**
 * The durable Agent Team coordinator (ADR-0217): run preparation, child
 * registration, fair admission, writer leases, steering, checkpoints,
 * recovery, retry and operator control (pause, resume, sleep, wake,
 * terminate, manual takeover).
 *
 * Host-independent. Run state goes through the {@link TeamRunStore}; the
 * host supplies its run journal, its PII redaction, its path semantics and
 * its remote-session projection as ports.
 */

import { createDecisionLedger } from "./decision-ledger"
import { createEvidenceBundle } from "./evidence"
import { createFairTeamScheduler } from "./fair-scheduler"
import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamRepositoryBinding,
  AgentTeamResourcePolicy,
  AgentTeamRunStatus,
  AgentTeamSideEffect,
  AgentTeamSteeringReceipt,
  AgentTeamTrajectoryEvent,
  AgentTeamWriteMode,
  StopProof,
} from "./records"
import {
  CHILD_ADMISSION_WAITING_REASON,
  isChildReplaySafe,
  assessRecoveryEligibility,
  childStopProof,
  isChildSettled,
  isChildNeverStarted,
  hasRemoteDispatch,
} from "./replay"
import { isTerminalTeamStatus } from "./rules"
import type { TeamRunStore } from "./store"

export interface DurableChildControl {
  /** Must route through the runtime's PII-gated steering adapter. */
  steer(message: string, sourceMessageId: string): Promise<void>
  pause?(): Promise<boolean | void>
  resume?(dispatchEpoch?: number): Promise<void>
  /** False only for resource preparation that cannot resume an executor. */
  resumeStartsExecution?: boolean
  terminate?(): Promise<StopProof | void>
}

/**
 * The team a durable run executes, as the coordinator needs it. Hosts map
 * their own team configuration onto this; nothing else of it is read.
 */
export interface DurableTeamSpec {
  id: string
  leadId: string
  projectId?: string
  /** The run's objective; also its title in the host's run journal. */
  objective: string
  /** Repository bindings; exactly one must be primary. */
  repositories?: readonly AgentTeamRepositoryBinding[]
  /** Fallback single writable primary repository when none are bound. */
  workingDir?: string
  writeMode?: AgentTeamWriteMode
  resourcePolicy?: AgentTeamResourcePolicy
  /** Per-team child concurrency when no resource policy is given. */
  maxConcurrentTeammates?: number
  environmentVersionId?: string
  /** Recorded as immutable user constraints when the run is created. */
  userConstraints?: readonly { title: string; detail: string }[]
}

/** The host's record of runs it executes (its run list, cockpit, history). */
export interface TeamRunJournal {
  /**
   * Called each time a run is prepared: record the run when it is new, note a
   * resumption when the host had it waiting. Must be idempotent per run.
   */
  runPrepared(input: {
    runId: string
    projectId?: string
    title: string
    at: number
  }): Promise<void>
}

/** Host path semantics (drive letters, UNC, case folding) for ownership checks. */
export interface TeamPathPolicy {
  /** Normalized absolute form, or `""` when the path cannot be resolved. */
  normalize(path: string): string
  /** Resolve disk aliases on the execution Host before taking a write lease. */
  canonicalize?(path: string): Promise<string>
  isWithinRoot(target: string, root: string): boolean
}

/** The host's handle on sessions a remote child ran in. */
export interface TeamRemoteSessions {
  /** Release a terminated remote child's session from the host's projection. */
  release(remoteSessionId: string): Promise<void>
}

export interface DurableTeamCoordinatorOptions<TConstraints = unknown> {
  /** Where run state lives. */
  store: TeamRunStore<TConstraints>
  journal: TeamRunJournal
  /**
   * Redact text the coordinator persists (steering messages, manual takeover
   * commands and diffs); `undefined` when it would still leak, which refuses
   * the write. Required: no coordinator persists unchecked text.
   */
  redactForPersistence: (text: string) => string | undefined
  paths: TeamPathPolicy
  remoteSessions: TeamRemoteSessions
  /** Query the runtime's owning host registry; undefined means unconfirmed. */
  localSessions?: {
    isStopped(
      runtime: string,
      sessionId?: string,
      registry?: AgentTeamChildRun["executorRegistry"]
    ): Promise<boolean | undefined>
  }
  now?: () => number
  globalConcurrency?: number
  localStopTimeoutMs?: number
  agingIntervalMs?: number
}

export interface RegisterDurableChildInput {
  runId: string
  childRunId: string
  teammateId: string
  taskId: string
  repositoryId: string
  access: "read" | "write"
  runtime?: string
  executorRegistry?: AgentTeamChildRun["executorRegistry"]
  sessionId?: string
  workspacePath?: string
  branch?: string
  fileOwnership?: string[]
}

export interface WorkspaceLeaseRequest {
  runId: string
  repositoryId: string
  access: "read" | "write"
  fileOwnership?: string[]
  childRunId?: string
}

export interface RecoveryOutcome {
  runId: string
  status: Extract<AgentTeamRunStatus, "recovering" | "needs_input" | "cancelled" | "terminated">
}

interface RunPolicy {
  teamId: string
  writeMode: AgentTeamWriteMode
  repositories: Map<string, AgentTeamRepositoryBinding>
  resourcePolicy: AgentTeamResourcePolicy
}

interface ActiveOwnership {
  leaseId: string
  paths: string[]
  released: Promise<void>
}

/**
 * Whether a child may be replayed from its checkpoint (the rule:
 * `isChildReplaySafe`), reading the latest checkpoint and the run's
 * trajectory from `store` when the caller has not already loaded them.
 */
export async function isStoredChildReplaySafe(
  store: TeamRunStore<unknown>,
  childRunId: string,
  checkpoint?: AgentTeamCheckpoint,
  trajectory?: readonly AgentTeamTrajectoryEvent[]
): Promise<boolean> {
  const candidate = checkpoint ?? (await store.getLatestCheckpoint(childRunId))
  if (!candidate) return false
  const events = trajectory ?? (await store.listTrajectory(candidate.runId))
  return isChildReplaySafe(childRunId, candidate, events)
}

// Renderer activity can disprove stop, but its absence cannot prove host quiescence.
const localActivity = new WeakMap<object, Set<() => ReadonlySet<string>>>()
const localHostSessions = new WeakMap<
  object,
  NonNullable<DurableTeamCoordinatorOptions["localSessions"]>
>()
function activeLocalChildrenFor(store: object): ReadonlySet<string> {
  return new Set([...(localActivity.get(store) ?? [])].flatMap((activity) => [...activity()]))
}

/** Local quiescence requires an affirmative host answer, including after reload. */
export async function isStoredChildStopped(
  store: TeamRunStore<unknown>,
  child: AgentTeamChildRun,
  now: number,
  activeLocalChildIds = activeLocalChildrenFor(store),
  localSessions = localHostSessions.get(store)
): Promise<boolean> {
  if (child.status === "completed") return isChildSettled(child)
  if (isChildSettled(child) || !!childStopProof(child, now)) return true
  if (isChildNeverStarted(child)) {
    const [checkpoint, trajectory] = await Promise.all([
      store.getLatestCheckpoint(child.id),
      store.listTrajectory(child.runId),
    ])
    if (isChildNeverStarted(child, checkpoint, trajectory)) return true
  }
  if (hasRemoteDispatch(child) || activeLocalChildIds.has(child.id) || !child.runtime) return false
  try {
    return (
      (await localSessions?.isStopped(child.runtime, child.sessionId, child.executorRegistry)) ===
      true
    )
  } catch {
    return false
  }
}

/** Store-backed adapter of the pure task gate, shared by every execution entry. */
export async function assessStoredTaskRecovery(
  store: TeamRunStore<unknown>,
  runId: string,
  taskId: string,
  now: number,
  prospectiveChildId?: string,
  activeLocalChildIds = activeLocalChildrenFor(store),
  localSessions = localHostSessions.get(store)
) {
  const children = (await store.listChildren(runId)).filter(
    (child) => child.id !== prospectiveChildId
  )
  const checkpoints = await Promise.all(
    children
      .filter((child) => child.taskId === taskId)
      .map((child) => store.getLatestCheckpoint(child.id))
  )
  const stoppedLocalChildIds = new Set<string>()
  await Promise.all(
    children
      .filter((child) => child.taskId === taskId)
      .map(async (child) => {
        if (await isStoredChildStopped(store, child, now, activeLocalChildIds, localSessions))
          stoppedLocalChildIds.add(child.id)
      })
  )
  return assessRecoveryEligibility(
    { runId, taskId },
    children,
    checkpoints,
    await store.listTrajectory(runId),
    now,
    stoppedLocalChildIds
  )
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

const EMPTY_USAGE: AgentTeamChildRun["resourceUsage"] = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  wallTimeMs: 0,
  toolTimeMs: 0,
  attempts: 1,
  failures: 0,
}

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function normalizeRepositories(team: DurableTeamSpec): Map<string, AgentTeamRepositoryBinding> {
  const configured = team.repositories
  const repositories: readonly AgentTeamRepositoryBinding[] =
    configured && configured.length > 0
      ? configured
      : team.workingDir
        ? [{ id: "primary", role: "primary", path: team.workingDir, writable: true }]
        : []
  const primary = repositories.filter((repo) => repo.role === "primary")
  if (primary.length !== 1) {
    throw new Error("Durable AgentTeam requires exactly one primary repository")
  }
  const ids = new Set<string>()
  for (const repository of repositories) {
    if (!repository.id || !repository.path) {
      throw new Error("Durable AgentTeam repository bindings require id and path")
    }
    if (ids.has(repository.id)) throw new Error(`Duplicate repository id: ${repository.id}`)
    ids.add(repository.id)
    for (const dependency of repository.dependsOn ?? []) {
      if (dependency === repository.id) {
        throw new Error(`Repository ${repository.id} cannot depend on itself`)
      }
    }
  }
  for (const repository of repositories) {
    for (const dependency of repository.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Unknown repository dependency: ${dependency}`)
    }
  }
  return new Map(repositories.map((repository) => [repository.id, repository]))
}

function overlaps(paths: TeamPathPolicy, a: string[], b: string[]): boolean {
  return a.some((left) =>
    b.some((right) => paths.isWithinRoot(left, right) || paths.isWithinRoot(right, left))
  )
}

/**
 * Deep module for durable child control. The store is the source of truth;
 * the maps below hold process-local provider handles, writer locks and
 * scheduler state only, so another process recovers from the store alone.
 */
export function createDurableTeamCoordinator<TConstraints = unknown>(
  options: DurableTeamCoordinatorOptions<TConstraints>
) {
  const { store, journal, paths, remoteSessions } = options
  if (options.localSessions) localHostSessions.set(store, options.localSessions)
  const now = options.now ?? Date.now
  const persistable = (text: string, refusal: string): string => {
    const redacted = options.redactForPersistence(text)
    if (redacted === undefined) throw new Error(refusal)
    return redacted
  }
  const policies = new Map<string, RunPolicy>()
  const controls = new Map<string, DurableChildControl>()
  const writerTails = new Map<string, Promise<void>>()
  const activeOwnership = new Map<string, ActiveOwnership[]>()
  const scheduler = createFairTeamScheduler({
    globalConcurrency: options.globalConcurrency ?? 8,
    agingIntervalMs: options.agingIntervalMs ?? 30_000,
  })
  const admissionWaiters = new Map<string, () => void>()
  const pausedRuns = new Set<string>()
  const runResumeWaiters = new Map<string, Set<() => void>>()
  const admissions = new Map<string, { controller: AbortController; runId?: string }>()
  const pendingWakes = new Map<string, Promise<void>>()
  const executions = new Map<string, Promise<void>>()
  const activeLocalChildren = () =>
    new Set([...controls.keys(), ...admissions.keys(), ...executions.keys()])
  const processActivity = localActivity.get(store) ?? new Set<() => ReadonlySet<string>>()
  processActivity.add(activeLocalChildren)
  localActivity.set(store, processActivity)
  const assessTaskRecovery = (
    runId: string,
    taskId: string,
    tx: TeamRunStore = store,
    prospectiveChildId?: string
  ) =>
    assessStoredTaskRecovery(
      tx,
      runId,
      taskId,
      now(),
      prospectiveChildId,
      activeLocalChildrenFor(store),
      localHostSessions.get(store)
    )

  /** Tracks the real executor promise, not a timeout/abort race around it. */
  const trackChildExecution = async <T>(
    childRunId: string,
    operation: () => Promise<T>,
    stopEvidence?: () => Promise<void> | undefined
  ): Promise<T> => {
    let settled!: () => void
    const completion = new Promise<void>((resolve) => {
      settled = resolve
    })
    if (executions.has(childRunId)) throw new Error("Child already has a live execution")
    executions.set(childRunId, completion)
    try {
      return await operation()
    } finally {
      const release = () => {
        if (executions.get(childRunId) === completion) executions.delete(childRunId)
        settled()
      }
      const pending = stopEvidence?.()
      // Capture can finish before the executor. Keep local activity and stop
      // waiters alive until independent evidence has also been persisted.
      if (pending) void pending.then(release, () => undefined)
      else release()
    }
  }
  const waitForLocalSettlement = async (childRunId: string): Promise<boolean> => {
    const pending = executions.get(childRunId)
    if (!pending) {
      const child = await store.getChild(childRunId)
      return !!child && (await isStoredChildStopped(store, child, now()))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending.then(async () => {
          const child = await store.getChild(childRunId)
          return !!child && (await isStoredChildStopped(store, child, now()))
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), options.localStopTimeoutMs ?? 5_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const assertRunnable = async (childRunId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (isTerminalTeamStatus(child.status)) {
      throw new Error(`Durable child ${childRunId} is terminal: ${child.status}`)
    }
    if (["pausing", "paused", "sleeping", "needs_input"].includes(child.status)) {
      throw new Error(
        `Durable child ${childRunId} is not accepting new turns while ${child.status}`
      )
    }
    const run = await store.getRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)
    if (
      isTerminalTeamStatus(run.status) ||
      run.status === "needs_input" ||
      run.stop?.state === "requested" ||
      run.stop?.state === "unconfirmed"
    ) {
      throw new Error(
        `Durable AgentTeam run ${run.id} is not accepting new turns while ${run.status}`
      )
    }
    signal?.throwIfAborted()
    return { child, run }
  }

  const assertBudget = async (
    childRunId: string,
    run: NonNullable<Awaited<ReturnType<typeof store.getRun>>>
  ) => {
    const resource = policies.get(run.id)?.resourcePolicy
    if (!resource) return
    const usage = run.resourceUsage
    const wallTimeMs = Math.max(0, now() - (run.startedAt ?? run.createdAt))
    if (
      (resource.maxTokens !== undefined && (usage?.totalTokens ?? 0) >= resource.maxTokens) ||
      (resource.maxCostUsd !== undefined && (usage?.costUsd ?? 0) >= resource.maxCostUsd) ||
      (resource.maxWallTimeMs !== undefined && wallTimeMs >= resource.maxWallTimeMs)
    ) {
      const at = now()
      const child = await store.getChild(childRunId)
      const gated = await store.updateRunIfCurrent(
        run.id,
        { status: run.status, updatedAt: run.updatedAt },
        {
          status: "needs_input",
          recoveryReason: "resource_budget_exhausted",
          updatedAt: at,
        }
      )
      if (gated && child && !isTerminalTeamStatus(child.status)) {
        await store.updateChildIfCurrent(childRunId, child, {
          status: "needs_input",
          error: "Resource budget exhausted",
          updatedAt: at,
        })
      }
      throw new Error("Durable AgentTeam resource budget exhausted")
    }
  }

  const pumpAdmissions = (): void => {
    let next = scheduler.acquire(now())
    while (next) {
      admissionWaiters.get(next.id)?.()
      admissionWaiters.delete(next.id)
      next = scheduler.acquire(now())
    }
  }

  const prepareRun = async (team: DurableTeamSpec, runId = newId("team-run")): Promise<string> => {
    const repositories = normalizeRepositories(team)
    const at = now()
    const priority = team.resourcePolicy?.priority ?? 0
    const existing = await store.getRun(runId)
    if (!existing) {
      await store.createRun({
        id: runId,
        teamId: team.id,
        ...(team.projectId ? { projectId: team.projectId } : {}),
        objective: team.objective,
        status: "running",
        priority,
        decisionVersion: 0,
        ...(team.environmentVersionId ? { environmentVersionId: team.environmentVersionId } : {}),
        resourceUsage: { ...EMPTY_USAGE, attempts: 0 },
        createdAt: at,
        startedAt: at,
        updatedAt: at,
      })
      const ledger = createDecisionLedger({ store, runId, leadId: team.leadId, now })
      for (const constraint of team.userConstraints ?? []) {
        await ledger.addUserConstraint(constraint)
      }
    } else if (existing.teamId !== team.id) {
      throw new Error(`Durable run ${runId} belongs to another team`)
    } else if (existing.status === "queued") {
      // A host may journal the run as `queued` before dispatch; admission is
      // what moves it to `running`.
      const started = await store.updateRunIfCurrent(runId, existing, {
        status: "running",
        startedAt: at,
        updatedAt: at,
      })
      if (!started) throw new Error(`Durable AgentTeam run ${runId} changed before preparation`)
    }
    await journal.runPrepared({
      runId,
      ...(team.projectId ? { projectId: team.projectId } : {}),
      // The objective, not a constant: on a run with no conversation this may
      // be the only thing the host's run list can say about it.
      title: team.objective || "Agent team run",
      at,
    })
    policies.set(runId, {
      teamId: team.id,
      writeMode: team.writeMode ?? "single-writer",
      repositories,
      resourcePolicy: team.resourcePolicy ?? {
        priority,
        maxConcurrentChildren: team.maxConcurrentTeammates ?? 1,
      },
    })
    return runId
  }

  const registerChild = async (
    input: RegisterDurableChildInput,
    via: TeamRunStore<TConstraints> = store
  ): Promise<AgentTeamChildRun> => {
    const run = await via.getRun(input.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${input.runId}`)
    const policy = policies.get(input.runId)
    if (policy && !policy.repositories.has(input.repositoryId)) {
      throw new Error(`Unknown repository for run ${input.runId}: ${input.repositoryId}`)
    }
    if (
      input.access === "write" &&
      policy?.repositories.get(input.repositoryId)?.writable === false
    ) {
      throw new Error(`Repository ${input.repositoryId} is read-only`)
    }
    const at = now()
    const child: AgentTeamChildRun = {
      id: input.childRunId,
      runId: input.runId,
      teamId: run.teamId,
      teammateId: input.teammateId,
      taskId: input.taskId,
      repositoryId: input.repositoryId,
      status: "running",
      attempt: 1,
      dispatchEpoch: 0,
      decisionVersion: run.decisionVersion,
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.executorRegistry ? { executorRegistry: input.executorRegistry } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.fileOwnership ? { fileOwnership: input.fileOwnership } : {}),
      resourceUsage: { ...EMPTY_USAGE },
      createdAt: at,
      updatedAt: at,
    }
    await via.createChild(child)
    await via.appendTrajectory({
      runId: input.runId,
      childRunId: child.id,
      kind: "child_created",
      correlationId: child.id,
      payload: { access: input.access, repositoryId: input.repositoryId },
      createdAt: at,
    })
    return child
  }

  const withWorkspaceLease = async <T>(
    request: WorkspaceLeaseRequest,
    operation: () => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> => {
    const execute = async () => {
      signal?.throwIfAborted()
      if (request.childRunId) {
        const { run } = await assertRunnable(request.childRunId, signal)
        if (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
          throw new Error(`Durable AgentTeam run ${run.id} is paused`)
        }
        await assertBudget(request.childRunId, run)
      }
      signal?.throwIfAborted()
      const result = await operation()
      signal?.throwIfAborted()
      return result
    }
    signal?.throwIfAborted()
    if (request.access === "read") return execute()
    const policy = policies.get(request.runId)
    const mode = policy?.writeMode ?? "single-writer"
    const repository = policy?.repositories.get(request.repositoryId)
    if (!repository) throw new Error(`Unknown repository: ${request.repositoryId}`)
    if (!repository.writable) throw new Error(`Repository ${request.repositoryId} is read-only`)
    const child = request.childRunId ? await store.getChild(request.childRunId) : undefined
    if (
      request.childRunId &&
      (!child || child.runId !== request.runId || child.repositoryId !== request.repositoryId)
    ) {
      throw new Error("Writer lease does not match its durable child")
    }
    const workspacePath = child?.workspacePath ?? repository.path
    const root = paths.normalize(
      paths.canonicalize ? await paths.canonicalize(workspacePath) : workspacePath
    )
    if (!root || !/^(?:\/|[A-Za-z]:\/)/.test(root)) {
      throw new Error("Writer workspace requires a canonical absolute root")
    }
    // Windows drive/UNC spellings compare case-insensitively, as ownership does.
    const key = /^(?:[A-Za-z]:\/|\/\/)/.test(root) ? root.toLowerCase() : root

    if (mode === "isolated-parallel") {
      if (!request.fileOwnership || request.fileOwnership.length === 0) {
        throw new Error("Isolated parallel writers require explicit file ownership")
      }
      const claimed = request.fileOwnership.map((claim) => {
        const path = claim.trim().replace(/\\/g, "/")
        if (!path || path.includes("\0")) throw new Error("Invalid writer ownership path")
        const absolute = /^(?:\/|[A-Za-z]:)/.test(path)
        const lexical = paths.normalize(absolute ? path : `${root}/${path}`)
        // Absolute ownership may use the checkout's alias spelling. Translate
        // it onto the same canonical root used by relative ownership claims.
        const workspaceRoot = paths.normalize(workspacePath)
        const normalized =
          absolute && paths.isWithinRoot(lexical, workspaceRoot)
            ? paths.normalize(`${root}/${lexical.slice(workspaceRoot.length).replace(/^\/+/, "")}`)
            : lexical
        if (!normalized || !paths.isWithinRoot(normalized, root)) {
          throw new Error("Writer ownership must remain within its repository")
        }
        return normalized
      })
      const active = activeOwnership.get(key) ?? []
      if (writerTails.has(key) || active.some((lease) => overlaps(paths, lease.paths, claimed))) {
        throw new Error("Parallel writer ownership overlaps an active lease")
      }
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const lease: ActiveOwnership = { leaseId: newId("writer"), paths: claimed, released }
      activeOwnership.set(key, [...active, lease])
      try {
        return await execute()
      } finally {
        const remaining = (activeOwnership.get(key) ?? []).filter(
          (candidate) => candidate.leaseId !== lease.leaseId
        )
        if (remaining.length === 0) activeOwnership.delete(key)
        else activeOwnership.set(key, remaining)
        release()
      }
    }

    const activeIsolated = activeOwnership.get(key)
    const previous =
      writerTails.get(key) ??
      (activeIsolated?.length
        ? Promise.all(activeIsolated.map((lease) => lease.released)).then(() => undefined)
        : undefined)
    let release!: () => void
    const own = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous ? previous.then(() => own) : own
    writerTails.set(key, tail)
    try {
      if (previous) await (signal ? waitWithSignal(previous, signal) : previous)
      return await execute()
    } finally {
      release()
      // A cancelled waiter still links later writers to the preceding lease.
      // Removing its tail before that lease settles would let a new writer in.
      void tail.then(() => {
        if (writerTails.get(key) === tail) writerTails.delete(key)
      })
    }
  }

  const withChildAdmission = async <T>(
    childRunId: string,
    operation: (admissionSignal: AbortSignal) => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T> => {
    if (admissions.has(childRunId))
      throw new Error(`Durable child ${childRunId} already has an admission`)
    const admission: { controller: AbortController; runId?: string } = {
      controller: new AbortController(),
    }
    admissions.set(childRunId, admission)
    const admissionSignal = signal
      ? AbortSignal.any([signal, admission.controller.signal])
      : admission.controller.signal
    try {
      let { child, run } = await assertRunnable(childRunId, admissionSignal)
      admission.runId = run.id
      while (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
        let resume!: () => void
        const resumed = new Promise<void>((resolve) => {
          resume = resolve
        })
        const waiters = runResumeWaiters.get(run.id) ?? new Set()
        waiters.add(resume)
        runResumeWaiters.set(run.id, waiters)
        try {
          await waitWithSignal(resumed, admissionSignal)
        } finally {
          waiters.delete(resume)
          if (waiters.size === 0) runResumeWaiters.delete(run.id)
        }
        ;({ child, run } = await assertRunnable(childRunId, admissionSignal))
      }
      await assertBudget(childRunId, run)
      const resource = policies.get(run.id)?.resourcePolicy ?? {
        priority: run.priority,
        maxConcurrentChildren: 1,
      }
      const queued = await store.updateChildIfCurrent(childRunId, child, {
        status: "queued",
        waitingReason: CHILD_ADMISSION_WAITING_REASON,
        updatedAt: now(),
      })
      if (!queued) throw new Error(`Durable child ${childRunId} changed before admission`)
      admissionSignal.throwIfAborted()
      scheduler.enqueue({
        id: childRunId,
        teamId: child.teamId,
        priority: resource.priority,
        enqueuedAt: now(),
        teamConcurrency: resource.maxConcurrentChildren,
      })
      await waitWithSignal(
        new Promise<void>((resolve) => {
          admissionWaiters.set(childRunId, resolve)
          pumpAdmissions()
        }),
        admissionSignal
      )
      ;({ child, run } = await assertRunnable(childRunId, admissionSignal))
      if (pausedRuns.has(run.id) || ["pausing", "paused", "sleeping"].includes(run.status)) {
        throw new Error(`Durable AgentTeam run ${run.id} is paused`)
      }
      await assertBudget(childRunId, run)
      const eligibility = await assessStoredTaskRecovery(
        store,
        run.id,
        child.taskId,
        now(),
        childRunId
      )
      if (!eligibility.eligible) {
        await store.updateRun(run.id, {
          status: "needs_input",
          recoveryReason: eligibility.reason,
          updatedAt: now(),
        })
        await store.updateChildIfCurrent(child.id, child, {
          status: "needs_input",
          waitingReason: eligibility.reason,
          updatedAt: now(),
        })
        throw new Error(eligibility.reason)
      }
      const started = await store.updateChildIfCurrent(childRunId, child, {
        status: "running",
        waitingReason: undefined,
        updatedAt: now(),
      })
      if (!started) throw new Error(`Durable child ${childRunId} changed during admission`)
      await assertRunnable(childRunId, admissionSignal)
      const result = await operation(admissionSignal)
      admissionSignal.throwIfAborted()
      return result
    } finally {
      admissions.delete(childRunId)
      admissionWaiters.delete(childRunId)
      scheduler.cancel(childRunId)
      scheduler.release(childRunId)
      pumpAdmissions()
    }
  }

  const attachLiveControl = (childRunId: string, control: DurableChildControl): (() => void) => {
    controls.set(childRunId, control)
    return () => {
      if (controls.get(childRunId) === control) controls.delete(childRunId)
    }
  }

  const steer = async (childRunId: string, message: string): Promise<AgentTeamSteeringReceipt> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const at = now()
    const persistedMessage = persistable(
      message,
      "AgentTeam steering still contains PII after redaction"
    )
    const receipt: AgentTeamSteeringReceipt = {
      id: newId("team-steer"),
      runId: child.runId,
      childRunId,
      message: persistedMessage,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    }
    await store.createSteeringReceipt(receipt)
    await store.appendTrajectory({
      runId: child.runId,
      childRunId,
      kind: "steering_queued",
      correlationId: receipt.id,
      createdAt: at,
    })
    const control = controls.get(childRunId)
    if (!control) return receipt
    try {
      await control.steer(persistedMessage, receipt.id)
      const deliveredAt = now()
      await store.updateSteeringReceipt(receipt.id, "delivered", deliveredAt)
      await store.appendTrajectory({
        runId: child.runId,
        childRunId,
        kind: "steering_delivered",
        correlationId: receipt.id,
        createdAt: deliveredAt,
      })
      return { ...receipt, status: "delivered", deliveredAt, updatedAt: deliveredAt }
    } catch {
      // The durable queued receipt is the deliberate fallback. A subsequent
      // provider turn consumes it at its next safe boundary.
      return receipt
    }
  }

  const checkpoint = async (
    childRunId: string,
    input: {
      trajectorySequence: number
      replay: AgentTeamCheckpoint["replay"]
      sideEffects: AgentTeamSideEffect[]
      workspaceCommit?: string
      expectedDispatchEpoch?: number
      expectedDispatchAttempt?: number
    }
  ): Promise<AgentTeamCheckpoint> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const run = await store.getRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)
    return store.markCheckpoint({
      runId: child.runId,
      childRunId,
      expectedDispatchEpoch: input.expectedDispatchEpoch,
      expectedDispatchAttempt: input.expectedDispatchAttempt,
      trajectorySequence: input.trajectorySequence,
      decisionVersion: child.decisionVersion ?? run.decisionVersion,
      replay: input.replay,
      sideEffects: input.sideEffects,
      ...(input.workspaceCommit ? { workspaceCommit: input.workspaceCommit } : {}),
      createdAt: now(),
    })
  }

  const requireRecoveryAdmission = async (child: AgentTeamChildRun): Promise<void> => {
    const eligibility = await assessStoredTaskRecovery(store, child.runId, child.taskId, now())
    if (eligibility.eligible) return
    await store.atomically(async (tx) => {
      const current = await tx.getChild(child.id)
      if (current)
        await tx.updateChildIfCurrent(child.id, child, {
          status: child.status === "completed" ? "completed" : "needs_input",
          waitingReason: eligibility.reason,
          updatedAt: now(),
        })
      const run = await tx.getRun(child.runId)
      if (run && !isTerminalTeamStatus(run.status))
        await tx.updateRunIfCurrent(run.id, run, {
          status: "needs_input",
          recoveryReason: eligibility.reason,
          updatedAt: now(),
        })
    })
    throw new Error(`${eligibility.reason}: recovery requires stop proof and a safe checkpoint`)
  }

  const recover = async (): Promise<RecoveryOutcome[]> => {
    const outcomes: RecoveryOutcome[] = []
    for (const run of await store.listRecoveryCandidates()) {
      const children = await store.listChildren(run.id)
      if (run.stop?.state === "requested" || run.stop?.state === "unconfirmed") {
        const at = now()
        for (const child of children) {
          const proof = childStopProof(child, at)
          if (!isChildSettled(child) && proof) {
            await store.updateChildIfCurrent(child.id, child, {
              status: "terminated",
              stop: {
                state: "confirmed",
                epoch: child.dispatchEpoch ?? 0,
                requestedAt: child.stop?.requestedAt ?? run.stop.requestedAt,
                proof,
              },
              completedAt: at,
              updatedAt: at,
            })
          } else if ((await isStoredChildStopped(store, child, at)) && !isChildSettled(child)) {
            const epoch = child.dispatchEpoch ?? 0
            await store.updateChildIfCurrent(child.id, child, {
              status: "terminated",
              settledEpoch: epoch,
              stop: {
                state: "confirmed",
                epoch,
                requestedAt: run.stop.requestedAt,
                proof: { kind: "ack", epoch, at },
              },
              completedAt: at,
              updatedAt: at,
            })
          }
        }
        const confirmed = (await store.listChildren(run.id)).every(
          (child) =>
            isChildSettled(child) || !!childStopProof(child, at) || isChildNeverStarted(child)
        )
        const status = confirmed
          ? run.stop.action === "terminate"
            ? "terminated"
            : "cancelled"
          : "needs_input"
        if (
          await store.updateRunIfCurrent(run.id, run, {
            status,
            completedAt: confirmed ? at : undefined,
            recoveryReason: confirmed ? undefined : "stop_unconfirmed",
            stop: { ...run.stop, state: confirmed ? "confirmed" : "unconfirmed", proof: undefined },
            updatedAt: at,
          })
        ) {
          outcomes.push({ runId: run.id, status })
        }
        continue
      }
      const assessments = await Promise.all(
        [...new Set(children.map((child) => child.taskId))].map((taskId) =>
          assessStoredTaskRecovery(store, run.id, taskId, now())
        )
      )
      const refusal =
        assessments.find((result) => !result.eligible && result.reason === "stop_unconfirmed") ??
        assessments.find((result) => !result.eligible)
      const status = refusal ? "needs_input" : "recovering"
      const at = now()
      if (
        !(await store.updateRunIfCurrent(run.id, run, {
          status,
          recoveryReason: refusal && !refusal.eligible ? refusal.reason : "checkpoint_replay",
          updatedAt: at,
        }))
      )
        continue
      for (const child of children.filter(
        (child) =>
          !isChildSettled(child) && !(child.status === "queued" && isChildNeverStarted(child))
      )) {
        await store.updateChildIfCurrent(child.id, child, {
          status: child.status === "completed" ? "completed" : status,
          ...(refusal && !refusal.eligible && refusal.childRunIds.includes(child.id)
            ? { waitingReason: refusal.reason }
            : {}),
          updatedAt: at,
        })
      }
      outcomes.push({ runId: run.id, status })
    }
    return outcomes
  }

  const retryChild = async (
    childRunId: string,
    requestedHostRef?: string
  ): Promise<AgentTeamChildRun> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (["completed", "cancelled", "terminated"].includes(child.status)) {
      throw new Error(`Durable child ${childRunId} cannot be retried from ${child.status}`)
    }
    const run = await store.getRun(child.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${child.runId}`)

    if (isTerminalTeamStatus(run.status)) {
      throw new Error(`Durable AgentTeam run ${run.id} cannot be retried from ${run.status}`)
    }

    await requireRecoveryAdmission(child)
    const retryHostRef = requestedHostRef
    const at = now()
    let retryRefusal: string | undefined
    await store.atomically(async (tx) => {
      const currentRun = await tx.getRun(run.id)
      if (!currentRun || JSON.stringify(currentRun.stop) !== JSON.stringify(run.stop))
        throw new Error("Run stop changed before retry")
      const children = await tx.listChildren(run.id)
      const assessments = await Promise.all(
        [...new Set(children.map((child) => child.taskId))].map((taskId) =>
          assessTaskRecovery(run.id, taskId, tx)
        )
      )
      const allEligible = assessments.every((result) => result.eligible)
      if (run.stop && !allEligible) {
        await tx.updateRunIfCurrent(run.id, run, {
          status: "needs_input",
          recoveryReason: "stop_unconfirmed",
          stop: { ...run.stop, state: "unconfirmed" },
          updatedAt: at,
        })
        retryRefusal = "stop_unconfirmed: run stop barrier still has unconfirmed children"
        return
      }
      const eligibility = await assessTaskRecovery(child.runId, child.taskId, tx)
      if (!eligibility.eligible) throw new Error(eligibility.reason)
      if (
        !(await tx.updateChildIfCurrent(childRunId, child, {
          status: "queued",
          error: undefined,
          dispatchLeaseId: undefined,
          dispatchLeaseExpiresAt: undefined,
          waitingReason: retryHostRef ? `retry_host:${retryHostRef}` : undefined,
          updatedAt: at,
        }))
      )
        throw new Error(`Durable child ${childRunId} changed before retry`)
      if (
        !(await tx.updateRunIfCurrent(run.id, run, {
          status: "recovering",
          recoveryReason: retryHostRef ? "operator_retry_host" : "operator_retry_auto",
          ...(allEligible ? { stop: undefined } : {}),
          updatedAt: at,
        }))
      )
        throw new Error(`Durable AgentTeam run ${run.id} changed before retry`)
    })
    if (retryRefusal) throw new Error(retryRefusal)
    const updated = await store.getChild(childRunId)
    if (!updated) throw new Error(`Durable child disappeared during retry: ${childRunId}`)
    return updated
  }

  const setChildControlState = async (
    childRunId: string,
    action: "pause" | "resume" | "terminate"
  ): Promise<void> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const control = controls.get(childRunId)
    if (
      isChildSettled(child) ||
      (["cancelled", "terminated"].includes(child.status) && childStopProof(child, now()))
    )
      return
    if (action === "resume") {
      const run = await store.getRun(child.runId)
      if (
        !run ||
        isTerminalTeamStatus(run.status) ||
        run.stop?.state === "requested" ||
        run.stop?.state === "unconfirmed"
      )
        throw new Error(`Durable child ${childRunId} cannot resume after its run stopped`)
      await requireRecoveryAdmission(child)
      if (child.status === "queued") return
      // A live resume itself can execute. Reserve its new epoch before calling
      // the provider so a concurrent dispatch cannot consume the same proof.
      const prepareResume = !hasRemoteDispatch(child) && !!control?.resume
      const liveResume = prepareResume && control?.resumeStartsExecution !== false
      const epoch = (child.dispatchEpoch ?? 0) + 1
      const resumed = await store.atomically(async (tx) => {
        const eligibility = await assessTaskRecovery(child.runId, child.taskId, tx)
        if (!eligibility.eligible) return false
        return tx.updateChildIfCurrent(childRunId, child, {
          status: liveResume ? "running" : "queued",
          ...(liveResume
            ? {
                dispatchEpoch: epoch,
                stop: undefined,
                fenceCapable: false,
                fenceGraceMs: undefined,
                leaseTtlMs: undefined,
                lastRenewalSentAt: undefined,
                dispatchLeaseId: undefined,
                dispatchLeaseExpiresAt: undefined,
              }
            : {}),
          remoteSessionId: undefined,
          sessionId: undefined,
          updatedAt: now(),
        })
      })
      if (!resumed) {
        await requireRecoveryAdmission(child)
        throw new Error("Child changed before resume")
      }
      if (prepareResume) {
        try {
          await control!.resume!(liveResume ? epoch : undefined)
        } catch (error) {
          const current = await store.getChild(childRunId)
          if (current && current.dispatchEpoch === epoch)
            await store.updateChildIfCurrent(childRunId, current, {
              status: "needs_input",
              stop: { state: "unconfirmed", epoch, requestedAt: now() },
              waitingReason: "stop_unconfirmed",
              updatedAt: now(),
            })
          await store.updateRun(child.runId, {
            status: "needs_input",
            recoveryReason: "stop_unconfirmed",
            updatedAt: now(),
          })
          throw error
        }
      }
      return
    }
    admissions.get(childRunId)?.controller.abort(new DOMException(`Child ${action}`, "AbortError"))
    const epoch = child.dispatchEpoch ?? 0
    const requestedAt = now()
    if (action === "terminate") {
      // Serialize with executor start. A stale never-started snapshot must
      // never certify an execution that won the start transaction first.
      const requested = await store.atomically(async (tx) => {
        const current = await tx.getChild(childRunId)
        if (!current) throw new Error(`Unknown durable child: ${childRunId}`)
        if (
          isChildSettled(current) ||
          (["cancelled", "terminated"].includes(current.status) && childStopProof(current, now()))
        )
          return undefined
        if (
          !(await tx.updateChildIfCurrent(childRunId, current, {
            stop: { state: "requested", epoch: current.dispatchEpoch ?? 0, requestedAt },
            updatedAt: requestedAt,
          }))
        )
          throw new Error("Child changed before stop")
        return current
      })
      if (!requested) return
      const child = requested
      const epoch = child.dispatchEpoch ?? 0
      let proof = childStopProof(child, now())
      let failure: unknown
      if (!proof && (await isStoredChildStopped(store, child, now())))
        proof = { kind: "ack", epoch, at: now() }
      try {
        // Even an already-paused executor may still own environment resources.
        const ack = await control?.terminate?.()
        if (hasRemoteDispatch(child) && ack?.epoch === epoch && ack.kind === "ack") proof = ack
        if (!proof && !hasRemoteDispatch(child) && (await waitForLocalSettlement(childRunId)))
          proof = { kind: "ack", epoch, at: now() }
      } catch (error) {
        failure = error
      }
      const current = await store.getChild(childRunId)
      if (!current || (current.dispatchEpoch ?? 0) !== epoch)
        throw new Error("Child epoch changed during stop")
      if (isChildSettled(current)) return
      proof ??= childStopProof(current, now())
      await store.updateChildIfCurrent(
        childRunId,
        current,
        proof
          ? {
              status: "terminated",
              stop: { state: "confirmed", epoch, requestedAt, proof },
              completedAt: now(),
              updatedAt: now(),
            }
          : {
              status: "needs_input",
              stop: { state: "unconfirmed", epoch, requestedAt },
              waitingReason: "stop_unconfirmed",
              updatedAt: now(),
            }
      )
      if (!proof) {
        await store.updateRun(child.runId, {
          status: "needs_input",
          recoveryReason: "stop_unconfirmed",
          updatedAt: now(),
        })
        throw failure ?? new Error("stop_unconfirmed")
      }
      if (child.remoteSessionId) await remoteSessions.release(child.remoteSessionId)
      return
    }
    if (
      !(await store.updateChildIfCurrent(childRunId, child, {
        status: "pausing",
        updatedAt: requestedAt,
      }))
    )
      throw new Error("Child changed before pause")
    let safe = false
    try {
      safe = !!control?.pause && (await control.pause()) !== false
      // A local interrupt only writes IPC. Its executor must actually exit
      // before a pause can be confirmed, just like a local termination.
      if (safe && !hasRemoteDispatch(child) && !isChildNeverStarted(child)) {
        const settled = await waitForLocalSettlement(childRunId)
        const latest = await store.getChild(childRunId)
        safe = settled || (!!latest && (await isStoredChildStopped(store, latest, now())))
      }
    } catch {
      /* Persist uncertainty below. */
    }
    const current = await store.getChild(childRunId)
    if (!current || isChildSettled(current) || current.status !== "pausing") return
    await store.updateChildIfCurrent(childRunId, current, {
      status: safe ? "paused" : "needs_input",
      waitingReason: safe ? undefined : "pause_unconfirmed",
      updatedAt: now(),
    })
    if (!safe) {
      await store.appendTrajectory({
        runId: child.runId,
        childRunId,
        kind: "run_controlled",
        correlationId: `pause-unconfirmed:${childRunId}:${epoch}:${requestedAt}`,
        payload: { action: "pause_unconfirmed", dispatchEpoch: epoch },
        createdAt: now(),
      })
      await store.updateRun(child.runId, {
        status: "needs_input",
        recoveryReason: "stop_unconfirmed",
        updatedAt: now(),
      })
    }
  }

  const sleepChild = async (childRunId: string): Promise<void> => {
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (isTerminalTeamStatus(child.status)) return
    await store.updateChildIfCurrent(childRunId, child, { status: "sleeping", updatedAt: now() })
  }

  const wakeChild = (childRunId: string): Promise<void> => {
    const pending = pendingWakes.get(childRunId)
    if (pending) return pending
    const waking = (async () => {
      const child = await store.getChild(childRunId)
      if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
      if (child.status !== "sleeping") return
      // Reuse resume's remote checkpoint gate and durable control transition.
      await setChildControlState(childRunId, "resume")
    })().finally(() => {
      pendingWakes.delete(childRunId)
    })
    pendingWakes.set(childRunId, waking)
    return waking
  }

  const beginTakeover = async (childRunId: string): Promise<AgentTeamChildRun> => {
    await setChildControlState(childRunId, "pause")
    const child = await store.getChild(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    if (child.waitingReason === "pause_unconfirmed")
      throw new Error("stop_unconfirmed: pause_unconfirmed")
    await requireRecoveryAdmission(child)
    await store.appendTrajectory({
      runId: child.runId,
      childRunId,
      kind: "manual_takeover_started",
      correlationId: `takeover:${childRunId}`,
      payload: { workspacePath: child.workspacePath, branch: child.branch },
      createdAt: now(),
    })
    return child
  }

  const completeTakeover = async (input: {
    childRunId: string
    commands?: string[]
    diffContent?: string
    workspaceCommit?: string
  }): Promise<void> => {
    const child = await store.getChild(input.childRunId)
    if (!child) throw new Error(`Unknown durable child: ${input.childRunId}`)
    await requireRecoveryAdmission(child)
    const bundle = createEvidenceBundle({
      store,
      runId: child.runId,
      childRunId: child.id,
      taskId: child.taskId,
      now,
    })
    for (const command of input.commands ?? []) {
      const content = persistable(command, "Manual takeover command failed PII redaction")
      await bundle.record({ kind: "command", title: "Manual command", content })
    }
    if (input.diffContent) {
      const content = persistable(input.diffContent, "Manual takeover diff failed PII redaction")
      await bundle.record({
        kind: "diff",
        title: "Manual workspace changes",
        content,
      })
    }
    if (input.workspaceCommit) {
      await bundle.record({
        kind: "commit",
        title: input.workspaceCommit,
        metadata: { sha: input.workspaceCommit, source: "manual_takeover" },
      })
    }
    const event = await store.appendTrajectory({
      runId: child.runId,
      childRunId: child.id,
      kind: "manual_takeover_completed",
      correlationId: `takeover:${child.id}`,
      payload: { commandCount: input.commands?.length ?? 0 },
      createdAt: now(),
    })
    await checkpoint(child.id, {
      trajectorySequence: event.sequence,
      replay: "safe",
      sideEffects: [],
      ...(input.workspaceCommit ? { workspaceCommit: input.workspaceCommit } : {}),
    })
    await setChildControlState(child.id, "resume")
  }

  return {
    /** The store this coordinator reads and writes run state through. */
    store,
    prepareRun,
    registerChild,
    withChildAdmission,
    trackChildExecution,
    assessTaskRecovery,
    withWorkspaceLease,
    attachLiveControl,
    steer,
    checkpoint,
    recover,
    retryChild,
    pauseChild: (childRunId: string) => setChildControlState(childRunId, "pause"),
    resumeChild: (childRunId: string) => setChildControlState(childRunId, "resume"),
    sleepChild,
    wakeChild,
    terminateChild: (childRunId: string) => setChildControlState(childRunId, "terminate"),
    beginTakeover,
    completeTakeover,
    setRunPaused(runId: string, paused: boolean) {
      if (paused) {
        pausedRuns.add(runId)
        for (const admission of admissions.values()) {
          if (admission.runId === runId) {
            admission.controller.abort(new DOMException("Run paused", "AbortError"))
          }
        }
        return
      }
      pausedRuns.delete(runId)
      for (const resolve of runResumeWaiters.get(runId) ?? []) resolve()
      runResumeWaiters.delete(runId)
    },
    schedulerSnapshot: scheduler.snapshot,
  }
}

export type DurableTeamCoordinator<TConstraints = unknown> = ReturnType<
  typeof createDurableTeamCoordinator<TConstraints>
>
