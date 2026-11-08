// The squads module's implementation of the `room-squad-handoff` port
// (`types/modules/ports/room-squad-handoff.ts`, ADR-0252 §4): deciding a room
// member's hand-off proposal, the one decision every surface makes.

import type { RoomSquadHandoffPort } from "@/types/modules/ports/room-squad-handoff"

export const port: RoomSquadHandoffPort = {
  async decide(request, decidedBy) {
    const { decideRoomSquadHandoff } = await import("../room-handoff/decide")
    return decideRoomSquadHandoff(request, decidedBy)
  },
}
