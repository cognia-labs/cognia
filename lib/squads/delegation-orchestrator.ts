/**
 * Delegation orchestrator: a Squad's policy for handing work to someone else
 * (ADR-0252 §3). It decides whether a delegation may run (quiet hours, an
 * approval, the depth cap, the cycle check), keeps the `TeamDelegationRecord`
 * the delegations panel shows, and fires the plugin lifecycle hooks. Running
 * the work is not its job: every target starts through `launchChildRun`, which
 * writes the child's `executionRuns` row, links it to the source Squad's live
 * run (or the workflow run that asked) and starts the engine.
 *
 *   - `delegateToBackground`, `delegateToTwin`, `delegateToExternal`,
 *     `delegateToTeam`: persist the record, fire `onTeamDelegationStart`, then
 *     launch the child and settle the record from its outcome
 *     (`completed` / `failed` / `cancelled` / `timeout`) with
 *     `onTeamDelegationComplete`. Gated delegations wait in
 *     `awaiting_approval`.
 *   - `approveDelegation`: releases an `awaiting_approval` delegation and
 *     launches it with the run params stashed at create time.
 *   - `cancelDelegation`: stops the child through the launcher and flips the
 *     record to `cancelled`.
 *
 * Every store mutation funnels through existing actions so persistence and
 * event-log wiring stay in one place.
 */

import { nanoid } from "nanoid"
import {
  validateHandoffEnvelope,
  type HandoffEnvelope,
} from "@cognia/agent-config-types/handoff-envelope"
import type {
  AgentSystemType,
  TeamDelegationRecord,
  TeamDelegationStatus,
} from "@/types/agent/agent-team"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import {
  launchChildRun,
  type ChildRunTarget,
  type LaunchChildRunResult,
} from "@/lib/execution/launch-child-run"

/**
 * True when the team has a quiet-hours window configured and `now` falls
 * inside it. Returns false when no policy is set so the common path is free.
 */
function isDelegationQuietGated(sourceTeamId: string, nowMs: number = Date.now()): boolean {
  const quietHours =
    useAgentTeamStore.getState().teams[sourceTeamId]?.config.governancePolicy?.delivery?.quietHours
  if (!quietHours) return false
  return isInQuietHours(nowMs, quietHours.from, quietHours.to, quietHours.tz)
}

/**
 * Non-persisted run params for delegations that may be (re-)dispatched later —
 * notably ones deferred to `awaiting_approval` by quiet hours / approval gates.
 * Kept in memory (NOT in the persisted store) so raw prompts never hit disk;
 * the trade-off is that an approval surviving a reload can no longer auto-run
 * (it stays `awaiting_approval` for the operator to re-issue). Keyed by
 * delegationId.
 */
interface PendingRun {
  kind: "background" | "external" | "twin" | "team"
  /** The work handed over. Unused for a team, which runs its own objective. */
  prompt: string
  systemPrompt?: string
  /**
   * background/twin: the child's id (its Job Center entry and the record's
   * `targetId`); external: the target agent id; team: the target team id.
   */
  targetId: string
  /** twin delegations only: the Employee Digital Twin to answer as. */
  twinId?: string
  sourceTeamId: string
  /** The run that asked, when it is not the source team's live run. */
  parentRunId?: string
  timeoutMs?: number
  /** team delegations only: force ultracode orchestration on the target run. */
  ultracode?: boolean
}
const pendingRuns = new Map<string, PendingRun>()

/**
 * Stop handles for launched delegations, keyed by delegationId. A cancel
 * aborts through here; the launcher turns the abort into the engine's stop
 * (an aborted agent, a cancelled external session, a run-control stop of the
 * target Squad), including while the child is still being launched.
 */
const runControllers = new Map<string, AbortController>()

/** Test-only: drop all stashed pending runs so suites start clean. */
export function __resetPendingDelegationRunsForTesting(): void {
  pendingRuns.clear()
  runControllers.clear()
}

/**
 * The run a delegation's child hangs under: the run that asked when it named
 * one that exists (a workflow step's run), otherwise the source Squad's live
 * run. Unparented when neither exists, as a delegation made from the settings
 * of a Squad that is not running is.
 */
async function resolveDelegationParent(run: PendingRun): Promise<string | undefined> {
  if (run.parentRunId && (await getExecutionRun(run.parentRunId).catch(() => undefined))) {
    return run.parentRunId
  }
  const { findLiveSquadRun } = await import("./squad/squad-run-records")
  const live = await findLiveSquadRun(run.sourceTeamId).catch(() => undefined)
  if (!live) return undefined
  const executionRunId = agentTeamExecutionRunId(live.id)
  return (await getExecutionRun(executionRunId).catch(() => undefined)) ? executionRunId : undefined
}

function childTarget(delegationId: string, run: PendingRun): ChildRunTarget {
  const background = { label: `team-delegation:${delegationId}`, kind: "team-delegation" as const }
  const system = run.systemPrompt ? { systemPrompt: run.systemPrompt } : {}
  switch (run.kind) {
    case "background":
      return { kind: "agent", prompt: run.prompt, ...system, background }
    case "twin":
      return { kind: "twin", twinId: run.twinId ?? "", question: run.prompt, ...system, background }
    case "external": {
      const workingDirectory =
        useAgentTeamStore.getState().teams[run.sourceTeamId]?.config?.workingDir
      return {
        kind: "external",
        agentId: run.targetId,
        prompt: run.prompt,
        ...system,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(run.timeoutMs ? { timeoutMs: run.timeoutMs } : {}),
      }
    }
    case "team":
      return {
        kind: "squad",
        squadId: run.targetId,
        // Blank: the target Squad runs its own objective, as a team
        // delegation always has.
        brief: "",
        origin: "delegation",
        ...(run.ultracode !== undefined ? { ultracode: run.ultracode } : {}),
      }
  }
}

function refusalText(
  run: PendingRun,
  refusal: Extract<LaunchChildRunResult, { started: false }>
): string {
  if (run.kind === "team" && refusal.detail === "squad_not_found") {
    return `target team not found: ${run.targetId}`
  }
  return `${run.kind} delegation refused: ${refusal.reason}${refusal.detail ? ` (${refusal.detail})` : ""}`
}

function delegationStatusFor(
  outcome: ChildRunOutcome
): "completed" | "failed" | "cancelled" | "timeout" {
  if (outcome.status === "failed" && outcome.timedOut) return "timeout"
  return outcome.status
}

/** Link the record to its child's row, for the panel and the run tree. */
function recordChildRun(delegationId: string, executionRunId: string): void {
  const store = useAgentTeamStore.getState()
  const record = store.delegations[delegationId]
  if (!record) return
  store.upsertDelegation({ ...record, metadata: { ...record.metadata, executionRunId } })
}

/**
 * Launch a delegation's child and settle the record from its outcome. Shared
 * by every `delegateTo*` (immediate path) and `approveDelegation` (gated path
 * released later). A record `cancelDelegation` already settled stays
 * cancelled: whatever the stopped child reports afterwards is dropped.
 */
async function runDelegation(
  delegationId: string,
  run: PendingRun
): Promise<TeamDelegationRecord | undefined> {
  const current = () => useAgentTeamStore.getState().delegations[delegationId]
  const cancelled = () => current()?.status === "cancelled"
  if (cancelled()) {
    pendingRuns.delete(delegationId)
    return current()
  }
  const controller = new AbortController()
  runControllers.set(delegationId, controller)
  try {
    const parentRunId = await resolveDelegationParent(run)
    const launched = await launchChildRun({
      ...(parentRunId ? { parentRunId } : {}),
      target: childTarget(delegationId, run),
      title: `team-delegation:${delegationId}`,
      ...(run.kind === "background" || run.kind === "twin" ? { childId: run.targetId } : {}),
      surface: "agent-team",
      signal: controller.signal,
    })
    if (!launched.started) {
      if (cancelled()) return current()
      return settleTeamDelegation(delegationId, "failed", refusalText(run, launched))
    }
    recordChildRun(delegationId, launched.executionRunId)
    const outcome = await launched.outcome
    if (cancelled()) return current()
    return settleTeamDelegation(
      delegationId,
      delegationStatusFor(outcome),
      outcome.status === "completed" ? (outcome.text ?? "") : outcome.error
    )
  } catch (err) {
    if (cancelled()) return current()
    return settleTeamDelegation(
      delegationId,
      "failed",
      err instanceof Error ? err.message : String(err)
    )
  } finally {
    pendingRuns.delete(delegationId)
    runControllers.delete(delegationId)
  }
}

export interface DelegateToBackgroundInput {
  sourceTeamId: string
  sourceTaskId: string
  prompt: string
  /** Optional system prompt for the spawned background agent. */
  systemPrompt?: string
  /** Free-form reason — surfaced in workspace UI + audit log. */
  reason: string
  /** When true, the delegation requires approval before run starts. */
  awaitingApproval?: boolean
  /** Optional ad-hoc tag attached to the delegation record metadata. */
  metadata?: Record<string, unknown>
  /** Optional id of the background-agent run; defaults to nanoid. */
  backgroundAgentId?: string
  /** The run that asked (a workflow step's run). Defaults to the source team's live run. */
  parentRunId?: string
  /**
   * Operator override — when true, launch even inside the team's quiet-hours
   * window. Default false: a quiet-hours-gated delegation is deferred to
   * `awaiting_approval` for the operator to release later.
   */
  force?: boolean
}

export interface DelegateToExternalInput {
  sourceTeamId: string
  sourceTaskId: string
  /** Target external agent id (e.g. "claude-code" / "codex"). */
  targetAgentId: string
  /** The prompt handed to the external agent. */
  prompt: string
  /** Optional system prompt for the external run. */
  systemPrompt?: string
  reason: string
  metadata?: Record<string, unknown>
  /** Operator override — launch even inside the quiet-hours window. */
  force?: boolean
  /** Watchdog timeout (ms) before the run is settled as `timeout`. */
  timeoutMs?: number
  /** The run that asked (a workflow step's run). Defaults to the source team's live run. */
  parentRunId?: string
}

/** Build a fresh delegation record with the canonical lifecycle defaults. */
/** Default team delegation depth cap (ADR-0090 Phase 7) — depths 0/1/2 may
 * delegate; a depth-2 child delegating again is refused. Distinct from the
 * native subagent `dispatchContext.maxDepth` budget. */
export const DEFAULT_MAX_TEAM_DELEGATION_DEPTH = 2

export class DelegationDepthExceededError extends Error {
  readonly depth: number
  readonly maxDepth: number

  constructor(depth: number, maxDepth: number) {
    super(
      `team delegation refused: depth ${depth} exceeds maxTeamDelegationDepth ${maxDepth} ` +
        `(ADR-0090 Phase 7)`
    )
    this.name = "DelegationDepthExceededError"
    this.depth = depth
    this.maxDepth = maxDepth
  }
}

/**
 * Walk the ACTIVE team-delegation graph upward from `teamId` and return
 * `{ depth, chain }`: how many active team→team hops sit above it (a root
 * team is depth 0) and the team-id chain root→…→teamId.
 */
function activeTeamDelegationDepth(teamId: string): { depth: number; chain: string[] } {
  const delegations = Object.values(useAgentTeamStore.getState().delegations).filter(
    (d) =>
      d.targetType === "team" &&
      d.targetId &&
      (d.status === "active" || d.status === "awaiting_approval")
  )
  const chain: string[] = [teamId]
  const seen = new Set<string>([teamId])
  let current = teamId
  for (;;) {
    const incoming = delegations.find((d) => d.targetId === current)
    if (!incoming || seen.has(incoming.sourceTeamId)) break
    seen.add(incoming.sourceTeamId)
    chain.unshift(incoming.sourceTeamId)
    current = incoming.sourceTeamId
  }
  return { depth: chain.length - 1, chain }
}

/**
 * Throw the typed depth error when a delegation FROM `sourceTeamId` would put
 * its child past the source team's `maxTeamDelegationDepth` (default 2).
 * Returns the child depth + root chain for envelope construction.
 */
function assertTeamDelegationDepth(sourceTeamId: string): {
  childDepth: number
  chain: string[]
} {
  const { depth, chain } = activeTeamDelegationDepth(sourceTeamId)
  const maxDepth =
    useAgentTeamStore.getState().teams[sourceTeamId]?.config.maxTeamDelegationDepth ??
    DEFAULT_MAX_TEAM_DELEGATION_DEPTH
  const childDepth = depth + 1
  if (childDepth > maxDepth) {
    throw new DelegationDepthExceededError(childDepth, maxDepth)
  }
  return { childDepth, chain }
}

/**
 * Build (and validate) the persisted HandoffEnvelope for a delegation. The
 * persisted task text is the delegation REASON — raw prompts intentionally
 * never hit disk (see `PendingRun`). Refuses to attach an envelope that fails
 * the secret-free validator rather than persisting a leaking one.
 */
function buildDelegationEnvelope(input: {
  delegationId: string
  sourceTeamId: string
  taskId: string
  reason: string
  depth: number
  chain: string[]
}): HandoffEnvelope | undefined {
  const envelope: HandoffEnvelope = {
    envelopeVersion: 1,
    identity: {
      parentRunId: input.sourceTeamId,
      childRunId: input.delegationId,
      teamId: input.sourceTeamId,
      taskId: input.taskId,
      depth: input.depth,
      parentChain: input.chain,
    },
    task: { prompt: input.reason },
    execution: { mode: "orchestrated" },
    createdAt: new Date().toISOString(),
  }
  return validateHandoffEnvelope(envelope).length === 0 ? envelope : undefined
}

function buildDelegation(input: {
  sourceTeamId: string
  sourceTaskId: string
  targetType: AgentSystemType
  targetId?: string
  reason: string
  manual?: boolean
  metadata?: Record<string, unknown>
  status?: TeamDelegationStatus
  /** Delegation depth of the child; defaults to a fresh walk from the source. */
  depth?: { childDepth: number; chain: string[] }
}): TeamDelegationRecord {
  const now = new Date()
  const id = nanoid()
  const depth =
    input.depth ??
    (() => {
      const walked = activeTeamDelegationDepth(input.sourceTeamId)
      return { childDepth: walked.depth + 1, chain: walked.chain }
    })()
  return {
    id,
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: input.targetType,
    targetId: input.targetId,
    status: input.status ?? "active",
    reason: input.reason,
    manual: input.manual ?? true,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
    envelope: buildDelegationEnvelope({
      delegationId: id,
      sourceTeamId: input.sourceTeamId,
      taskId: input.sourceTaskId,
      reason: input.reason,
      depth: depth.childDepth,
      chain: depth.chain,
    }),
  }
}

/**
 * Delegate a task to a background agent. The orchestrator:
 *   1. Persists a `TeamDelegationRecord` in `active` status (or
 *      `awaiting_approval` when the input says so).
 *   2. Fires `onTeamDelegationStart`.
 *   3. Launches an `agent` child run (`launchChildRun`), registered in the
 *      Job Center under the record's `targetId`. On settle, transitions the
 *      delegation to `completed` / `failed` / `cancelled` and fires
 *      `onTeamDelegationComplete`.
 *
 * Returns the initial delegation record synchronously; callers await
 * `delegation.completionPromise` for the final state.
 */
export function delegateToBackground(input: DelegateToBackgroundInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const hooks = getPluginLifecycleHooks()
  const agentId = input.backgroundAgentId ?? `bg_${nanoid(10)}`
  // Defer to awaiting_approval when launched inside quiet hours without an
  // explicit operator override — the operator releases it later.
  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const deferred = Boolean(input.awaitingApproval) || quietDeferred
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "background",
    targetId: agentId,
    reason: input.reason,
    metadata: quietDeferred ? { ...input.metadata, quietHoursDeferred: true } : input.metadata,
    status: deferred ? "awaiting_approval" : "active",
  })
  store.upsertDelegation(delegation)
  // Stash the run params so a gated delegation can be re-dispatched on approval.
  const run: PendingRun = {
    kind: "background",
    prompt: input.prompt,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    targetId: agentId,
    sourceTeamId: input.sourceTeamId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  }
  pendingRuns.set(delegation.id, run)
  hooks.dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (deferred) {
      // The operator transitions out of awaiting_approval via
      // `approveDelegation` (which re-dispatches) / `cancelDelegation`.
      return delegation
    }
    const settled = await runDelegation(delegation.id, run)
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

export interface DelegateToTwinInput {
  sourceTeamId: string
  sourceTaskId: string
  /** The Employee Digital Twin (ADR-0003) to answer the sub-problem as. */
  twinId: string
  /** The task prompt handed to the twin-backed background agent. */
  prompt: string
  /** Optional base system prompt to wrap with the twin persona. */
  systemPrompt?: string
  reason: string
  metadata?: Record<string, unknown>
  /** Defer to `awaiting_approval` for later manual release. */
  awaitingApproval?: boolean
  /** Operator override — launch even inside the quiet-hours window. */
  force?: boolean
  /** The run that asked (a workflow step's run). Defaults to the source team's live run. */
  parentRunId?: string
}

/**
 * Delegate a sub-problem to an Employee Digital Twin (ADR-0003 × ADR-0022):
 * a background agent answers it "as" that digital employee (persona + RAG
 * knowledge pre-injected). Mirrors `delegateToBackground`'s lifecycle; the
 * `targetId` is the background agent id (so cancel works) and the twin id is
 * carried in `metadata.twinId` + the stashed pending run.
 *
 * Returns the initial record synchronously; callers await `completionPromise`.
 */
export function delegateToTwin(input: DelegateToTwinInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const hooks = getPluginLifecycleHooks()
  const agentId = `bg_${nanoid(10)}`
  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const deferred = Boolean(input.awaitingApproval) || quietDeferred
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "twin",
    targetId: agentId,
    reason: input.reason,
    metadata: {
      ...input.metadata,
      twinId: input.twinId,
      ...(quietDeferred ? { quietHoursDeferred: true } : {}),
    },
    status: deferred ? "awaiting_approval" : "active",
  })
  store.upsertDelegation(delegation)
  const run: PendingRun = {
    kind: "twin",
    prompt: input.prompt,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    targetId: agentId,
    twinId: input.twinId,
    sourceTeamId: input.sourceTeamId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  }
  pendingRuns.set(delegation.id, run)
  hooks.dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (deferred) return delegation
    const settled = await runDelegation(delegation.id, run)
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

/**
 * Delegate to an external agent (Claude Code / Codex / etc.). Mirrors
 * `delegateToBackground`: persists the record, fires the start hook, then
 * launches an `external` child run, which places the agent and runs it behind
 * its deadline (`timeout` when that fires), and self-settles. When
 * deferred by quiet hours, stays `awaiting_approval` and is re-dispatched by
 * `approveDelegation`.
 *
 * Returns the initial record synchronously; callers await `completionPromise`
 * for the final state.
 */
export function delegateToExternal(input: DelegateToExternalInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "sub_agent",
    targetId: input.targetAgentId,
    reason: input.reason,
    metadata: quietDeferred ? { ...input.metadata, quietHoursDeferred: true } : input.metadata,
    status: quietDeferred ? "awaiting_approval" : "active",
  })
  store.upsertDelegation(delegation)
  const run: PendingRun = {
    kind: "external",
    prompt: input.prompt,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    targetId: input.targetAgentId,
    sourceTeamId: input.sourceTeamId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  }
  pendingRuns.set(delegation.id, run)
  getPluginLifecycleHooks().dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (quietDeferred) return delegation
    const settled = await runDelegation(delegation.id, run)
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

export interface DelegateToTeamInput {
  sourceTeamId: string
  sourceTaskId: string
  /** The team that will run this delegated work. */
  targetTeamId: string
  reason: string
  metadata?: Record<string, unknown>
  /** Operator override — launch even inside the quiet-hours window. */
  force?: boolean
  /** Force ultracode orchestration on the target team run. */
  ultracode?: boolean
  /** The run that asked (a workflow step's run). Defaults to the source team's live run. */
  parentRunId?: string
}

/**
 * True when delegating `source → target` would close a cycle in the ACTIVE
 * team-delegation graph (target already reaches source, or target === source).
 * Walks only `team`-typed delegations in a non-terminal status, so resolved
 * delegations never block a fresh one.
 *
 * @internal Test seam: exported for its unit tests, not for production callers.
 */
export function wouldCreateTeamCycle(sourceTeamId: string, targetTeamId: string): boolean {
  if (sourceTeamId === targetTeamId) return true
  const delegations = Object.values(useAgentTeamStore.getState().delegations)
  const edges = new Map<string, Set<string>>()
  for (const d of delegations) {
    if (
      d.targetType === "team" &&
      d.targetId &&
      (d.status === "active" || d.status === "awaiting_approval")
    ) {
      if (!edges.has(d.sourceTeamId)) edges.set(d.sourceTeamId, new Set())
      edges.get(d.sourceTeamId)!.add(d.targetId)
    }
  }
  // Is `source` reachable FROM `target`? If so, target→…→source→target cycles.
  const seen = new Set<string>()
  const stack = [targetTeamId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === sourceTeamId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) ?? []) stack.push(next)
  }
  return false
}

/**
 * Delegate a task to ANOTHER team (team → team). Launches a `squad` child run
 * of the source team's live run, waits for it to settle, then settles the
 * delegation with its outcome and the target team's `finalResult`. Rejects
 * cycles and depth overruns up front, honors the quiet-hours gate (defers to
 * `awaiting_approval`, released by `approveDelegation`), and fires the same
 * start / complete hooks as the other delegation paths.
 *
 * Returns the initial record synchronously; callers await `completionPromise`.
 */
export function delegateToTeam(input: DelegateToTeamInput): {
  delegation: TeamDelegationRecord
  completionPromise: Promise<TeamDelegationRecord>
} {
  const store = useAgentTeamStore.getState()
  const hooks = getPluginLifecycleHooks()

  if (wouldCreateTeamCycle(input.sourceTeamId, input.targetTeamId)) {
    const failed = buildDelegation({
      sourceTeamId: input.sourceTeamId,
      sourceTaskId: input.sourceTaskId,
      targetType: "team",
      targetId: input.targetTeamId,
      reason: input.reason,
      metadata: { ...input.metadata, error: "team delegation cycle rejected" },
      status: "failed",
    })
    store.upsertDelegation(failed)
    return { delegation: failed, completionPromise: Promise.resolve(failed) }
  }

  // ADR-0090 Phase 7: team delegation depth gate (default 2, per-team
  // `maxTeamDelegationDepth`). Refused BEFORE any dispatch, persisted as a
  // failed record so the board shows WHY nothing ran.
  let depthInfo: { childDepth: number; chain: string[] }
  try {
    depthInfo = assertTeamDelegationDepth(input.sourceTeamId)
  } catch (err) {
    if (!(err instanceof DelegationDepthExceededError)) throw err
    const failed = buildDelegation({
      sourceTeamId: input.sourceTeamId,
      sourceTaskId: input.sourceTaskId,
      targetType: "team",
      targetId: input.targetTeamId,
      reason: input.reason,
      metadata: {
        ...input.metadata,
        error: err.message,
        errorCode: "delegation-depth-exceeded",
        depth: err.depth,
        maxDepth: err.maxDepth,
      },
      status: "failed",
    })
    store.upsertDelegation(failed)
    return { delegation: failed, completionPromise: Promise.resolve(failed) }
  }

  const quietDeferred = !input.force && isDelegationQuietGated(input.sourceTeamId)
  const delegation = buildDelegation({
    sourceTeamId: input.sourceTeamId,
    sourceTaskId: input.sourceTaskId,
    targetType: "team",
    targetId: input.targetTeamId,
    reason: input.reason,
    metadata: quietDeferred ? { ...input.metadata, quietHoursDeferred: true } : input.metadata,
    status: quietDeferred ? "awaiting_approval" : "active",
    depth: depthInfo,
  })
  store.upsertDelegation(delegation)
  // Stashed like the other targets, so a quiet-hours deferral runs on approval.
  const run: PendingRun = {
    kind: "team",
    prompt: "",
    targetId: input.targetTeamId,
    sourceTeamId: input.sourceTeamId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
  }
  pendingRuns.set(delegation.id, run)
  hooks.dispatchOnTeamDelegationStart({
    delegationId: delegation.id,
    sourceTeamId: delegation.sourceTeamId,
    sourceTaskId: delegation.sourceTaskId,
    targetType: delegation.targetType,
    targetId: delegation.targetId,
  })

  const completionPromise = (async (): Promise<TeamDelegationRecord> => {
    if (quietDeferred) return delegation
    const settled = await runDelegation(delegation.id, run)
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

/**
 * Settle a self-running delegation once. A record that is already `cancelled`
 * stays so: the run it aborted (an external agent, a target team) still
 * returns afterwards, and that late result must neither overwrite the cancel
 * nor fire a second complete hook.
 */
function settleTeamDelegation(
  delegationId: string,
  status: "completed" | "failed" | "cancelled" | "timeout",
  result?: string
): TeamDelegationRecord {
  const store = useAgentTeamStore.getState()
  const existing = store.delegations[delegationId]
  if (existing?.status === "cancelled") return existing
  store.updateDelegationStatus(delegationId, status, result)
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({ delegationId, status })
  return useAgentTeamStore.getState().delegations[delegationId]
}

/**
 * Approve a delegation that was created in `awaiting_approval` status.
 * Transitions to `active` and launches the original run (any target) with
 * the run params stashed at create time. When no pending run
 * is found (e.g. the app reloaded and the in-memory params were lost) the
 * status still flips to `active` for an operator to re-issue manually.
 *
 * Returns the record synchronously after flipping to `active`; the re-dispatch
 * settles asynchronously via the same complete hook as the immediate paths.
 */
export function approveDelegation(delegationId: string): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current || current.status !== "awaiting_approval") return current
  store.updateDelegationStatus(delegationId, "active")

  const pending = pendingRuns.get(delegationId)
  if (pending) void runDelegation(delegationId, pending)
  return useAgentTeamStore.getState().delegations[delegationId]
}

/**
 * Cancel an in-flight delegation. Stops the child run behind it through the
 * launcher (the background or twin agent, the external agent's session, or a
 * run-control stop of the target team's run), transitions
 * status to `cancelled` and fires the complete hook so consumers can clean up.
 * The aborted run's own late settle is ignored (`settleTeamDelegation`).
 */
export function cancelDelegation(delegationId: string): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current) return undefined
  if (current.status === "completed" || current.status === "failed") return current
  // Drop any stashed run params so a cancelled (esp. deferred) delegation can
  // never be re-dispatched by a later approval.
  pendingRuns.delete(delegationId)
  // The launcher stops whichever engine the child runs on.
  runControllers.get(delegationId)?.abort(new Error("team delegation cancelled"))
  store.updateDelegationStatus(delegationId, "cancelled")
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({
    delegationId,
    status: "cancelled",
  })
  return useAgentTeamStore.getState().delegations[delegationId] ?? current
}
