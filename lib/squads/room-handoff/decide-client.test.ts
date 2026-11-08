/** @jest-environment node */
const isCompanionShell = jest.fn(() => false)
const call = jest.fn(async (..._args: unknown[]): Promise<unknown> => null)
const decideRoomSquadHandoff = jest.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  decision: { status: "declined" as const, decidedAt: 1, decidedBy: { kind: "local" as const } },
}))
jest.mock("@/lib/chat/room/shell", () => ({ isCompanionShell: () => isCompanionShell() }))
jest.mock("@/lib/tauri", () => ({ transport: { call: (...args: unknown[]) => call(...args) } }))
jest.mock("./decide", () => ({
  decideRoomSquadHandoff: (...args: unknown[]) => decideRoomSquadHandoff(...args),
}))

import { ROOM_SQUAD_HANDOFF_DECIDE_COMMAND, requestRoomSquadHandoffDecision } from "./decide-client"

const request = {
  roomId: "room-1",
  toolUseId: "tu-1",
  decision: "confirm" as const,
  squadId: "sq-1",
}

beforeEach(() => jest.clearAllMocks())

describe("requestRoomSquadHandoffDecision", () => {
  it("decides on the Host that runs the room, as this device's person", async () => {
    await expect(requestRoomSquadHandoffDecision(request)).resolves.toMatchObject({ ok: true })
    expect(decideRoomSquadHandoff).toHaveBeenCalledWith(request, { kind: "local" })
    expect(call).not.toHaveBeenCalled()
  })

  it("asks the Host from a companion, and reads no answer as a refusal", async () => {
    isCompanionShell.mockReturnValue(true)
    call.mockResolvedValueOnce({ ok: false, reason: "squad_required" })
    await expect(
      requestRoomSquadHandoffDecision({ ...request, squadId: undefined })
    ).resolves.toEqual({ ok: false, reason: "squad_required" })
    expect(call).toHaveBeenCalledWith(ROOM_SQUAD_HANDOFF_DECIDE_COMMAND, {
      sessionId: "room-1",
      toolUseId: "tu-1",
      decision: "confirm",
    })
    await expect(requestRoomSquadHandoffDecision(request)).resolves.toEqual({
      ok: false,
      reason: "write_failed",
    })
    expect(call).toHaveBeenLastCalledWith(
      ROOM_SQUAD_HANDOFF_DECIDE_COMMAND,
      expect.objectContaining({ squadId: "sq-1" })
    )
    expect(decideRoomSquadHandoff).not.toHaveBeenCalled()
  })
})
