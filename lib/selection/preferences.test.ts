import {
  parseSelectionToolbarMode,
  normalizeHostnameRules,
  normalizeSelectionActionLayout,
} from "./preferences"

describe("parseSelectionToolbarMode", () => {
  it("keeps a valid persisted mode", () => {
    expect(parseSelectionToolbarMode("manual")).toBe("manual")
    expect(parseSelectionToolbarMode("automatic")).toBe("automatic")
    expect(parseSelectionToolbarMode("off")).toBe("off")
  })

  it("fails closed for an absent or malformed persisted mode", () => {
    expect(parseSelectionToolbarMode(undefined)).toBe("off")
    expect(parseSelectionToolbarMode(null)).toBe("off")
    expect(parseSelectionToolbarMode("always")).toBe("off")
  })
})

describe("normalizeHostnameRules", () => {
  it("stores only normalized hostname rules", () => {
    expect(
      normalizeHostnameRules([
        "Example.COM",
        "*.Docs.Example.com",
        "https://accounts.example.com/path?token=secret#fragment",
        "example.com",
        "not a host",
        "https://user:pass@example.net/private",
      ])
    ).toEqual(["example.com", "*.docs.example.com", "accounts.example.com", "example.net"])
  })

  it("rejects ports, non-http schemes, blanks, and malformed wildcard rules", () => {
    expect(
      normalizeHostnameRules([
        "",
        "https://example.com:8443",
        "file:///tmp/private",
        "*.not a host",
      ])
    ).toEqual([])
  })
})

describe("normalizeSelectionActionLayout", () => {
  it("deduplicates ids and retains disabled-plugin layout entries", () => {
    expect(
      normalizeSelectionActionLayout({
        ordered: ["copy", "plugin:a", "copy"],
        hidden: ["plugin:b", "plugin:b"],
        pinned: ["plugin:a", "plugin:a"],
      })
    ).toEqual({
      ordered: ["copy", "plugin:a"],
      hidden: ["plugin:b"],
      pinned: ["plugin:a"],
    })
  })

  it("fails closed for malformed persisted layout values", () => {
    expect(normalizeSelectionActionLayout(null)).toEqual({
      ordered: [],
      hidden: [],
      pinned: [],
    })
    expect(normalizeSelectionActionLayout({ ordered: ["copy", "", 42], hidden: "copy" })).toEqual({
      ordered: ["copy"],
      hidden: [],
      pinned: [],
    })
  })
})
