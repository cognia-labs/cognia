jest.mock("./config", () => ({
  GOOGLE_DOCS_SCOPES: ["docs:read"],
  getGoogleDocsSettings: jest.fn(async () => ({ clientId: "docs-client" })),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsEnsureServer: jest.fn() }))
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { getGoogleDocsSettings } from "./config"
import { __setGoogleStatePortForTests } from "@/lib/auth-providers/google/state"
import {
  beginGoogleDocsAuth,
  completeGoogleDocsAuth,
  disconnectGoogleDocs,
  GOOGLE_CALLBACK_PATH,
  pollGoogleDeviceAuth,
} from "./auth"

let host: ReturnType<typeof createGoogleDocsTestHost>
beforeEach(() => {
  jest.clearAllMocks()
  host = createGoogleDocsTestHost()
  __setGoogleStatePortForTests(host.call)
  jest.mocked(getGoogleDocsSettings).mockResolvedValue({ clientId: "docs-client" })
})
afterEach(() => __setGoogleStatePortForTests(null))

it("begins in Rust with the actual bound loopback port and purpose scopes", async () => {
  const result = await beginGoogleDocsAuth({
    ensureServer: async () => "127.0.0.1:51234",
    reauthorizeLineage: "lineage",
  })
  expect(host.calls).toEqual([
    {
      action: "begin",
      clientId: "docs-client",
      scopes: ["docs:read"],
      redirectUri: `http://127.0.0.1:51234${GOOGLE_CALLBACK_PATH}`,
      reauthorizeLineage: "lineage",
    },
  ])
  expect(result).toMatchObject({
    attemptId: expect.any(String),
    authorizeUrl: expect.stringContaining("accounts.google.com"),
  })
  expect(JSON.stringify(result)).not.toMatch(/codeVerifier|clientSecret|refreshToken/)
})

it("does not begin without a client id or an available loopback Host", async () => {
  jest.mocked(getGoogleDocsSettings).mockResolvedValue({})
  await expect(beginGoogleDocsAuth()).rejects.toMatchObject({ code: "notConfigured" })
  jest.mocked(getGoogleDocsSettings).mockResolvedValue({ clientId: "client" })
  await expect(
    beginGoogleDocsAuth({
      ensureServer: async () => {
        throw new Error("offline")
      },
    })
  ).rejects.toMatchObject({ code: "hostUnsupported" })
  expect(host.calls).toEqual([])
})

it("forwards callbacks to Rust without any renderer token exchange", async () => {
  host.handle = async () => host.snapshot
  await expect(
    completeGoogleDocsAuth(
      { code: "code", state: "google:state", clientId: "client" },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
  ).resolves.toEqual(host.snapshot)
  expect(host.calls).toEqual([
    { action: "complete", code: "code", state: "google:state", clientId: "client" },
  ])
})

it.each([{ state: "s" }, { code: "c" }, { error: "access_denied", errorDescription: "cancelled" }])(
  "rejects incomplete or denied callbacks %j",
  async (input) => {
    await expect(completeGoogleDocsAuth(input)).rejects.toMatchObject({ code: "notAuthorized" })
    expect(host.calls).toEqual([])
  }
)

it("polls once per caller action so the caller owns cadence", async () => {
  await expect(
    pollGoogleDeviceAuth("attempt", { localAuthorization: LOCAL_PERSON_RUN })
  ).resolves.toMatchObject({ pollStatus: "pending" })
  expect(host.calls).toEqual([{ action: "pollDevice", attemptId: "attempt" }])
})

it("disconnects only the selected lineage and preserves the Host outcome", async () => {
  host.handle = async () => ({ ...host.snapshot, outcome: { revoked: false, reason: "offline" } })
  await expect(
    disconnectGoogleDocs("lineage", { localAuthorization: LOCAL_PERSON_RUN })
  ).resolves.toEqual({
    revoked: false,
    reason: "offline",
  })
  expect(host.calls).toEqual([{ action: "disconnect", lineageId: "lineage" }])
})

it("refuses OAuth userinfo and revocation without Host admission", async () => {
  await expect(completeGoogleDocsAuth({ code: "code", state: "s" })).rejects.toMatchObject({
    name: "PersonalCredentialRefusedError",
  })
  await expect(pollGoogleDeviceAuth("attempt")).rejects.toMatchObject({
    name: "PersonalCredentialRefusedError",
  })
  await expect(disconnectGoogleDocs("lineage")).rejects.toMatchObject({
    name: "PersonalCredentialRefusedError",
  })
  expect(host.calls).toEqual([])
})
