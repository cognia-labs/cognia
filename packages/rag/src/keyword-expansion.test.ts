import { buildExpandedKeywordQuery } from "./keyword-expansion"
import { buildExpandedKeywordQuery as expandLegacyRagQuery } from "./query-expansion"
import { buildExpandedKeywordQuery as expandMemoryQuery } from "@cognia/memory/retrieve/query-expansion"

describe.each([
  ["rag", buildExpandedKeywordQuery],
  ["rag compatibility", expandLegacyRagQuery],
  ["memory", expandMemoryQuery],
] as const)("%s buildExpandedKeywordQuery shared behavior", (_name, expand) => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["  zzzqqx  ", "zzzqqx"],
    ["delete a record", "delete a record remove"],
    ["Delete REMOVE", "Delete REMOVE"],
    ["create file", "create file make document"],
    ["find x", "find x search"],
    ["configure app", "configure app setup"],
    ["  delete\tdelete file  ", "delete\tdelete file remove document"],
    ["删除用户记录", "删除用户记录"],
    ["delete_id file.ts", "delete_id file.ts document.ts"],
  ])("preserves deterministic keyword expansion for %j", (query, expected) => {
    expect(expand(query)).toBe(expected)
  })

  it("keeps existing tokens once and appends each new token once", () => {
    const result = expand("CREATE FILE make document")
    expect(result).toBe("CREATE FILE make document")
  })
})

describe("buildExpandedKeywordQuery", () => {
  it("returns blank input unchanged", () => {
    expect(buildExpandedKeywordQuery("")).toBe("")
    expect(buildExpandedKeywordQuery("   ")).toBe("")
  })

  it("keeps the original phrasing as a prefix", () => {
    const out = buildExpandedKeywordQuery("delete a record")
    expect(out.startsWith("delete a record")).toBe(true)
  })

  it("appends only NEW synonym terms (never duplicates base terms)", () => {
    const out = buildExpandedKeywordQuery("remove the record")
    const appended = out.slice("remove the record".length).trim().split(/\s+/).filter(Boolean)
    for (const term of appended) {
      expect(["remove", "the", "record"]).not.toContain(term.toLowerCase())
    }
  })

  it("returns the trimmed base when there are no synonyms to add", () => {
    // A nonsense token has no synonym mapping → nothing appended.
    expect(buildExpandedKeywordQuery("  zzzqqx  ")).toBe("zzzqqx")
  })
})
