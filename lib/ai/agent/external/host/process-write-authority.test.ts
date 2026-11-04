import { acquireProcessWriteScope } from "./process-write-authority"
it("does not manufacture a writable grant for a missing or unsupported runtime", async () => {
  const host = { policy: {}, scopes: new Map() } as never
  const result = await acquireProcessWriteScope("plugin:custom", undefined, host)
  expect(result.options).toBeUndefined()
  expect(result.release()).toBeUndefined()
})
