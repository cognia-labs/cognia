/**
 * Where a person's answer to a hand-off card goes (ADR-0252 §4): on the Host
 * that runs the room, straight to the decision; on a paired phone or a web
 * companion, to the Host over `room_squad_handoff_decide`, which decides as
 * the calling device. The same side test the room's turns route on
 * (`isCompanionShell`), so a card never decides where the room does not run.
 */

import type {
  RoomSquadHandoffDecideRequest,
  RoomSquadHandoffDecideResult,
} from "@/types/squads/room-handoff"

export const ROOM_SQUAD_HANDOFF_DECIDE_COMMAND = "room_squad_handoff_decide"

export async function requestRoomSquadHandoffDecision(
  request: RoomSquadHandoffDecideRequest
): Promise<RoomSquadHandoffDecideResult> {
  const { isCompanionShell } = await import("@/lib/chat/room/shell")
  if (!isCompanionShell()) {
    const { decideRoomSquadHandoff } = await import("./decide")
    return decideRoomSquadHandoff(request, { kind: "local" })
  }
  const { transport } = await import("@/lib/tauri")
  const result = await transport.call<RoomSquadHandoffDecideResult | null>(
    ROOM_SQUAD_HANDOFF_DECIDE_COMMAND,
    {
      sessionId: request.roomId,
      toolUseId: request.toolUseId,
      decision: request.decision,
      ...(request.squadId ? { squadId: request.squadId } : {}),
    }
  )
  return result ?? { ok: false, reason: "write_failed" }
}
