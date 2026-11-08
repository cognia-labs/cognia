/**
 * Deciding a room member's hand-off proposal (ADR-0252 §4, P6).
 *
 * One function for every surface: the card on this host, a paired device
 * over `room_squad_handoff_decide`, and the room's `auto` setting inside the
 * member's own call. It runs on the Host that orchestrates the room, and
 * decisions on one proposal are serialized, so two presses (or a phone and
 * the desktop) start one Squad run.
 *
 * Confirming takes the work on as a delegation, a child of the member's turn
 * that acts with its identity, and launches the Squad run as the
 * delegation's attempt through `launchChildRun`. The Squad run keeps its own
 * approval gates and risk policy, decided by a person in the room. The
 * decision is recorded on the member's reply through the room's runner, the
 * one writer of the room's transcript.
 *
 * Idempotent across a crash: a delegation already accepted for the proposal
 * is reused, and its existing attempt is recorded rather than a second one
 * launched.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import {
  roomHandoffDelegationId,
  type RoomSquadHandoffArgs,
  type RoomSquadHandoffDecider,
  type RoomSquadHandoffDecideRequest,
  type RoomSquadHandoffDecideResult,
  type RoomSquadHandoffDecision,
} from "@/types/squads/room-handoff"
import { findRoomHandoffProposal, withHandoffDecision, type RoomHandoffProposal } from "./proposal"

/** A started attempt, what its settlement needs to report back. */
export interface RoomHandoffAttempt {
  roomId: string
  toolUseId: string
  proposerId: string
  squadId: string
  squadName: string
  brief: string
  delegationRunId: string
  /** The attempt's execution run id (`execution:team:<runId>`). */
  squadRunId: string
  startedAt: number
}

type LaunchResult = Awaited<
  ReturnType<typeof import("@/lib/execution/launch-child-run").launchChildRun>
>

export interface RoomHandoffDecideDeps {
  getSession: (roomId: string) => Promise<ChatSession | undefined>
  readMessages: (roomId: string) => Promise<UIMessage[]>
  patchMessage: (
    roomId: string,
    messageId: string,
    apply: (message: UIMessage) => UIMessage
  ) => Promise<boolean>
  /** The Squad, when it exists here. */
  getSquad: (squadId: string) => { id: string; name: string } | undefined
  acceptDelegation: (input: {
    delegationId: string
    title: string
    sessionId: string
    projectId?: string
    parentRunId?: string
  }) => Promise<{ runId: string; created: boolean }>
  /** The delegation's attempts, newest first. */
  listAttempts: (delegationRunId: string) => Promise<ExecutionRun[]>
  launch: (input: {
    delegationRunId: string
    roomId: string
    squadId: string
    squadName: string
    brief: string
  }) => Promise<LaunchResult>
  /** Close a delegation whose only attempt never started. */
  failDelegation: (delegationRunId: string) => Promise<void>
  /** Report an attempt back once it ends (`./settle.ts`). */
  watchAttempt: (attempt: RoomHandoffAttempt, outcome: Promise<ChildRunOutcome>) => void
  now: () => number
}

async function defaultDeps(): Promise<RoomHandoffDecideDeps> {
  const [
    { getSession },
    { getHostRoomRunner },
    { useAgentTeamStore },
    delegation,
    { listChildExecutionRuns },
    { launchChildRun },
    settle,
  ] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/chat/room/runner-host"),
    import("@/stores/squads/agent-team-store/store"),
    import("@/lib/execution/delegation"),
    import("@/lib/db/execution-runs"),
    import("@/lib/execution/launch-child-run"),
    import("./settle"),
  ])
  const runner = getHostRoomRunner()
  return {
    getSession,
    readMessages: (roomId) => runner.readMessages(roomId),
    patchMessage: (roomId, messageId, apply) => runner.patchMessage(roomId, messageId, apply),
    getSquad: (squadId) => {
      const squad = useAgentTeamStore.getState().teams[squadId]
      return squad ? { id: squad.id, name: squad.name } : undefined
    },
    acceptDelegation: (input) => delegation.acceptDelegation(input),
    listAttempts: (delegationRunId) => listChildExecutionRuns(delegationRunId),
    launch: (input) =>
      launchChildRun({
        delegationRunId: input.delegationRunId,
        sessionId: input.roomId,
        title: input.squadName,
        surface: "chat",
        // A person in the room answers the Squad run's gates, as at the console.
        target: {
          kind: "squad",
          squadId: input.squadId,
          brief: input.brief,
          origin: "interactive",
        },
      }),
    failDelegation: (runId) => delegation.settleDelegation({ runId, status: "failed" }),
    watchAttempt: (attempt, outcome) => settle.watchRoomHandoffAttempt(attempt, outcome),
    now: Date.now,
  }
}

let depsOverride: RoomHandoffDecideDeps | null = null

/** Test-only: replace what deciding reads and writes. */
export function __setRoomHandoffDecideDepsForTesting(deps: RoomHandoffDecideDeps | null): void {
  depsOverride = deps
}

/** Decisions in flight, by proposal, so one proposal is decided once at a time. */
const inFlight = new Map<string, Promise<RoomSquadHandoffDecideResult>>()

export interface DecideRoomSquadHandoffOptions {
  /** The member turn's run, when the caller knows it better than the proposal does (`auto`). */
  memberRunId?: string
  /**
   * The proposal as the member's own call made it (`auto`). The call runs
   * before the room may have applied the event that holds its part, so the
   * caller vouches for it; the decision is recorded on the reply when the
   * reply holds the part, and the call's output records it either way.
   */
  proposal?: { proposerId: string; args: RoomSquadHandoffArgs }
}

/** Decide one proposal. Never throws: a failure is a refusal. */
export function decideRoomSquadHandoff(
  request: RoomSquadHandoffDecideRequest,
  decidedBy: RoomSquadHandoffDecider,
  options: DecideRoomSquadHandoffOptions = {}
): Promise<RoomSquadHandoffDecideResult> {
  const key = `${request.roomId}\u0000${request.toolUseId}`
  const previous = inFlight.get(key) ?? Promise.resolve(undefined)
  const next = previous
    .catch(() => undefined)
    .then(() => decideOnce(request, decidedBy, options))
    .catch((): RoomSquadHandoffDecideResult => ({ ok: false, reason: "write_failed" }))
  inFlight.set(key, next)
  void next.finally(() => {
    if (inFlight.get(key) === next) inFlight.delete(key)
  })
  return next
}

async function decideOnce(
  request: RoomSquadHandoffDecideRequest,
  decidedBy: RoomSquadHandoffDecider,
  options: DecideRoomSquadHandoffOptions
): Promise<RoomSquadHandoffDecideResult> {
  const deps = depsOverride ?? (await defaultDeps())
  const { isLocallyOrchestratedRoom } = await import("@/lib/chat/room/kind")
  const session = await deps.getSession(request.roomId)
  if (!session || !isLocallyOrchestratedRoom(session))
    return { ok: false, reason: "room_not_found" }
  const proposal: RoomHandoffProposal | null =
    findRoomHandoffProposal(await deps.readMessages(request.roomId), request.toolUseId) ??
    (options.proposal ? { messageId: "", toolUseId: request.toolUseId, ...options.proposal } : null)
  if (!proposal) return { ok: false, reason: "proposal_not_found" }
  if (proposal.decision) return { ok: true, decision: proposal.decision, already: true }

  if (request.decision === "decline") {
    return record(deps, request.roomId, proposal, {
      status: "declined",
      decidedAt: deps.now(),
      decidedBy,
    })
  }

  const squadId = request.squadId?.trim() || proposal.args.squadId
  if (!squadId) return { ok: false, reason: "squad_required" }
  const squad = deps.getSquad(squadId)
  if (!squad) return { ok: false, reason: "squad_not_found" }

  const memberRunId = options.memberRunId || proposal.memberRunId
  const delegation = await deps.acceptDelegation({
    delegationId: roomHandoffDelegationId(proposal.toolUseId),
    title: squad.name,
    sessionId: request.roomId,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(memberRunId ? { parentRunId: memberRunId } : {}),
  })
  const decidedAt = deps.now()
  // Accepted before (a crash between the accept and this write, or a
  // decision whose write was lost): its attempt is the hand-off's.
  const existing = delegation.created ? undefined : (await deps.listAttempts(delegation.runId))[0]
  if (existing) {
    return record(deps, request.roomId, proposal, {
      status: "started",
      squadId: squad.id,
      squadName: squad.name,
      delegationRunId: delegation.runId,
      squadRunId: existing.id,
      decidedAt,
      decidedBy,
    })
  }

  const launched = await deps.launch({
    delegationRunId: delegation.runId,
    roomId: request.roomId,
    squadId: squad.id,
    squadName: squad.name,
    brief: proposal.args.brief,
  })
  if (!launched.started) {
    await deps.failDelegation(delegation.runId).catch(() => undefined)
    return record(deps, request.roomId, proposal, {
      status: "failed",
      squadId: squad.id,
      reason: launched.detail ? `${launched.reason}: ${launched.detail}` : launched.reason,
      decidedAt,
      decidedBy,
    })
  }
  deps.watchAttempt(
    {
      roomId: request.roomId,
      toolUseId: proposal.toolUseId,
      proposerId: proposal.proposerId,
      squadId: squad.id,
      squadName: squad.name,
      brief: proposal.args.brief,
      delegationRunId: delegation.runId,
      squadRunId: launched.executionRunId,
      startedAt: decidedAt,
    },
    launched.outcome
  )
  const decision: RoomSquadHandoffDecision = {
    status: "started",
    squadId: squad.id,
    squadName: squad.name,
    delegationRunId: delegation.runId,
    squadRunId: launched.executionRunId,
    decidedAt,
    decidedBy,
  }
  // The run is started whatever the write does: report it, and let a later
  // decision find the delegation and record it again.
  const recorded = await record(deps, request.roomId, proposal, decision)
  return recorded.ok ? recorded : { ok: true, decision }
}

async function record(
  deps: RoomHandoffDecideDeps,
  roomId: string,
  proposal: RoomHandoffProposal,
  decision: RoomSquadHandoffDecision
): Promise<RoomSquadHandoffDecideResult> {
  // A proposal vouched for by its own call, whose reply does not hold it yet.
  if (!proposal.messageId) return { ok: true, decision }
  const written = await deps
    .patchMessage(roomId, proposal.messageId, withHandoffDecision(proposal.toolUseId, decision))
    .catch(() => false)
  if (!written) return { ok: false, reason: "write_failed" }
  // Another writer may have recorded first: what the reply holds is the answer.
  const held = findRoomHandoffProposal(await deps.readMessages(roomId), proposal.toolUseId)
  const stored = held?.decision ?? decision
  const already = stored.status !== decision.status || stored.decidedAt !== decision.decidedAt
  return { ok: true, decision: stored, ...(already ? { already: true } : {}) }
}
