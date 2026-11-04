import { DEFAULT_RUNTIME_POLICY } from "./runtime-policy"
it("requires no extra capability from legacy or plugin adapters", () => {
  expect(Object.isFrozen(DEFAULT_RUNTIME_POLICY)).toBe(true)
  expect(DEFAULT_RUNTIME_POLICY.processWriteScope).toBeUndefined()
  expect(DEFAULT_RUNTIME_POLICY.requestedWritableRoots).toBeUndefined()
})
