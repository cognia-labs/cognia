import { undoUnavailableKey } from "./irreversible-reason"

describe("undoUnavailableKey", () => {
  it("returns null while the patch can be undone", () => {
    expect(undoUnavailableKey(null)).toBeNull()
    expect(undoUnavailableKey(undefined)).toBeNull()
    expect(undoUnavailableKey({ reversible: true })).toBeNull()
    expect(undoUnavailableKey({ reversible: true, irreversibleReason: "overlap" })).toBeNull()
  })

  it.each([
    ["capacity", "undoUnavailableIrreversible"],
    ["stopUnproven", "undoUnavailableStopUnproven"],
    ["overlap", "undoUnavailableOverlap"],
    ["pathUnsupported", "undoUnavailablePathUnsupported"],
    ["fidelityUnknown", "undoUnavailableFidelityUnknown"],
  ] as const)("explains %s with its own message", (irreversibleReason, key) => {
    expect(undoUnavailableKey({ reversible: false, irreversibleReason })).toBe(key)
  })

  it("keeps a patch without a known reason irreversible", () => {
    expect(undoUnavailableKey({ reversible: false })).toBe("undoUnavailableUnknownReason")
    expect(undoUnavailableKey({ reversible: false, irreversibleReason: null })).toBe(
      "undoUnavailableUnknownReason"
    )
    expect(undoUnavailableKey({ reversible: false, irreversibleReason: "later" as never })).toBe(
      "undoUnavailableUnknownReason"
    )
  })
})
