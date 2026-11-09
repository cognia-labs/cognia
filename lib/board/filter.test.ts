import {
  applyFacetFilter,
  collectFacetValues,
  countActiveFacets,
  isFacetFilterActive,
  type BoardFilterSpec,
} from "./filter"

interface Row {
  id: string
  title: string
  tags: string[]
  priority: string
  owner?: string
}

interface Filter {
  query: string
  tags: string[]
  priorities: string[]
  owners?: string[]
}

const rows: Row[] = [
  { id: "1", title: "Fix Login", tags: ["auth", "bug"], priority: "high", owner: "ann" },
  { id: "2", title: "Write docs", tags: ["docs"], priority: "low" },
  { id: "3", title: "Login copy", tags: [], priority: "high", owner: "bob" },
]

const EMPTY: Filter = { query: "", tags: [], priorities: [] }

const spec: BoardFilterSpec<Row, Filter> = {
  query: {
    read: (filter) => filter.query,
    matches: (row, needle) => row.title.toLowerCase().includes(needle),
  },
  facets: [
    { selected: (filter) => filter.tags, values: (row) => row.tags },
    { selected: (filter) => filter.priorities, values: (row) => row.priority },
    { selected: (filter) => filter.owners, values: (row) => row.owner },
  ],
}

const ids = (list: Row[]) => list.map((row) => row.id)

describe("facet filter", () => {
  it("is inactive and keeps everything (as a copy) when nothing is engaged", () => {
    expect(isFacetFilterActive(EMPTY, spec)).toBe(false)
    expect(isFacetFilterActive({ ...EMPTY, query: "   " }, spec)).toBe(false)
    const kept = applyFacetFilter(rows, EMPTY, spec)
    expect(kept).toEqual(rows)
    expect(kept).not.toBe(rows)
  })

  it("counts the query and each engaged facet once", () => {
    expect(countActiveFacets(EMPTY, spec)).toBe(0)
    expect(
      countActiveFacets({ query: " x ", tags: ["a", "b"], priorities: [], owners: ["ann"] }, spec)
    ).toBe(3)
  })

  it("matches the query trimmed and case-insensitively", () => {
    expect(ids(applyFacetFilter(rows, { ...EMPTY, query: "  LOGIN " }, spec))).toEqual(["1", "3"])
  })

  it("keeps an item when any of its values is selected", () => {
    expect(ids(applyFacetFilter(rows, { ...EMPTY, tags: ["bug", "docs"] }, spec))).toEqual([
      "1",
      "2",
    ])
    expect(ids(applyFacetFilter(rows, { ...EMPTY, priorities: ["high"] }, spec))).toEqual([
      "1",
      "3",
    ])
  })

  it("drops an item with no value for an engaged facet", () => {
    expect(ids(applyFacetFilter(rows, { ...EMPTY, owners: ["ann", "bob"] }, spec))).toEqual([
      "1",
      "3",
    ])
    expect(ids(applyFacetFilter(rows, { ...EMPTY, tags: ["auth", "docs", "x"] }, spec))).toEqual([
      "1",
      "2",
    ])
  })

  it("combines the query and facets with AND", () => {
    expect(
      ids(applyFacetFilter(rows, { ...EMPTY, query: "login", owners: ["bob"] }, spec))
    ).toEqual(["3"])
  })

  it("works without a query rule", () => {
    const facetsOnly: BoardFilterSpec<Row, Filter> = { facets: spec.facets }
    expect(isFacetFilterActive({ ...EMPTY, query: "login" }, facetsOnly)).toBe(false)
    expect(applyFacetFilter(rows, { ...EMPTY, query: "login" }, facetsOnly)).toHaveLength(3)
  })

  it("collects the distinct values of a facet, sorted, skipping empties", () => {
    expect(collectFacetValues(rows, (row) => row.tags)).toEqual(["auth", "bug", "docs"])
    expect(collectFacetValues(rows, (row) => row.owner)).toEqual(["ann", "bob"])
  })
})
