/**
 * A room member hands work to a Squad (ADR-0252 §4, P6).
 *
 * The member calls `room_handoff_to_squad`. The call's tool part is the
 * proposal: its card sits in the member's reply, where the member proposed
 * it, and its id is the tool call's id. What was decided is recorded on that
 * reply, under `metadata.squadHandoffs[<toolUseId>]`, and only the room's
 * runner writes it (`lib/squads/room-handoff/decide.ts`).
 *
 * A confirmed hand-off is a delegation (`execution:delegation:room-handoff:<toolUseId>`),
 * a child of the member's turn, whose attempt is the Squad run. When an
 * attempt ends, its result is delivered to the member who proposed it, as an
 * automated room turn (ADR-0249).
 */

import type {
  RoomSquadHandoffDecision,
  RoomSquadHandoffDecider,
  RoomSquadHandoffDecideRefusal,
  RoomSquadHandoffDecideRequest,
  RoomSquadHandoffDecideResult,
} from "@/types/modules/ports/room-squad-handoff"

// The decision's contract is the kernel's port (a paired device decides
// through the Host's write arm): re-exported here for the squads module.
export type {
  RoomSquadHandoffDecision,
  RoomSquadHandoffDecider,
  RoomSquadHandoffDecideRefusal,
  RoomSquadHandoffDecideRequest,
  RoomSquadHandoffDecideResult,
}

export const ROOM_HANDOFF_TOOL_NAME = "room_handoff_to_squad"

/** The metadata key on the member's reply that holds each proposal's decision. */
export const ROOM_HANDOFF_METADATA_KEY = "squadHandoffs"

/** The longest brief a member may hand over. */
export const ROOM_HANDOFF_BRIEF_MAX_CHARS = 8_000

/** The delegation id a proposal's hand-off is recorded under. */
export function roomHandoffDelegationId(toolUseId: string): string {
  return `room-handoff:${toolUseId}`
}

/** The proposal, as the member's call asked for it. */
export interface RoomSquadHandoffArgs {
  /** The Squad the member proposed. Absent: a person picks one on the card. */
  squadId?: string
  /** What the Squad is asked to do. */
  brief: string
}

/** What the member's call returns, which the model reads and the card shows. */
export type RoomSquadHandoffToolOutput =
  | {
      status: "proposed"
      proposalId: string
      squadId?: string
      brief: string
      /**
       * The member turn's run that made the call: a confirmed hand-off is its
       * child and acts with its identity. An id, never shown.
       */
      memberRunId?: string
    }
  | {
      /** Started by the room's `auto` setting inside the call. */
      status: "started"
      proposalId: string
      squadId: string
      squadName: string
      brief: string
      delegationRunId: string
      squadRunId: string
      decidedAt: number
    }
  | {
      status: "refused"
      proposalId: string
      squadId?: string
      brief: string
      reason: string
    }
