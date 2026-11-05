import {
  findInlineLinks,
  getInlineLinkKind,
  getInlineLinksRevision,
  notifyInlineLinksChanged,
  registerInlineLinkKind,
  resolveInlineLinkHref,
  subscribeInlineLinks,
  type InlineLinkKind,
} from "./inline-links"

function kind(id: string, pattern: RegExp, over: Partial<InlineLinkKind> = {}): InlineLinkKind {
  return {
    id,
    pattern,
    matches: () => true,
    href: (text) => `/${id}?ref=${text}`,
    parseHref: (href) => (href.startsWith(`/${id}?ref=`) ? href.slice(id.length + 6) : undefined),
    accepts: () => true,
    ...over,
  }
}

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
function register(value: InlineLinkKind) {
  disposers.push(registerInlineLinkKind(value))
  return value
}

describe("inline link registry", () => {
  it("finds well-formed candidates in order and drops overlaps", () => {
    register(kind("issue", /\b[A-Z]{2,5}-\d+\b/g, { matches: (text) => !text.endsWith("-0") }))
    register(kind("ticket", /#\d+-\d+/g))
    const found = findInlineLinks("see MERC-12, MERC-0 and #3-4 then AB-1")
    expect(found.map((match) => [match.kind.id, match.text, match.start])).toEqual([
      ["issue", "MERC-12", 4],
      ["ticket", "#3-4", 24],
      ["issue", "AB-1", 34],
    ])
  })

  it("keeps the earlier match when two kinds overlap", () => {
    register(kind("a", /AB-\d+/g))
    register(kind("b", /B-\d+ x/g))
    expect(findInlineLinks("AB-1 x").map((match) => match.kind.id)).toEqual(["a"])
  })

  it("resolves an address back to its kind and reference", () => {
    const issue = register(kind("issue", /x/g))
    expect(resolveInlineLinkHref("/issue?ref=MERC-1")).toEqual({ kind: issue, text: "MERC-1" })
    expect(resolveInlineLinkHref("https://example.com")).toBeUndefined()
  })

  it("refuses a pattern that is not global", () => {
    expect(() => registerInlineLinkKind(kind("bad", /x/))).toThrow(/must be global/)
  })

  it("notifies subscribers on registration, removal and a kind's change", () => {
    const listener = jest.fn()
    const stop = subscribeInlineLinks(listener)
    const before = getInlineLinksRevision()
    const dispose = registerInlineLinkKind(kind("issue", /x/g))
    notifyInlineLinksChanged()
    dispose()
    dispose()
    stop()
    notifyInlineLinksChanged()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(getInlineLinksRevision()).toBe(before + 4)
    expect(getInlineLinkKind("issue")).toBeUndefined()
  })

  it("a stale disposer does not remove a newer registration of the same id", () => {
    const first = registerInlineLinkKind(kind("issue", /x/g))
    const second = register(kind("issue", /y/g))
    first()
    expect(getInlineLinkKind("issue")).toBe(second)
  })
})
