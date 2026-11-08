// The `room-squad-handoff` capability port (ADR-0252 §4, ADR-0250 §14):
// decide a character-team room member's proposal to hand work to a Squad.
// The kernel's write arm for paired devices (`room_squad_handoff_decide`,
// `lib/companion/room-write-handlers.ts`) asks for it; the squads module
// (`lib/squads/module.ts`) provides it, and its card decides through the same
// function on the Host. The proposal is the member's `room_handoff_to_squad`
// tool call (`types/squads/room-handoff.ts`).

/**
 * Who decided. `auto`: the room's `squadHandoff` setting is `auto`. `im`: a
 * person in an IM group answered the confirmation card the connector posted
 * there (ADR-0177 batch 5), as the platform names them.
 */
export type RoomSquadHandoffDecider =
  | { kind: "local" }
  | { kind: "device"; deviceId: string }
  | { kind: "auto" }
  | { kind: "im"; adapterId: string; remoteUserId?: string }

/** What was decided about one proposal. Written once; a second decision is refused. */
export type RoomSquadHandoffDecision =
  | {
      status: "declined"
      decidedAt: number
      decidedBy: RoomSquadHandoffDecider
    }
  | {
      status: "started"
      squadId: string
      /** The Squad's name when it started, so a deleted Squad still reads as something. */
      squadName: string
      /** `execution:delegation:room-handoff:<toolUseId>`. */
      delegationRunId: string
      /** The first attempt's execution run id (`execution:team:<runId>`). */
      squadRunId: string
      decidedAt: number
      decidedBy: RoomSquadHandoffDecider
    }
  | {
      status: "failed"
      squadId: string
      /** Why the Squad run did not start: a launch refusal code. */
      reason: string
      decidedAt: number
      decidedBy: RoomSquadHandoffDecider
    }

/** A person (or the room's setting) deciding one proposal. */
export interface RoomSquadHandoffDecideRequest {
  roomId: string
  /** The proposal: the member's `room_handoff_to_squad` tool call id. */
  toolUseId: string
  decision: "confirm" | "decline"
  /** The Squad to start, overriding the member's pick. Required when the member named none. */
  squadId?: string
}

export type RoomSquadHandoffDecideRefusal =
  /** No room here, or not one whose hand-offs this host decides. */
  | "room_not_found"
  /** The room holds no such proposal. */
  | "proposal_not_found"
  /** Neither the member nor the request named a Squad. */
  | "squad_required"
  /** The named Squad does not exist here. */
  | "squad_not_found"
  /** The decision could not be written. */
  | "write_failed"

export type RoomSquadHandoffDecideResult =
  | {
      ok: true
      decision: RoomSquadHandoffDecision
      /** The proposal was already decided: this is that decision, unchanged. */
      already?: boolean
    }
  | { ok: false; reason: RoomSquadHandoffDecideRefusal }

export interface RoomSquadHandoffPort {
  decide(
    request: RoomSquadHandoffDecideRequest,
    decidedBy: RoomSquadHandoffDecider
  ): Promise<RoomSquadHandoffDecideResult>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "room-squad-handoff": RoomSquadHandoffPort
  }
}
