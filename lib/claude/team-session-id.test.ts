import {
  SUB_SEPARATOR,
  subSessionId,
  decodeSubSession,
  imRoomMemberSessionId,
  isImRoomMemberSessionId,
  isSubSessionId,
} from "./team-session-id"

describe("team-session-id", () => {
  it("round-trips team session + character through subSessionId/decodeSubSession", () => {
    const sub = subSessionId("sess-1", "char-a", "t1")
    expect(sub).toBe(`sess-1${SUB_SEPARATOR}char-a::t1`)
    expect(decodeSubSession(sub)).toEqual({ teamSessionId: "sess-1", characterId: "char-a" })
  })

  it("decodes ids without a turn suffix", () => {
    expect(decodeSubSession(`sess-1${SUB_SEPARATOR}char-a`)).toEqual({
      teamSessionId: "sess-1",
      characterId: "char-a",
    })
  })

  it("returns null for plain session ids", () => {
    expect(decodeSubSession("sess-1")).toBeNull()
    expect(decodeSubSession("")).toBeNull()
  })

  it("keeps supervisor round suffixes out of the characterId", () => {
    const sub = subSessionId("sess-1", "char-a", "t1r2")
    expect(decodeSubSession(sub)).toEqual({ teamSessionId: "sess-1", characterId: "char-a" })
  })

  it("isSubSessionId matches only sub-session ids", () => {
    expect(isSubSessionId(subSessionId("s", "c", "t"))).toBe(true)
    expect(isSubSessionId("s")).toBe(false)
  })

  it("marks an IM room member's sub-session, which still decodes to its room", () => {
    const id = imRoomMemberSessionId("s-im", "c-1", "m-1.reply-1")
    expect(isImRoomMemberSessionId(id)).toBe(true)
    expect(isSubSessionId(id)).toBe(true)
    expect(decodeSubSession(id)).toEqual({ teamSessionId: "s-im", characterId: "c-1" })
    expect(isImRoomMemberSessionId(subSessionId("s", "c", "t1r1"))).toBe(false)
    expect(isImRoomMemberSessionId(`s${SUB_SEPARATOR}c`)).toBe(false)
    expect(isImRoomMemberSessionId("s")).toBe(false)
  })
})
