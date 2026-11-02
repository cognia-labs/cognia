import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests, googleState } from "./state"
import { completeGoogleDocsAuth, disconnectGoogleDocs } from "./auth"

afterEach(() => __setGoogleStatePortForTests(null))

it("preserves native stale-callback rejection after disconnect without renderer storage fallback", async () => {
  const host = createGoogleDocsTestHost()
  host.handle = async (input) => {
    if (input.action === "complete") throw new Error("google_docs_state_stale")
    return { ...host.snapshot, outcome: { revoked: true } }
  }
  __setGoogleStatePortForTests(host.call)
  await disconnectGoogleDocs("original")
  await expect(completeGoogleDocsAuth({ state: "google:old", code: "old" })).rejects.toMatchObject({
    code: "notAuthorized",
    params: { reason: "connection changed" },
  })
  expect(host.calls.map((input) => input.action)).toEqual(["disconnect", "complete"])
})

it("leaves refresh and credential revisions entirely with the native AccessToken action", async () => {
  const host = createGoogleDocsTestHost()
  host.handle = async (input) =>
    input.action === "accessToken"
      ? {
          ...host.snapshot,
          credential: {
            accessToken: "ephemeral-access",
            expiresAt: 100,
            revision: "r1",
            credentialRevision: "c2",
          },
        }
      : undefined
  __setGoogleStatePortForTests(host.call)
  await expect(
    googleState({ action: "accessToken", lineageId: "original", minValidityMs: 60_000 })
  ).resolves.toMatchObject({ credential: { revision: "r1", credentialRevision: "c2" } })
  const snapshot = await googleState({ action: "snapshot" })
  expect(snapshot).not.toHaveProperty("credential")
  expect(JSON.stringify(snapshot)).not.toContain("ephemeral-access")
})
