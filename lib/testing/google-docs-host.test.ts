import { createGoogleDocsTestHost } from "./google-docs-host"

it("models the new Host metadata protocol without echoing write-only credentials", async () => {
  const host = createGoogleDocsTestHost()
  await host.call({ action: "setClientSecret", clientId: "docs", secret: "private-client-secret" })
  const reply = await host.call({ action: "snapshot" })
  expect(reply.clients).toEqual([{ clientId: "docs", hasClientSecret: true }])
  expect(JSON.stringify(reply)).not.toContain("private-client-secret")
  await host.call({ action: "clearClientSecret", clientId: "docs" })
  expect((await host.call({ action: "snapshot" })).clients[0].hasClientSecret).toBe(false)
})

it("shares pending metadata and cancellation across frontend callers", async () => {
  const host = createGoogleDocsTestHost()
  const begun = await host.call({ action: "begin", clientId: "docs", scopes: ["docs:read"] })
  expect(begun.attempt?.authorizeUrl).toContain("accounts.google.com")
  expect((await host.call({ action: "snapshot" })).pending).toHaveLength(1)
  await host.call({ action: "cancel", attemptId: begun.attempt!.attemptId })
  expect((await host.call({ action: "snapshot" })).pending).toEqual([])
  expect(JSON.stringify(begun)).not.toMatch(/codeVerifier|refreshToken/)
})
