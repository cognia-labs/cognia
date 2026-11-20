import {
  DEFAULT_DOCUMENT_LIMITS,
  DocumentBudget,
  DocumentLimitError,
  inputByteLength,
} from "./limits"

describe("document limits", () => {
  it("counts a string by its UTF-8 bytes and an ArrayBuffer by its length", () => {
    expect(inputByteLength("abc")).toBe(3)
    expect(inputByteLength("中文")).toBe(6)
    expect(inputByteLength(new ArrayBuffer(5))).toBe(5)
  })

  it("refuses the reservation that would cross the budget, with its numbers", () => {
    const budget = new DocumentBudget("expanded-cells", 10)
    budget.take(6)
    budget.take(4)

    let error: unknown
    try {
      budget.take(1)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DocumentLimitError)
    expect(error).toMatchObject({ scope: "expanded-cells", limit: 10, observed: 11 })
    expect((error as { diagnostic?: unknown }).diagnostic).toMatchObject({
      code: "limit_exceeded",
      severity: "error",
    })
  })

  it("refuses a non-finite or negative count instead of letting it through", () => {
    const budget = new DocumentBudget("slides", 5)
    expect(() => budget.take(Number.NaN)).toThrow(DocumentLimitError)
    expect(() => budget.take(Number.POSITIVE_INFINITY)).toThrow(DocumentLimitError)
    expect(() => budget.take(-1)).toThrow(DocumentLimitError)
  })

  it("keeps the shared defaults positive", () => {
    expect(DEFAULT_DOCUMENT_LIMITS.maxInputBytes).toBe(50 * 1024 * 1024)
    expect(DEFAULT_DOCUMENT_LIMITS.maxExpandedCells).toBeGreaterThan(0)
    expect(DEFAULT_DOCUMENT_LIMITS.maxSlides).toBeGreaterThan(0)
  })
})
