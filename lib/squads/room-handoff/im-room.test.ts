/** @jest-environment node */
import {
  __resetImRoomHandoffStepsForTesting,
  imRoomHandoffStepFor,
  imRoomHandoffStepOfCall,
  imRoomHandoffToolPart,
  openImRoomHandoffStep,
  recordImRoomHandoffCall,
} from "./im-room"

afterEach(() => __resetImRoomHandoffStepsForTesting())

const step = (memberSessionId: string, characterId = "ava") =>
  openImRoomHandoffStep({ roomId: "room-1", characterId, memberSessionId, autoAllowed: true })

const proposed = (toolUseId: string) => ({
  toolUseId,
  input: { brief: "Ship it" },
  output: { status: "proposed" as const, proposalId: toolUseId, brief: "Ship it" },
})

describe("IM room hand-off steps", () => {
  it("resolves an open step by room member and by calling sub-session", () => {
    const open = step("s-ava-1")
    expect(imRoomHandoffStepFor("room-1", "ava")).toMatchObject({ memberSessionId: "s-ava-1" })
    expect(imRoomHandoffStepFor("room-1", "ben")).toBeUndefined()
    expect(imRoomHandoffStepFor("room-2", "ava")).toBeUndefined()
    expect(imRoomHandoffStepOfCall("s-ava-1")).toMatchObject({ characterId: "ava" })
    open.close()
    expect(imRoomHandoffStepFor("room-1", "ava")).toBeUndefined()
    expect(imRoomHandoffStepOfCall("s-ava-1")).toBeUndefined()
  })

  it("records calls in order, and none after the step closed", () => {
    const open = step("s-ava-1")
    expect(recordImRoomHandoffCall("s-ava-1", proposed("tu-1"))).toBe(true)
    expect(recordImRoomHandoffCall("s-ava-1", proposed("tu-2"))).toBe(true)
    expect(open.calls().map((call) => call.toolUseId)).toEqual(["tu-1", "tu-2"])
    expect(open.parts()).toEqual([
      imRoomHandoffToolPart(proposed("tu-1")),
      imRoomHandoffToolPart(proposed("tu-2")),
    ])
    open.close()
    expect(recordImRoomHandoffCall("s-ava-1", proposed("tu-3"))).toBe(false)
    expect(open.calls()).toHaveLength(2)
  })

  it("replaces a member's stale step, and a late close of it leaves the new one open", () => {
    const stale = step("s-ava-1")
    const fresh = step("s-ava-2")
    expect(imRoomHandoffStepOfCall("s-ava-1")).toBeUndefined()
    stale.close()
    expect(imRoomHandoffStepFor("room-1", "ava")).toMatchObject({ memberSessionId: "s-ava-2" })
    fresh.close()
    expect(imRoomHandoffStepFor("room-1", "ava")).toBeUndefined()
  })

  it("keeps two members' steps apart", () => {
    step("s-ava-1")
    step("s-ben-1", "ben")
    expect(imRoomHandoffStepFor("room-1", "ava")?.memberSessionId).toBe("s-ava-1")
    expect(imRoomHandoffStepFor("room-1", "ben")?.memberSessionId).toBe("s-ben-1")
  })
})
