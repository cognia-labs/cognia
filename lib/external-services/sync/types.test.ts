import { ExternalSyncCursorInvalid, ExternalSyncRateLimited } from "./types"

it("carries a retry interval without exposing provider response content", () => {
  expect(new ExternalSyncCursorInvalid()).toBeInstanceOf(Error)
  const error = new ExternalSyncRateLimited(123_000)
  expect(error).toBeInstanceOf(Error)
  expect(error).toMatchObject({
    name: "ExternalSyncRateLimited",
    retryAfterMs: 123_000,
    message: "External sync rate limited",
  })
})
