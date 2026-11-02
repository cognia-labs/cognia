import { ExternalSyncCursorInvalid, ExternalSyncRateLimited } from "./types"
it("uses typed failures without accepting service error messages", () => {
  expect(new ExternalSyncCursorInvalid()).toBeInstanceOf(Error)
  const error = new ExternalSyncRateLimited(5000)
  expect(error).toBeInstanceOf(Error)
  expect(error.retryAfterMs).toBe(5000)
})
