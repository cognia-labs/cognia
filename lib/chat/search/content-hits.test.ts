import { contentHitsBySession, NO_CONTENT_HITS } from "./content-hits"

const snippet = (text: string) => ({ text, positions: [0] })

describe("contentHitsBySession", () => {
  it("keeps each conversation's first (best-ranked) hit", () => {
    const hits = contentHitsBySession([
      { sessionId: "a", messageId: "m1", snippet: snippet("best") },
      { sessionId: "b", messageId: "m2", snippet: snippet("other") },
      { sessionId: "a", messageId: "m3", snippet: snippet("worse") },
    ])
    expect(hits.get("a")).toEqual({ messageId: "m1", snippet: snippet("best") })
    expect(hits.get("b")?.messageId).toBe("m2")
    expect(hits.size).toBe(2)
  })

  it("shares one empty map for no results", () => {
    expect(contentHitsBySession([])).toBe(NO_CONTENT_HITS)
  })
})
