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
 * The record is the Squad's policy view of the delegation (reason, target,
 * approval, the depth it was admitted at, the text handed back). Once
 * launched, its status is its child run's: the panel reads it through
 * `projectDelegation` (`delegation-view.ts`). Depth and cycles are walked on
 * the run tree (`lib/execution/run-tree.ts`): the Squads whose runs sit above
 * the child, plus the edges the tree cannot see yet (a delegation awaiting
 * approval, one still launching).
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
import type { ExecutionRun } from "@/types/execution/run"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { isInQuietRange } from "@/lib/notifications/policy/quiet-hours"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import { readRunAncestors } from "@/lib/execution/run-tree"
import {
  launchChildRun,
  type ChildRunTarget,
  type LaunchChildRunResult,
} from "@/lib/execution/launch-child-run"
import { delegationExecutionRunId } from "./delegation-view"

/**
 * True when the team has a quiet-hours window configured and `now` falls
 * inside it. Returns false when no policy is set so the common path is free.
 */
function isDelegationQuietGated(sourceTeamId: string, nowMs: number = Date.now()): boolean {
  const quietHours =
    useAgentTeamStore.getState().teams[sourceTeamId]?.config.governancePolicy?.delivery?.quietHours
  if (!quietHours) return false
  return isInQuietRange(nowMs, quietHours.from, quietHours.to, quietHours.tz)
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

/**
 * Link the record to its child's row (the projection reads its status from
 * there), stamp the depth it was admitted at, and attach the handoff envelope
 * now that both ends of it are real runs.
 */
function linkChildRun(
  delegationId: string,
  executionRunId: string,
  parentRunId: string | undefined,
  lineage: DelegationLineage
): void {
  const store = useAgentTeamStore.getState()
  const record = store.delegations[delegationId]
  if (!record) return
  const envelope = parentRunId
    ? buildDelegationEnvelope({
        parentRunId,
        childRunId: executionRunId,
        sourceTeamId: record.sourceTeamId,
        taskId: record.sourceTaskId,
        reason: record.reason,
        runChain: lineage.runChain,
      })
    : undefined
  store.upsertDelegation({
    ...record,
    metadata: {
      ...record.metadata,
      executionRunId,
      delegationDepth: lineage.squads.length,
      delegationChain: lineage.squads,
    },
    ...(envelope ? { envelope } : {}),
  })
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
    const lineage = await delegationLineage(run.sourceTeamId, parentRunId, delegationId)
    if (run.kind === "team") {
      // Re-checked here, on the tree as it stands at launch: an approval can
      // come long after the delegation was created.
      const refusal = teamDelegationRefusal(run.sourceTeamId, run.targetId, lineage, delegationId)
      if (refusal) {
        if (cancelled()) return current()
        return refuseTeamDelegation(delegationId, refusal)
      }
    }
    if (cancelled()) return current()
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
    linkChildRun(delegationId, launched.executionRunId, parentRunId, lineage)
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
 * Team→team edges the run tree cannot see: a delegation awaiting approval has
 * no child run yet, and one still launching has not been linked to its row.
 * A launched delegation is on the tree (its target Squad's run hangs under the
 * run that asked) and is not counted twice. `excludeId` leaves out the
 * delegation being checked, which is itself still launching.
 */
function pendingTeamEdges(excludeId?: string): TeamDelegationRecord[] {
  return Object.values(useAgentTeamStore.getState().delegations).filter(
    (d) =>
      d.id !== excludeId &&
      d.targetType === "team" &&
      Boolean(d.targetId) &&
      (d.status === "awaiting_approval" ||
        ((d.status === "active" || d.status === "pending") && !delegationExecutionRunId(d)))
  )
}

/**
 * Extend `squads` (root→source) upward through pending edges into its root:
 * a Squad that is about to be launched by another counts as already under it.
 */
function withPendingAncestry(squads: string[], excludeId?: string): string[] {
  const edges = pendingTeamEdges(excludeId)
  const chain = [...squads]
  const seen = new Set(chain)
  for (;;) {
    const incoming = edges.find((d) => d.targetId === chain[0] && !seen.has(d.sourceTeamId))
    if (!incoming) return chain
    seen.add(incoming.sourceTeamId)
    chain.unshift(incoming.sourceTeamId)
  }
}

/** Where a delegation's child sits in the run tree. */
interface DelegationLineage {
  /** The runs above the child, root→parent. Empty when it has no parent. */
  runChain: string[]
  /**
   * The Squads above the child, root→source: the Squad of every `team` run in
   * `runChain`, the source Squad last, extended upward through pending edges.
   * Its length is the child's delegation depth.
   */
  squads: string[]
}

/**
 * Read the lineage of a delegation from `sourceTeamId` whose child hangs under
 * `parentRunId`. The source Squad is appended when the parent is not its run
 * (a workflow step's run, or no parent at all).
 */
async function delegationLineage(
  sourceTeamId: string,
  parentRunId: string | undefined,
  excludeId?: string
): Promise<DelegationLineage> {
  const runs: ExecutionRun[] = []
  if (parentRunId) {
    const parent = await getExecutionRun(parentRunId).catch(() => undefined)
    if (parent) {
      const ancestors = await readRunAncestors(parentRunId).catch(() => [])
      runs.push(...ancestors.reverse(), parent)
    }
  }
  const squads: string[] = []
  if (runs.some((run) => run.kind === "team")) {
    const { squadIdForTeamRun } = await import("./squad/squad-run-records")
    for (const run of runs) {
      if (run.kind !== "team") continue
      const squad = await squadIdForTeamRun(run).catch(() => undefined)
      // One Squad run per hop: a Squad's own nested rows (a best-of-N group
      // under its run) are not a second delegation.
      if (squad && squads[squads.length - 1] !== squad) squads.push(squad)
    }
  }
  if (squads[squads.length - 1] !== sourceTeamId) squads.push(sourceTeamId)
  return {
    runChain: runs.map((run) => run.id),
    squads: withPendingAncestry(squads, excludeId),
  }
}

function maxTeamDelegationDepth(sourceTeamId: string): number {
  return (
    useAgentTeamStore.getState().teams[sourceTeamId]?.config.maxTeamDelegationDepth ??
    DEFAULT_MAX_TEAM_DELEGATION_DEPTH
  )
}

/** Why a team delegation may not run, as the failed record's metadata. */
interface TeamDelegationRefusal {
  error: string
  metadata: Record<string, unknown>
}

/**
 * The refusal for a team delegation `source → target` at `lineage`, or
 * `undefined` when it may run: a cycle (the target is already above the
 * child, or reaches a Squad above it through pending edges), or a child past
 * the source Squad's `maxTeamDelegationDepth` (default 2).
 */
function teamDelegationRefusal(
  sourceTeamId: string,
  targetTeamId: string,
  lineage: DelegationLineage,
  excludeId?: string
): TeamDelegationRefusal | undefined {
  if (wouldCreateTeamCycle(sourceTeamId, targetTeamId, lineage.squads, excludeId)) {
    return { error: "team delegation cycle rejected", metadata: {} }
  }
  const childDepth = lineage.squads.length
  const maxDepth = maxTeamDelegationDepth(sourceTeamId)
  if (childDepth > maxDepth) {
    const err = new DelegationDepthExceededError(childDepth, maxDepth)
    return {
      error: err.message,
      metadata: { errorCode: "delegation-depth-exceeded", depth: childDepth, maxDepth },
    }
  }
  return undefined
}

/** Settle a team delegation the tree refused at launch, keeping why. */
function refuseTeamDelegation(
  delegationId: string,
  refusal: TeamDelegationRefusal
): TeamDelegationRecord {
  const store = useAgentTeamStore.getState()
  const record = store.delegations[delegationId]
  if (record) {
    store.upsertDelegation({
      ...record,
      metadata: { ...record.metadata, ...refusal.metadata, error: refusal.error },
    })
  }
  return settleTeamDelegation(delegationId, "failed", refusal.error)
}

/**
 * Build (and validate) the persisted HandoffEnvelope for a launched
 * delegation. Both ends are run ids: the run the child hangs under and the
 * child's own row, with the runs above it root→parent as the chain. A
 * delegation with no parent run has no envelope, since there is no parent end
 * to name. The persisted task text is the delegation REASON — raw prompts
 * intentionally never hit disk (see `PendingRun`). Refuses to attach an
 * envelope that fails the secret-free validator rather than persisting a
 * leaking one.
 */
function buildDelegationEnvelope(input: {
  parentRunId: string
  childRunId: string
  sourceTeamId: string
  taskId: string
  reason: string
  runChain: string[]
}): HandoffEnvelope | undefined {
  const parentChain = input.runChain.length > 0 ? input.runChain : [input.parentRunId]
  const envelope: HandoffEnvelope = {
    envelopeVersion: 1,
    identity: {
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      teamId: input.sourceTeamId,
      taskId: input.taskId,
      depth: parentChain.length,
      parentChain,
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
}): TeamDelegationRecord {
  const now = new Date()
  return {
    id: nanoid(),
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
 * True when delegating `source → target` would close a cycle: the target is
 * the source, is one of the Squads above the child (`squads`, root→source,
 * from the run tree), or reaches one of them through edges the tree cannot see
 * yet (`pendingTeamEdges`). Settled delegations never block a fresh one: their
 * runs are no longer above anything that is still delegating.
 *
 * @internal Test seam: exported for its unit tests, not for production callers.
 */
export function wouldCreateTeamCycle(
  sourceTeamId: string,
  targetTeamId: string,
  squads: readonly string[] = [sourceTeamId],
  excludeId?: string
): boolean {
  const above = new Set([...squads, sourceTeamId])
  const edges = new Map<string, Set<string>>()
  for (const d of pendingTeamEdges(excludeId)) {
    if (!edges.has(d.sourceTeamId)) edges.set(d.sourceTeamId, new Set())
    edges.get(d.sourceTeamId)!.add(d.targetId!)
  }
  // Does `target` reach a Squad above the child? Then target→…→source→target.
  const seen = new Set<string>()
  const stack = [targetTeamId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (above.has(cur)) return true
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

  // What the store alone can tell is refused here, so the caller sees the
  // failed record at once: a self-delegation, a cycle or depth overrun through
  // edges not yet on the run tree. `runDelegation` re-checks on the tree.
  const known = teamDelegationRefusal(input.sourceTeamId, input.targetTeamId, {
    runChain: [],
    squads: withPendingAncestry([input.sourceTeamId]),
  })
  if (known) {
    const failed = buildDelegation({
      sourceTeamId: input.sourceTeamId,
      sourceTaskId: input.sourceTaskId,
      targetType: "team",
      targetId: input.targetTeamId,
      reason: input.reason,
      metadata: { ...input.metadata, ...known.metadata, error: known.error },
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
    if (quietDeferred) {
      // Checked on the tree now, so a deferred delegation that could never
      // run fails instead of waiting for an approval; checked again on launch.
      const refusal = await deferredTeamRefusal(delegation.id, run)
      if (
        refusal &&
        useAgentTeamStore.getState().delegations[delegation.id]?.status === "awaiting_approval"
      ) {
        pendingRuns.delete(delegation.id)
        return refuseTeamDelegation(delegation.id, refusal)
      }
      return useAgentTeamStore.getState().delegations[delegation.id] ?? delegation
    }
    const settled = await runDelegation(delegation.id, run)
    return settled ?? delegation
  })()

  return { delegation, completionPromise }
}

/** The tree's refusal for a deferred team delegation, read without launching it. */
async function deferredTeamRefusal(
  delegationId: string,
  run: PendingRun
): Promise<TeamDelegationRefusal | undefined> {
  const parentRunId = await resolveDelegationParent(run)
  const lineage = await delegationLineage(run.sourceTeamId, parentRunId, delegationId)
  return teamDelegationRefusal(run.sourceTeamId, run.targetId, lineage, delegationId)
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
 * Cancel an in-flight delegation. A launched one is stopped with the one tree
 * stop (`stopRunTree`): its child run through its kind (the background or
 * twin agent, the external agent's session, the target Squad's control) and
 * every live run under it, so a delegated Squad's own delegations stop too.
 * One still launching is stopped through its launch's signal, before or as
 * its engine starts. Transitions status to `cancelled` and fires the complete
 * hook so consumers can clean up. The stopped run's own late settle is
 * ignored (`settleTeamDelegation`).
 */
export function cancelDelegation(delegationId: string): TeamDelegationRecord | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.delegations[delegationId]
  if (!current) return undefined
  if (current.status === "completed" || current.status === "failed") return current
  // Drop any stashed run params so a cancelled (esp. deferred) delegation can
  // never be re-dispatched by a later approval.
  pendingRuns.delete(delegationId)
  const childRunId = delegationExecutionRunId(current)
  if (childRunId) {
    const abortLaunch = () =>
      runControllers.get(delegationId)?.abort(new Error("team delegation cancelled"))
    // A child the tree stop cannot reach (its row is gone) still has the
    // launch's own signal.
    void import("@/lib/execution/run-control")
      .then(({ stopRunTree }) => stopRunTree(childRunId))
      .then((result) => {
        if (!result.stopped) abortLaunch()
      })
      .catch(abortLaunch)
  } else {
    // Not linked yet: the launch in flight sees its signal and starts nothing,
    // or stops the engine it just started.
    runControllers.get(delegationId)?.abort(new Error("team delegation cancelled"))
  }
  store.updateDelegationStatus(delegationId, "cancelled")
  getPluginLifecycleHooks().dispatchOnTeamDelegationComplete({
    delegationId,
    status: "cancelled",
  })
  return useAgentTeamStore.getState().delegations[delegationId] ?? current
}
