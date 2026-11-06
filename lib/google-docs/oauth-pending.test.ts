import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "@/lib/auth-providers/google/state"
import { clearGoogleOAuthPending, getGoogleOAuthPending } from "./oauth-pending"

afterEach(() => __setGoogleStatePortForTests(null))
it("filters expired metadata and cancels a named Host attempt without exposing PKCE", async () => {
  const host = createGoogleDocsTestHost({
    pending: [
      { attemptId: "old", clientId: "client", method: "loopback-pkce", expiresAt: 99 },
      { attemptId: "current", clientId: "client", method: "loopback-pkce", expiresAt: 100 },
    ],
  })
  __setGoogleStatePortForTests(host.call)
  expect(await getGoogleOAuthPending(100, { localAuthorization: LOCAL_PERSON_RUN })).toEqual([
    host.snapshot.pending[1],
  ])
  await clearGoogleOAuthPending("current")
  expect(await getGoogleOAuthPending(100, { localAuthorization: LOCAL_PERSON_RUN })).toEqual([])
  expect(host.calls).toContainEqual({ action: "cancel", attemptId: "current" })
})
