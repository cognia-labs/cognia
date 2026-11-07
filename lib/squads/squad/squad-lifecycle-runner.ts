/**
 * Run one Squad lifecycle against the live store, from prepared records to
 * settlement.
 *
 * This is the body `agentTeamManager.start/resume` used to carry inline. It
 * moved here so `startSquadRun` (ADR-0140's one launch seam) and the resume
 * path of `squad-control.ts` execute the SAME code: assemble the runtime deps,
 * run `runTeamLifecycle`, then settle the durable run, the execution row, the
 * GitHub delivery graph and the scheduler event. Two copies of that tail were
 * how a legacy run's execution row once stayed `running` for good.
 *
 * Nothing in here decides whether a run MAY start. Readiness, the duplicate
 * live-run rule and the transactional record creation belong to
 * `start-squad-run.ts`. This module assumes both rows exist.
 */

import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { stackedDeliveryOn } from "@/lib/stack/team-policy"
import { parkActiveSquadRun } from "./squad-run-records"
import type {
  AgentTeam,
  AgentTeammate,
  SendMessageInput,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import type { AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import { AGENT_TEAM_SECURITY_CONFIG_KEYS } from "@/types/agent/agent-team-runtime"
import type { AgentTeamExecutionConstraints } from "@/types/agent/agent-team-runtime"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import {
  runTeamLifecycle,
  type RunTeamLifecycleDeps,
  type RunTeamLifecycleResult,
} from "../agent-team-runtime"
import type { TeamRunOrigin } from "../gates/gate-policy"
import { isTerminalRunStatus } from "@/types/execution/run"
import {
  isParkedTeamStatus,
  isTerminalTeamStatus,
  teamRunOutcome,
} from "@cognia/agent-orchestration/rules"

/**
 * Pluggable runtime dependencies. Normally set at bootstrap via
 * `configureAgentTeamRuntime`. When that never ran (headless, CLI, scheduler,
 * tests), the runner lazily builds the side-effect-free defaults instead of
 * dying. An explicit configuration still wins.
 */
export type ConfiguredSquadRuntimeDeps = Pick<
  RunTeamLifecycleDeps,
  | "runLeadPlanning"
  | "runLeadReview"
  | "notifierDeps"
  | "resolveTeamRepo"
  | "resolvePrObserveOctokit"
  | "runPrReview"
>

let configuredDeps: ConfiguredSquadRuntimeDeps | null = null

export function configureAgentTeamRuntime(deps: ConfiguredSquadRuntimeDeps): void {
  configuredDeps = deps
}

export function __resetAgentTeamRuntimeForTesting(): void {
  configuredDeps = null
}

async function ensureConfiguredSquadRuntimeDeps(): Promise<ConfiguredSquadRuntimeDeps> {
  if (configuredDeps) return configuredDeps
  const { buildAgentTeamRuntimeDeps } = await import("../agent-team-runtime-deps")
  configuredDeps = buildAgentTeamRuntimeDeps()
  console.warn(
    "[agent-team] runtime auto-configured with defaults: " +
      "configureAgentTeamRuntime() was never called (bootstrap not mounted?)."
  )
  return configuredDeps
}

function bindSquadStoreReader(
  constraints?: AgentTeamExecutionConstraints
): RunTeamLifecycleDeps["storeReader"] {
  return {
    getTeam: (id) => {
      const team = useAgentTeamStore.getState().getTeam(id)
      if (!team || !constraints?.teamConfig) return team
      return {
        ...team,
        config: {
          ...team.config,
          ...Object.fromEntries(AGENT_TEAM_SECURITY_CONFIG_KEYS.map((key) => [key, undefined])),
          ...constraints.teamConfig,
        },
      }
    },
    getTeammates: (teamId) => useAgentTeamStore.getState().getTeammates(teamId),
    getTeamTasks: (teamId) => useAgentTeamStore.getState().getTeamTasks(teamId),
  }
}

function bindSquadStoreWriter(): RunTeamLifecycleDeps["storeWriter"] {
  return {
    addMessage: (input: SendMessageInput) => useAgentTeamStore.getState().addMessage(input),
    setTaskStatus: (taskId: string, status: TeamTaskStatus, result?: string, error?: string) =>
      useAgentTeamStore.getState().setTaskStatus(taskId, status, result, error),
    updateTeammate: (teammateId: string, updates: Partial<AgentTeammate>) =>
      useAgentTeamStore.getState().updateTeammate(teammateId, updates),
    setFinalResult: (teamId: string, result: string) =>
      useAgentTeamStore.getState().updateTeam(teamId, { finalResult: result }),
    addTask: (input) => useAgentTeamStore.getState().createTask(input),
    updateTask: (taskId, updates) => useAgentTeamStore.getState().updateTask(taskId, updates),
    addEvent: (event) => useAgentTeamStore.getState().addEvent(event),
    addTeammate: (input) => useAgentTeamStore.getState().addTeammate(input),
  }
}

/**
 * Task statuses a resume does NOT re-dispatch: finished and dropped work stays
 * so, and `review` awaits a human verdict on the board.
 */
const RESUME_SKIP_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
  "completed",
  "cancelled",
  "review",
])

export const resumeTaskFilter: NonNullable<RunTeamLifecycleDeps["taskFilter"]> = (task) =>
  !RESUME_SKIP_STATUSES.has(task.status)

/**
 * Put a team's board back into a resumable shape after its lifecycle exited.
 *
 * Tasks the exited run left mid-flight belong to no live run any more, so they
 * go back to `pending` with their run-owned fields cleared. Teammates stuck in
 * run-owned statuses are reset. The blackboard is re-seeded from persisted
 * results (shared memory is in-memory only, so a restart empties it, and the
 * surviving tasks would otherwise read empty upstream results).
 *
 * Returns how many tasks are still runnable, so the caller can settle a team
 * with nothing left instead of entering a lifecycle that fails on it.
 */
const SQUAD_NOT_READY_REASON = "squad_not_ready"

export interface GuardSquadResumeDeps {
  evaluate?: (
    team: AgentTeam,
    teammates: readonly AgentTeammate[]
  ) => Promise<{ ready: boolean; blockers: Array<{ code: string }> }>
  park?: (runId: string, teamId: string) => Promise<void>
  now?: () => number
}

/**
 * The readiness gate every RE-ENTRY passes (ADR-0169). `startSquadRun` refuses
 * a blocked Squad before it writes anything. A resume or a restart-time
 * recovery arrives with the run record already written, so a blocked Squad
 * is PARKED instead: `needs_input` with the `squad_not_ready` reason, a
 * `run.recovery_required` event, and a `team_recovery` review whose only
 * choices are restart or terminate. Nothing dispatches on a Squad that could
 * not have started.
 */
export async function guardSquadResume(
  teamId: string,
  runId: string,
  deps: GuardSquadResumeDeps = {}
): Promise<{ blocked: boolean; blockers: Array<{ code: string }> }> {
  const store = useAgentTeamStore.getState()
  const team = store.teams[teamId]
  if (!team) return { blocked: false, blockers: [] }
  const teammates = Object.values(store.teammates).filter((m) => m.teamId === teamId)
  const evaluate =
    deps.evaluate ??
    (async (t: AgentTeam, ms: readonly AgentTeammate[]) => {
      const { evaluateSquadReadiness } = await import("@/lib/squads/squad-readiness")
      return evaluateSquadReadiness({ team: t, teammates: ms })
    })
  const readiness = await evaluate(team, teammates)
  if (readiness.ready) return { blocked: false, blockers: [] }
  await (deps.park ?? parkSquadRecovery)(runId, teamId)
  return { blocked: true, blockers: readiness.blockers }
}

export async function parkSquadRecovery(
  runId: string,
  teamId: string,
  reason = SQUAD_NOT_READY_REASON
): Promise<void> {
  const at = Date.now()
  const [{ agentTeamExecutionRunId }, { runEventJournal, semanticRunEvent, getExecutionRun }] =
    await Promise.all([
      import("@/lib/execution/agent-team-bridge"),
      import("@/lib/db/execution-runs"),
    ])
  if (!(await parkActiveSquadRun(runId, reason, at))) return
  const executionRunId = agentTeamExecutionRunId(runId)
  const executionRun = await getExecutionRun(executionRunId).catch(() => undefined)
  if (executionRun && !isTerminalRunStatus(executionRun.status)) {
    await runEventJournal
      .append(
        executionRunId,
        semanticRunEvent(
          "run.recovery_required",
          { reason },
          { ts: at, sourceEventId: `agent-team:${runId}:recovery_required:${at}` }
        )
      )
      .catch(() => undefined)
  }
  useAgentTeamStore.getState().setTeamStatus(teamId, "paused")
  const { ensureTeamRecoveryInterrupt } = await import("../durable/team-recovery")
  await ensureTeamRecoveryInterrupt(runId).catch(() => undefined)
}

export async function prepareSquadResume(teamId: string): Promise<{ remaining: number }> {
  const store = useAgentTeamStore.getState()
  const teamTasks = Object.values(store.tasks).filter((t) => t.teamId === teamId)
  for (const t of teamTasks) {
    if (t.status === "claimed" || t.status === "in_progress") {
      store.updateTask(t.id, {
        status: "pending",
        claimedBy: undefined,
        startedAt: undefined,
        completedAt: undefined,
        actualDuration: undefined,
      })
    }
  }
  for (const m of Object.values(store.teammates).filter((m) => m.teamId === teamId)) {
    if (
      m.status === "executing" ||
      m.status === "planning" ||
      m.status === "paused" ||
      m.status === "awaiting_approval"
    ) {
      store.updateTeammate(m.id, { status: "idle", currentTaskId: undefined })
    }
  }
  const { autoPublishTaskResult } = await import("../memory/shared-memory-orchestrator")
  for (const t of teamTasks) {
    if (t.status === "completed" && typeof t.result === "string" && t.result.length > 0) {
      const writer = t.claimedBy ? useAgentTeamStore.getState().teammates[t.claimedBy] : undefined
      autoPublishTaskResult({ id: teamId }, t, t.result, writer ?? { id: "system", name: "System" })
    }
  }
  const remaining = Object.values(useAgentTeamStore.getState().tasks).filter(
    (t) => t.teamId === teamId && !RESUME_SKIP_STATUSES.has(t.status)
  ).length
  return { remaining }
}

export interface RunSquadLifecycleInput {
  /** Automatic restart recovery must still own admission after awaited setup. */
  recovery?: { signal?: AbortSignal }
  teamId: string
  /** The durable run id. Its records already exist. */
  runId: string
  origin?: TeamRunOrigin | string
  triggeredFrom?: WorkflowTriggeredFrom
  sessionId?: string
  ultracode?: boolean
  taskFilter?: RunTeamLifecycleDeps["taskFilter"]
  planApprovalDelegate?: RunTeamLifecycleDeps["planApprovalDelegate"]
  requirePlanApprovalFloor?: boolean
  permissionCeiling?: AgentPermissionCeiling
  sessionWorkingDir?: string
  /** Persona to enter the Squad as, resolved by the caller. */
  entryPersona?: { id: string; name: string; systemPrompt: string }
  traceId?: string
}

export interface RunSquadLifecycleDeps {
  /** Overrides the configured deps, for tests and for a caller-bound persona. */
  runtimeDeps?: ConfiguredSquadRuntimeDeps
  run?: typeof runTeamLifecycle
}

/** Re-entry must use the original authority, never today's permissive defaults. */
export async function restoreSquadRunInput(
  teamId: string,
  runId: string
): Promise<RunSquadLifecycleInput | undefined> {
  const { getAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
  const record = await getAgentTeamRun(runId)
  if (!record || record.teamId !== teamId) throw new Error("Unknown Squad run")
  if (record.executionConstraints?.version !== 1 || !record.executionConstraints.teamConfig) {
    await parkSquadRecovery(runId, teamId, "missing_execution_constraints")
    return undefined
  }
  return { teamId, runId, ...record.executionConstraints }
}

/**
 * Execute the lifecycle and settle everything it owns. Never throws on the
 * run's own failure: the result carries the status and the journal carries the
 * event. Throws only when the store has no such team.
 */
export async function runSquadLifecycle(
  input: RunSquadLifecycleInput,
  deps: RunSquadLifecycleDeps = {}
): Promise<RunTeamLifecycleResult> {
  input.recovery?.signal?.throwIfAborted()
  const { getAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
  input.recovery?.signal?.throwIfAborted()
  const persisted = await getAgentTeamRun(input.runId)
  input.recovery?.signal?.throwIfAborted()
  if (persisted && persisted.teamId !== input.teamId)
    throw new Error("Squad run belongs to another team")
  if (persisted && isTerminalTeamStatus(persisted.status)) {
    return { runId: input.runId, status: teamRunOutcome(persisted.status) }
  }
  if (
    persisted &&
    (persisted.executionConstraints?.version !== 1 || !persisted.executionConstraints.teamConfig)
  ) {
    await parkSquadRecovery(input.runId, input.teamId, "missing_execution_constraints")
    return { runId: input.runId, status: "failed", reason: "missing_execution_constraints" }
  }
  if (persisted?.executionConstraints) {
    const frozen = persisted.executionConstraints
    input = {
      ...input,
      origin: frozen.origin,
      triggeredFrom: frozen.triggeredFrom,
      permissionCeiling: frozen.permissionCeiling,
      requirePlanApprovalFloor: frozen.requirePlanApprovalFloor,
      sessionId: frozen.sessionId,
      sessionWorkingDir: frozen.sessionWorkingDir,
      entryPersona: frozen.entryPersona,
      ultracode: frozen.ultracode,
    }
  }
  const { teamId, runId } = input
  let runtimeDeps = deps.runtimeDeps
  if (!runtimeDeps) {
    if (input.entryPersona) {
      const { buildAgentTeamRuntimeDeps } = await import("../agent-team-runtime-deps")
      runtimeDeps = buildAgentTeamRuntimeDeps({ entryPersona: input.entryPersona })
    } else {
      runtimeDeps = await ensureConfiguredSquadRuntimeDeps()
    }
  }
  input.recovery?.signal?.throwIfAborted()
  const run = deps.run ?? runTeamLifecycle
  const { startSquadRunSpan } = await import("./squad-telemetry")
  const admitted = await getAgentTeamRun(runId)
  input.recovery?.signal?.throwIfAborted()
  if (admitted && isTerminalTeamStatus(admitted.status)) {
    return { runId, status: teamRunOutcome(admitted.status) }
  }
  if (persisted && !admitted) return { runId, status: "failed", reason: "run_not_found" }
  if (input.recovery && admitted?.status !== "recovering") {
    return { runId, status: "failed", reason: "recovery_superseded" }
  }

  if (admitted) {
    const [{ assessStoredRunRecovery }, { dexieTeamRunStore }] = await Promise.all([
      import("@cognia/agent-orchestration/coordinator"),
      import("@/lib/db/agent-team-runtime"),
    ])
    const eligibility = await assessStoredRunRecovery(dexieTeamRunStore, runId, Date.now())
    if (!eligibility.safe) {
      await parkSquadRecovery(runId, teamId, eligibility.reason ?? "stop_unconfirmed")
      return { runId, status: "failed", reason: eligibility.reason ?? "stop_unconfirmed" }
    }
  }

  // The store's `status` is a mirror of the durable run, written here and only
  // here (ADR-0169): surfaces read the run record, and the mirror exists so
  // synchronous callers (board guards, presence) do not each open a query.
  useAgentTeamStore.getState().setTeamStatus(teamId, "executing")

  // The root span. Teammate dispatch spans join it through `traceId`, reviews
  // and recovery hang off it, and the terminal reason closes it.
  const team = useAgentTeamStore.getState().teams[teamId]
  const configuredRuntimeDeps = runtimeDeps
  const rootSpan = startSquadRunSpan({
    runId,
    teamId,
    ...(team?.projectId ? { projectId: team.projectId } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  })

  const result = await run(
    teamId,
    {
      runId,
      // Publication belongs inside the real lifecycle's finally, before either
      // terminal record is written. A hold is persisted before it can settle.
      beforeCompletion: () =>
        publishSquadDelivery(teamId, runId, configuredRuntimeDeps, persisted?.executionConstraints),
      storeReader: bindSquadStoreReader(persisted?.executionConstraints),
      storeWriter: bindSquadStoreWriter(),
      runLeadPlanning: runtimeDeps.runLeadPlanning,
      ...(runtimeDeps.runLeadReview ? { runLeadReview: runtimeDeps.runLeadReview } : {}),
      notifierDeps: runtimeDeps.notifierDeps,
      ...(runtimeDeps.resolveTeamRepo ? { resolveTeamRepo: runtimeDeps.resolveTeamRepo } : {}),
      ...(runtimeDeps.resolvePrObserveOctokit
        ? { resolvePrObserveOctokit: runtimeDeps.resolvePrObserveOctokit }
        : {}),
      ...(runtimeDeps.runPrReview ? { runPrReview: runtimeDeps.runPrReview } : {}),
      ...(input.origin ? { origin: input.origin as TeamRunOrigin } : {}),
      ...(input.triggeredFrom ? { triggeredFrom: input.triggeredFrom } : {}),
      ...(input.taskFilter ? { taskFilter: input.taskFilter } : {}),
      ...(input.planApprovalDelegate ? { planApprovalDelegate: input.planApprovalDelegate } : {}),
      ...(input.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
      ...(input.permissionCeiling ? { parentPermissionCeiling: input.permissionCeiling } : {}),
      ...(input.sessionWorkingDir ? { sessionWorkingDir: input.sessionWorkingDir } : {}),
      traceId: input.traceId ?? rootSpan.traceId,
      // Manual "Run with ultracode" forces orchestration, an explicit normal run
      // turns it off, omitted lets the team's autoMode decide.
      ...(input.ultracode === true
        ? { ultracodeOverride: "force" as const }
        : input.ultracode === false
          ? { ultracodeOverride: "off" as const }
          : {}),
    },
    ...(input.recovery?.signal ? ([input.recovery.signal] as const) : ([] as const))
  )

  if (input.recovery?.signal?.aborted) return result
  await settleSquadRun(teamId, runId, result)
  return result
}

/** Close the root span with the terminal status, the reason code and the token totals. */
async function closeSquadRunSpan(
  runId: string,
  durableRun: { status: AgentTeamRunStatus; recoveryReason?: string } | undefined,
  result: RunTeamLifecycleResult
): Promise<void> {
  const [{ endSquadRunSpan, squadDuplicateControlCount }, { aggregateAgentTeamRunUsage }] =
    await Promise.all([import("./squad-telemetry"), import("@/lib/db/agent-team-runtime")])
  const parked = durableRun !== undefined && isParkedTeamStatus(durableRun.status)
  // Suites stub the db module without the aggregate. No totals is a span
  // without usage, not a failed settle.
  const totals =
    typeof aggregateAgentTeamRunUsage === "function"
      ? ((await aggregateAgentTeamRunUsage(runId).catch(() => undefined)) as
          Record<string, unknown> | undefined)
      : undefined
  const num = (key: string) => (typeof totals?.[key] === "number" ? (totals[key] as number) : 0)
  endSquadRunSpan({
    runId,
    terminalStatus: parked ? durableRun!.status : result.status,
    ...(durableRun?.recoveryReason
      ? { terminalReason: durableRun.recoveryReason }
      : result.reason
        ? { terminalReason: result.reason }
        : {}),
    ...(totals
      ? {
          usage: {
            inputTokens: num("promptTokens"),
            outputTokens: num("completionTokens"),
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        }
      : {}),
    duplicateControls: squadDuplicateControlCount(runId),
  })
}

/**
 * Publish while the real lifecycle still owns a live execution. A policy hold
 * is durable before that lifecycle chooses its terminal or waiting event.
 */
/**
 * A pause, a stop or a failure already decided this run's fate, so a late
 * delivery result must not replace it. A completed run is the one terminal
 * status delivery still acts on.
 */
function controlDecisionStands(status: AgentTeamRunStatus): boolean {
  return isParkedTeamStatus(status) || (isTerminalTeamStatus(status) && status !== "completed")
}

async function publishSquadDelivery(
  teamId: string,
  runId: string,
  runtimeDeps: ConfiguredSquadRuntimeDeps,
  constraints?: AgentTeamExecutionConstraints
): Promise<void> {
  const { getAgentTeamRun, updateAgentTeamRunIfCurrent } =
    await import("@/lib/db/agent-team-runtime")
  const durableRun = await getAgentTeamRun(runId)
  const team = bindSquadStoreReader(constraints).getTeam(teamId)
  if (
    team &&
    durableRun &&
    !controlDecisionStands(durableRun.status) &&
    durableRun.stop?.state !== "requested" &&
    durableRun.stop?.state !== "unconfirmed" &&
    stackedDeliveryOn(team.config.githubDeliveryPolicy)
  ) {
    const {
      prepareAndPublishGithubStack,
      STACK_PUBLISH_HELD_REASON,
      STACK_PUBLISH_REFUSED_REASON,
      StackPublishHeldError,
    } = await import("../delivery/github-delivery-adapter")
    try {
      await prepareAndPublishGithubStack(team, runId, {
        resolveTeamRepo: runtimeDeps.resolveTeamRepo,
        resolveOctokit: runtimeDeps.resolvePrObserveOctokit,
      })
    } catch (error) {
      // A reason CODE on the run. The message stays out of the record: it is
      // provider text, and the row is projected onto every surface. A publish
      // the outbound policy stopped (ADR-0239 phase 2) waits for a person's
      // "approve and publish"; its draft graph is kept.
      const held = error instanceof StackPublishHeldError
      const patch = {
        status: "needs_input",
        recoveryReason: held
          ? error.reason === "held"
            ? STACK_PUBLISH_HELD_REASON
            : STACK_PUBLISH_REFUSED_REASON
          : "delivery_failed",
        updatedAt: Date.now(),
      } as const
      // Stop/pause can win while the provider is in flight. Never replace its
      // control decision with a late delivery error or approval hold.
      for (;;) {
        const current = await getAgentTeamRun(runId)
        if (
          !current ||
          controlDecisionStands(current.status) ||
          current.stop?.state === "requested" ||
          current.stop?.state === "unconfirmed"
        )
          return
        if (await updateAgentTeamRunIfCurrent(runId, current, patch)) break
      }
      useAgentTeamStore.getState().setTeamStatus(teamId, "paused")
      if (!held) console.warn("[agent-team] GitHub delivery failed", { runId, error })
      return
    }
  }
}

/** Mirror the settled lifecycle, close its span, and emit the scheduler event. */
async function settleSquadRun(
  teamId: string,
  runId: string,
  result: RunTeamLifecycleResult
): Promise<void> {
  const [{ getAgentTeamRun }, { settleAgentTeamExecutionRun }] = await Promise.all([
    import("@/lib/db/agent-team-runtime"),
    import("@/lib/execution/agent-team-bridge"),
  ])
  let durableRun = await getAgentTeamRun(runId).catch(() => undefined)
  if (
    result.status === "cancelled" &&
    durableRun &&
    !isTerminalTeamStatus(durableRun.status) &&
    !isParkedTeamStatus(durableRun.status)
  ) {
    // The lifecycle settling its own abort: the machine's coordinator step,
    // not its entry (the abort already happened and this function writes the
    // mirror), then the stop's interrupt denial.
    const { controlDurableRun, denyPendingSquadInterrupts } =
      await import("../durable/durable-control")
    try {
      await controlDurableRun(runId, "stop")
    } catch {
      await parkSquadRecovery(runId, teamId, "stop_unconfirmed")
      return
    }
    durableRun = await getAgentTeamRun(runId).catch(() => undefined)
    if (durableRun?.status === "cancelled") {
      const { agentTeamExecutionRunId } = await import("@/lib/execution/agent-team-bridge")
      await denyPendingSquadInterrupts(agentTeamExecutionRunId(runId), Date.now()).catch(
        () => undefined
      )
    }
  }

  const durableStatus: AgentTeamRunStatus | undefined = durableRun?.status
  const parked = durableStatus !== undefined && isParkedTeamStatus(durableStatus)
  if (durableStatus !== undefined && isTerminalTeamStatus(durableStatus)) {
    result = { ...result, status: teamRunOutcome(durableStatus) }
  }

  useAgentTeamStore.getState().setTeamStatus(teamId, parked ? "paused" : result.status)

  const terminal = ["completed", "failed", "cancelled"].includes(result.status)
  await closeSquadRunSpan(runId, durableRun, result)

  // Publication uses this run's credentials; keep it live through delivery,
  // including a policy hold that a person can release later.
  if (durableRun && !parked && terminal) {
    await settleAgentTeamExecutionRun(
      durableRun,
      result.status as "completed" | "failed" | "cancelled"
    ).catch(() => undefined)
  }
  if (!parked) {
    void emitTeamCompletedSchedulerEvent(teamId, result.status)
  }
}

/**
 * Emit an `agent-team:completed` scheduler event when a team run reaches a
 * terminal status, so event-triggered scheduled tasks (and forward chains) can
 * react. Lazy import and best-effort.
 */
export async function emitTeamCompletedSchedulerEvent(
  teamId: string,
  status: string
): Promise<void> {
  try {
    const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
    await emitSchedulerEvent("agent-team:completed", { teamId, status }, "agent-team")
  } catch {
    // Scheduler unavailable (web-only path). Best-effort.
  }
}
