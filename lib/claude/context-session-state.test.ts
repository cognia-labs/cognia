import {
  CONTEXT_SESSION_STATE_LIMIT,
  __resetContextSessionStateForTests,
  forgetContextSessionState,
  readContextSessionState,
  replaceContextSessionState,
} from "./context-session-state"

beforeEach(() => __resetContextSessionStateForTests())

describe("context session state", () => {
  it("reads what the last resolution left, by key", () => {
    replaceContextSessionState("s1", new Map([["kb.reader", { ids: ["a"] }]]))
    expect(readContextSessionState("s1", "kb.reader")).toEqual({ ids: ["a"] })
    expect(readContextSessionState("s1", "kb.other")).toBeUndefined()
    expect(readContextSessionState("s2", "kb.reader")).toBeUndefined()
  })

  it("replaces a conversation's whole entry, and an empty map clears it", () => {
    replaceContextSessionState(
      "s1",
      new Map<string, unknown>([
        ["kb.reader", 1],
        ["pc.scope", 2],
      ])
    )
    replaceContextSessionState("s1", new Map([["kb.reader", 3]]))
    expect(readContextSessionState("s1", "kb.reader")).toBe(3)
    expect(readContextSessionState("s1", "pc.scope")).toBeUndefined()
    replaceContextSessionState("s1", new Map())
    expect(readContextSessionState("s1", "kb.reader")).toBeUndefined()
  })

  it("forgets one torn-down conversation and keeps the others", () => {
    replaceContextSessionState("s1", new Map([["kb.reader", 1]]))
    replaceContextSessionState("s2", new Map([["kb.reader", 2]]))
    forgetContextSessionState("s1")
    expect(readContextSessionState("s1", "kb.reader")).toBeUndefined()
    expect(readContextSessionState("s2", "kb.reader")).toBe(2)
  })

  it("keeps its own copy of the entries", () => {
    const entries = new Map([["kb.reader", 1]])
    replaceContextSessionState("s1", entries)
    entries.set("kb.reader", 2)
    expect(readContextSessionState("s1", "kb.reader")).toBe(1)
  })

  it("drops the least recently resolved conversation past the limit", () => {
    for (let i = 0; i <= CONTEXT_SESSION_STATE_LIMIT; i++)
      replaceContextSessionState(`s${i}`, new Map([["kb.reader", i]]))
    expect(readContextSessionState("s0", "kb.reader")).toBeUndefined()
    expect(readContextSessionState("s1", "kb.reader")).toBe(1)
    // Resolving s1 again makes it the most recent, so s2 goes next.
    replaceContextSessionState("s1", new Map([["kb.reader", "again"]]))
    replaceContextSessionState("late", new Map([["kb.reader", "late"]]))
    expect(readContextSessionState("s1", "kb.reader")).toBe("again")
    expect(readContextSessionState("s2", "kb.reader")).toBeUndefined()
  })
})
