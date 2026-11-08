import {
  DEFAULT_ROOM_REPLY_MODE,
  MAX_ROOM_INSTRUCTIONS_CHARS,
  ROOM_REPLY_MODES,
  buildRoomInstructionsSection,
  defaultRoomMemory,
  initialRoomMemoryFields,
  resolveAutoRoundBudget,
  resolveRoomSettings,
  roomSettingsPatch,
} from "./settings"
import { MAX_AUTO_ROUNDS } from "@/lib/db/teams"

const team = { kind: "team" as const, teamId: "t" }
const im = {
  kind: "direct" as const,
  platformBinding: { platform: "telegram", adapterId: "a", conversationKey: "k" } as never,
}

describe("resolveRoomSettings", () => {
  it("defaults a team room to memory on and a multi-human room to memory off", () => {
    expect(resolveRoomSettings(team)).toMatchObject({
      kind: "team",
      memory: true,
      memoryDefaulted: true,
    })
    expect(resolveRoomSettings(im)).toMatchObject({
      kind: "im",
      memory: false,
      memoryDefaulted: true,
    })
    expect(defaultRoomMemory("shared")).toBe(false)
  })

  it("reads a legacy row's memoryUse when roomSettings has no memory field", () => {
    expect(resolveRoomSettings({ ...im, memoryUse: true })).toMatchObject({
      memory: true,
      memoryDefaulted: false,
    })
  })

  it("prefers the stored room setting over the legacy switch", () => {
    expect(
      resolveRoomSettings({ ...team, memoryUse: true, roomSettings: { memory: false } })
    ).toMatchObject({ memory: false })
  })

  it("falls back to the default reply mode on an unknown value", () => {
    expect(
      resolveRoomSettings({ ...team, roomSettings: { replyMode: "loud" as never } })
    ).toMatchObject({ replyMode: DEFAULT_ROOM_REPLY_MODE })
    expect(ROOM_REPLY_MODES).toEqual(["auto", "mention_only", "asleep"])
  })

  it("trims and clamps instructions and dedupes muted ids", () => {
    const long = "x".repeat(MAX_ROOM_INSTRUCTIONS_CHARS + 10)
    const resolved = resolveRoomSettings({
      ...team,
      roomSettings: { instructions: `  ${long}  `, mutedMemberIds: ["a", "a", "", "b"] },
    })
    expect(resolved.instructions).toHaveLength(MAX_ROOM_INSTRUCTIONS_CHARS)
    expect(resolved.mutedMemberIds).toEqual(["a", "b"])
  })

  it("resolves replyMode and mutedMemberIds for the router (live since batch 3)", () => {
    // The runner reads both through `routeTurn` and `planAutoRound`; the
    // pin from batch 1 that said they were inert is gone with the label.
    const resolved = resolveRoomSettings({
      ...team,
      roomSettings: { replyMode: "asleep", mutedMemberIds: ["a"] },
    })
    expect(resolved.replyMode).toBe("asleep")
    expect(resolved.mutedMemberIds).toEqual(["a"])
  })

  it("makes a hand-off to a Squad wait for a person unless the room says auto", () => {
    expect(resolveRoomSettings(team).squadHandoff).toBe("confirm")
    expect(
      resolveRoomSettings({ ...team, roomSettings: { squadHandoff: "auto" } }).squadHandoff
    ).toBe("auto")
    // A mode this build does not know (a newer client's) waits for a person.
    expect(
      resolveRoomSettings({
        ...team,
        roomSettings: { squadHandoff: "eventually" as never },
      }).squadHandoff
    ).toBe("confirm")
  })
})

describe("roomSettingsPatch", () => {
  it("writes the whole object and mirrors memory onto the session switches", () => {
    expect(roomSettingsPatch({ instructions: "keep" }, { memory: false })).toEqual({
      roomSettings: { instructions: "keep", memory: false },
      memoryUse: false,
      memoryLearn: false,
    })
  })

  it("does not touch the memory switches for a non-memory change", () => {
    const patch = roomSettingsPatch(undefined, { instructions: " hi " })
    expect(patch).toEqual({ roomSettings: { instructions: "hi" } })
    expect("memoryUse" in patch).toBe(false)
  })

  it("dedupes muted ids on write", () => {
    expect(roomSettingsPatch({}, { mutedMemberIds: ["a", "a"] })).toEqual({
      roomSettings: { mutedMemberIds: ["a"] },
    })
  })
})

describe("prompt and row helpers", () => {
  it("renders an instructions section only when there is text", () => {
    expect(buildRoomInstructionsSection("   ")).toBe("")
    expect(buildRoomInstructionsSection("Be brief.")).toBe("## Room instructions\n\nBe brief.")
  })

  it("mints multi-human rooms with memory off and team rooms untouched", () => {
    expect(initialRoomMemoryFields("im")).toEqual({ memoryUse: false, memoryLearn: false })
    expect(initialRoomMemoryFields("shared")).toEqual({ memoryUse: false, memoryLearn: false })
    expect(initialRoomMemoryFields("team")).toEqual({})
    expect(initialRoomMemoryFields(null)).toEqual({})
  })
})

describe("resolveAutoRoundBudget", () => {
  it.each([
    [undefined, 0],
    [0, 0],
    [-2, 0],
    [Number.NaN, 0],
    [2.7, 2],
    [MAX_AUTO_ROUNDS, MAX_AUTO_ROUNDS],
    // A row written before the ceiling, or imported, never buys more rounds.
    [99, MAX_AUTO_ROUNDS],
    [Number.POSITIVE_INFINITY, 0],
  ])("%p rounds → %p", (stored, budget) => {
    expect(resolveAutoRoundBudget(stored)).toBe(budget)
  })
})
