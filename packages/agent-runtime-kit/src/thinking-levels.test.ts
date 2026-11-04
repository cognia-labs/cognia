import { clampThinkingLevel } from "./thinking-levels"
it("never raises a requested reasoning level to a more expensive supported value", () => {
  expect(clampThinkingLevel("xhigh", ["off", "high", "max"])).toBe("high")
  expect(clampThinkingLevel("high", ["high", "max"])).toBe("high")
  expect(clampThinkingLevel("unknown", ["off", "high"])).toBeUndefined()
  expect(clampThinkingLevel("high", [])).toBeUndefined()
})
