import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
import { getSettings, saveSettings } from "@/lib/db/settings"
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "./state"
import {
  GOOGLE_DOCS_SCOPES,
  GOOGLE_DOCS_SCOPE_STRING,
  clearGoogleClientSecret,
  getGoogleDocsSettings,
  saveGoogleClientSecret,
  subscribeGoogleDocsSettings,
  updateGoogleDocsSettings,
} from "./config"

let host: ReturnType<typeof createGoogleDocsTestHost>
beforeEach(() => {
  jest.clearAllMocks()
  host = createGoogleDocsTestHost()
  __setGoogleStatePortForTests(host.call)
  jest
    .mocked(getSettings)
    .mockResolvedValue({ docsProviders: { google: { clientId: "client" } } } as never)
  jest.mocked(saveSettings).mockImplementation(async (input) => {
    const current = await getSettings()
    return { ...current, ...(typeof input === "function" ? input(current) : input) }
  })
})
afterEach(() => __setGoogleStatePortForTests(null))

it("requests only the three purpose read scopes", () => {
  expect(GOOGLE_DOCS_SCOPES).toEqual([
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ])
  expect(GOOGLE_DOCS_SCOPE_STRING).toBe(GOOGLE_DOCS_SCOPES.join(" "))
})

it("sends the preference hint for native migration and derives readiness from metadata", async () => {
  host.snapshot.lineages.push({
    id: "lineage",
    clientId: "client",
    method: "loopback-pkce",
    scopes: [...GOOGLE_DOCS_SCOPES],
    sub: "person",
    email: "person@example.com",
    status: "connected",
    revision: "r1",
    credentialRevision: "c1",
    needsIdentity: false,
  })
  expect(await getGoogleDocsSettings({ localAuthorization: LOCAL_PERSON_RUN })).toMatchObject({
    clientId: "client",
    connected: true,
    accountEmail: "person@example.com",
    grantedScopes: GOOGLE_DOCS_SCOPE_STRING,
  })
  expect(host.calls).toContainEqual({ action: "snapshot", legacyClientId: "client" })
  host.snapshot.lineages[0].status = "needs-reauth"
  expect(await getGoogleDocsSettings({ localAuthorization: LOCAL_PERSON_RUN })).toMatchObject({
    connected: false,
  })
})

it("does not trust stale preferences while the credential owner cannot confirm them", async () => {
  jest.mocked(getSettings).mockResolvedValue({
    docsProviders: { google: { clientId: "client", connected: true } },
  } as never)
  host.handle = async () => {
    throw new Error("Host unavailable")
  }
  expect(await getGoogleDocsSettings({ localAuthorization: LOCAL_PERSON_RUN })).toEqual({
    clientId: "client",
    connected: false,
  })
})

it("survives a settings read failure", async () => {
  jest.mocked(getSettings).mockRejectedValue(new Error("db closed"))
  expect(await getGoogleDocsSettings({ localAuthorization: LOCAL_PERSON_RUN })).toMatchObject({
    connected: false,
  })
})

it("writes and clears client-keyed secrets through Rust and never reads a secret", async () => {
  await saveGoogleClientSecret("private", "other-client")
  expect(host.calls).toEqual([
    { action: "setClientSecret", clientId: "other-client", secret: "private" },
  ])
  await clearGoogleClientSecret("other-client")
  expect(host.calls[1]).toEqual({ action: "clearClientSecret", clientId: "other-client" })
  expect(JSON.stringify(await host.call({ action: "snapshot" }))).not.toContain("private")
})

it("uses the configured id when saving a secret and refuses an absent client", async () => {
  await saveGoogleClientSecret("private")
  expect(host.calls).toContainEqual({
    action: "setClientSecret",
    clientId: "client",
    secret: "private",
  })
  jest.mocked(getSettings).mockResolvedValue({} as never)
  await expect(saveGoogleClientSecret("private")).rejects.toThrow("client id")
})

it("applies patches through the queued settings updater and preserves sibling providers", async () => {
  jest.mocked(getSettings).mockResolvedValue({
    docsProviders: { google: { clientId: "old" }, future: { connected: true } },
  } as never)
  await updateGoogleDocsSettings({ clientId: "new" }, { localAuthorization: LOCAL_PERSON_RUN })
  expect(saveSettings).toHaveBeenCalledWith(expect.any(Function))
  expect(await jest.mocked(saveSettings).mock.results[0].value).toMatchObject({
    docsProviders: { google: { clientId: "new" }, future: { connected: true } },
  })
})

it("notifies committed settings only and releases observers", async () => {
  const listener = jest.fn()
  const stop = subscribeGoogleDocsSettings(listener, { localAuthorization: LOCAL_PERSON_RUN })
  try {
    await updateGoogleDocsSettings({ clientId: "new" }, { localAuthorization: LOCAL_PERSON_RUN })
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientId: "new", connected: false })
    )
    jest.mocked(saveSettings).mockRejectedValueOnce(new Error("save failed"))
    await expect(
      updateGoogleDocsSettings({ clientId: "bad" }, { localAuthorization: LOCAL_PERSON_RUN })
    ).rejects.toThrow("save failed")
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    await updateGoogleDocsSettings({ clientId: "other" }, { localAuthorization: LOCAL_PERSON_RUN })
    expect(listener).toHaveBeenCalledTimes(1)
  } finally {
    stop()
  }
})

it("does not let an observer undo a committed preference save", async () => {
  const stop = subscribeGoogleDocsSettings(
    () => {
      throw new Error("observer")
    },
    { localAuthorization: LOCAL_PERSON_RUN }
  )
  try {
    await expect(
      updateGoogleDocsSettings({ clientId: "new" }, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({
      clientId: "new",
    })
  } finally {
    stop()
  }
})
