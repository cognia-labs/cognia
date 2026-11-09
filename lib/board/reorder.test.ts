import { renumberColumn } from "./reorder"

describe("renumberColumn", () => {
  const column = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
  ]

  it("moves a row down and returns only the rows whose order changed", () => {
    expect(renumberColumn(column, "a", 2)).toEqual([
      { id: "b", order: 0 },
      { id: "c", order: 1 },
      { id: "a", order: 2 },
    ])
    expect(renumberColumn(column, "a", 1)).toEqual([
      { id: "b", order: 0 },
      { id: "a", order: 1 },
    ])
  })

  it("moves a row up", () => {
    expect(renumberColumn(column, "c", 0)).toEqual([
      { id: "c", order: 0 },
      { id: "a", order: 1 },
      { id: "b", order: 2 },
    ])
  })

  it("is a no-op for an unknown id or an unchanged dense position", () => {
    expect(renumberColumn(column, "zz", 0)).toEqual([])
    expect(renumberColumn(column, "b", 1)).toEqual([])
  })

  it("clamps out-of-range indexes", () => {
    expect(renumberColumn(column, "a", 99)).toEqual(renumberColumn(column, "a", 2))
    expect(renumberColumn(column, "c", -5)).toEqual(renumberColumn(column, "c", 0))
  })

  it("densifies sparse orders even when the row stays put", () => {
    const sparse = [
      { id: "a", order: 0 },
      { id: "b", order: 0 },
      { id: "c", order: 0 },
    ]
    expect(renumberColumn(sparse, "b", 1)).toEqual([
      { id: "b", order: 1 },
      { id: "c", order: 2 },
    ])
  })
})
