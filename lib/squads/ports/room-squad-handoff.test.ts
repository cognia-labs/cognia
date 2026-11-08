/** @jest-environment node */
const decideRoomSquadHandoff = jest.fn(async (..._args: unknown[]) => ({
  ok: false as const,
  reason: "proposal_not_found" as const,
}))
jest.mock("../room-handoff/decide", () => ({
  decideRoomSquadHandoff: (...args: unknown[]) => decideRoomSquadHandoff(...args),
}))

import { port } from "./room-squad-handoff"

it("decides through the one decision the card and the room's setting use", async () => {
  const request = { roomId: "room-1", toolUseId: "tu-1", decision: "decline" as const }
  await expect(port.decide(request, { kind: "device", deviceId: "phone-1" })).resolves.toEqual({
    ok: false,
    reason: "proposal_not_found",
  })
  expect(decideRoomSquadHandoff).toHaveBeenCalledWith(request, {
    kind: "device",
    deviceId: "phone-1",
  })
})
