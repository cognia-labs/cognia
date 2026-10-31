import { buildExpandedKeywordQuery } from "./query-expansion"

// Test the public memory compatibility entry with the real RAG synonym engine.
// A mocked expander hid whether this path actually used the shared implementation.
describe("buildExpandedKeywordQuery", () => {
  it("returns an empty string for blank input", () => {
    expect(buildExpandedKeywordQuery("   ")).toBe("")
  })

  it("returns the trimmed base unchanged when there are no variants", () => {
    expect(buildExpandedKeywordQuery("  deploy the app  ")).toBe("deploy the app")
  })

  it("appends NEW synonym terms without repeating base terms", () => {
    const out = buildExpandedKeywordQuery("delete file")
    expect(out).toBe("delete file remove document")
    expect(out.split(/\s+/).filter((term) => term === "file")).toHaveLength(1)
  })

  it("does not append terms already present in the base (case-insensitive)", () => {
    expect(buildExpandedKeywordQuery("Delete REMOVE")).toBe("Delete REMOVE")
  })

  it("retains one-character base tokens without appending them again", () => {
    const out = buildExpandedKeywordQuery("find a x")
    expect(out).toBe("find a x search")
    expect(out.split(/\s+/).filter((term) => term === "a")).toHaveLength(1)
    expect(out.split(/\s+/).filter((term) => term === "x")).toHaveLength(1)
  })
})
