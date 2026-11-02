jest.mock("@/lib/auth-providers/google/host-auth", () => ({
  listGoogleConnections: jest.fn(),
  resolveGoogleConnection: jest.fn(),
}))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({ getConnectionManager: jest.fn() }))
jest.mock("./state", () => ({ subscribeGoogleStateChanged: jest.fn(() => jest.fn()) }))
import {
  listGoogleConnections,
  resolveGoogleConnection,
} from "@/lib/auth-providers/google/host-auth"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import { resolveDocsAccountBinding } from "@/lib/docs-providers/account-binding"
import type { GoogleHttpFn } from "./http"
import { MAX_DOC_CHARS } from "@/lib/docs-providers/limits"
import { GOOGLE_DOCS_SCOPES } from "./config"
import { __setGoogleProviderDepsForTests, googleDocsProvider } from "./index"

const ID = "1AbC_dEfGhIjKlMnOpQrStUvWxYz012345"
let connections: AuthConnectionRow[]
const getCredentials = jest.fn()
function stubHttp(routes: Array<[string, { status?: number; body: string }]>) {
  const urls: string[] = []
  const http: GoogleHttpFn = async (req) => {
    urls.push(req.url)
    const hit = routes.find(([match]) => req.url.includes(match))
    if (!hit) throw new Error(`unexpected ${req.url}`)
    return { status: hit[1].status ?? 200, headers: {}, body: hit[1].body }
  }
  __setGoogleProviderDepsForTests({ http })
  return urls
}
beforeEach(() => {
  jest.clearAllMocks()
  connections = [
    {
      id: "connection",
      accountLabel: "person@example.com",
      revision: 1,
      status: "connected",
      scopes: [...GOOGLE_DOCS_SCOPES],
    } as AuthConnectionRow,
  ]
  jest.mocked(listGoogleConnections).mockImplementation(async () => connections)
  jest.mocked(resolveGoogleConnection).mockImplementation(async (ref, revision) => {
    const row = connections.find(
      (row) =>
        row.id === ref &&
        row.status === "connected" &&
        (revision === undefined || row.revision === revision)
    )
    if (!row) throw new Error("connection changed")
    return { ...row }
  })
  getCredentials.mockResolvedValue({ accessToken: "ephemeral-access" })
  jest
    .mocked(getConnectionManager)
    .mockReturnValue({ getCredentials, onDidChange: jest.fn(() => jest.fn()) } as never)
  __setGoogleProviderDepsForTests({})
})
afterEach(() => __setGoogleProviderDepsForTests({}))

it("projects only connected Google connections granting all Docs scopes", async () => {
  connections.push(
    { ...connections[0], id: "backup", scopes: ["drive.file"] } as AuthConnectionRow,
    { ...connections[0], id: "reconnect", status: "needs-reauth" } as AuthConnectionRow
  )
  expect(await googleDocsProvider.listAccounts()).toEqual([
    { id: "connection", label: "person@example.com", authorizationEpoch: "1" },
  ])
  expect(googleDocsProvider.hosts).toEqual(["tauri"])
  expect(googleDocsProvider.kinds).toEqual(["doc", "sheet"])
  expect(googleDocsProvider.mentionPrefix).toBe("gdoc:")
})

it("resolves legacy default only to the single Docs connection through the provider hook", async () => {
  expect(
    await resolveDocsAccountBinding(googleDocsProvider, {
      accountId: "default",
      authorizationEpoch: "old-native-nonce",
    })
  ).toEqual({ accountId: "connection", authorizationEpoch: "1" })
  connections.push({ ...connections[0], id: "another" } as AuthConnectionRow)
  expect(
    await resolveDocsAccountBinding(googleDocsProvider, { accountId: "default" })
  ).toBeUndefined()
  connections = []
  expect(
    await resolveDocsAccountBinding(googleDocsProvider, { accountId: "default" })
  ).toBeUndefined()
})

it("keeps exact connection bindings strict across reauthorization", async () => {
  expect(
    await resolveDocsAccountBinding(googleDocsProvider, {
      accountId: "connection",
      authorizationEpoch: "old",
    })
  ).toBeUndefined()
})

it("recognizes Docs and Sheets URLs but no unsupported presentation", () => {
  expect(googleDocsProvider.matchRef(`https://docs.google.com/document/d/${ID}/edit?x=1`)).toEqual({
    kind: "doc",
    id: ID,
    url: `https://docs.google.com/document/d/${ID}/edit`,
  })
  expect(googleDocsProvider.matchRef(`https://docs.google.com/spreadsheets/d/${ID}`)?.kind).toBe(
    "sheet"
  )
  expect(googleDocsProvider.matchRef(`https://docs.google.com/presentation/d/${ID}`)).toBeNull()
})

it("reads through the Host credential driver and resolves a real document title", async () => {
  const urls = stubHttp([
    ["/export?", { body: "# Spec\nbody" }],
    ["/files/", { body: JSON.stringify({ name: "Spec" }) }],
  ])
  const result = await googleDocsProvider.fetch(
    { providerId: "google", kind: "doc", id: ID, title: ID },
    { accountId: "connection", expectedAuthorizationEpoch: "1" }
  )
  expect(result).toMatchObject({
    title: "Spec",
    text: "# Spec\nbody",
    format: "markdown",
    truncated: false,
  })
  expect(getCredentials).toHaveBeenCalledWith("connection", { minValidityMs: 60_000 })
  expect(urls.some((url) => url.includes("fields=name"))).toBe(true)
})

it("returns an actual connection binding when a stored default ref is reopened", async () => {
  stubHttp([["/export?", { body: "body" }]])
  const result = await googleDocsProvider.fetch(
    {
      providerId: "google",
      kind: "doc",
      id: ID,
      title: "Spec",
      accountBinding: { accountId: "default", authorizationEpoch: "legacy" },
    },
    { accountId: "default" }
  )
  expect(result.ref.accountBinding).toEqual({ accountId: "connection", authorizationEpoch: "1" })
})

it.each(["wrong-account", "old-revision", "revoked", "scope", "ambiguous-default"])(
  "refuses %s before acquiring a credential",
  async (reason) => {
    const urls = stubHttp([["/export?", { body: "body" }]])
    if (reason === "revoked") connections[0].status = "needs-reauth"
    if (reason === "scope") connections[0].scopes = []
    if (reason === "ambiguous-default")
      connections.push({ ...connections[0], id: "other" } as AuthConnectionRow)
    await expect(
      googleDocsProvider.fetch(
        { providerId: "google", kind: "doc", id: ID, title: "Spec" },
        {
          accountId:
            reason === "wrong-account"
              ? "missing"
              : reason === "ambiguous-default"
                ? "default"
                : "connection",
          expectedAuthorizationEpoch: reason === "old-revision" ? "0" : undefined,
        }
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
    expect(getCredentials).not.toHaveBeenCalled()
    expect(urls).toEqual([])
  }
)

it.each(["doc", "sheet", "search"])(
  "drops a delayed %s read after its connection revision moves",
  async (operation) => {
    let finish!: () => void
    const http: GoogleHttpFn = async (req) => {
      if (operation === "sheet" && !req.url.includes("values:batchGet"))
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            properties: { title: "Sheet" },
            sheets: [{ properties: { title: "Q3" } }],
          }),
        }
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        status: 200,
        headers: {},
        body:
          operation === "doc"
            ? "old body"
            : JSON.stringify(
                operation === "sheet"
                  ? { valueRanges: [{ values: [["old"]] }] }
                  : {
                      files: [
                        { id: ID, name: "Spec", mimeType: "application/vnd.google-apps.document" },
                      ],
                    }
              ),
      }
    }
    __setGoogleProviderDepsForTests({ http })
    const opts = { accountId: "connection", expectedAuthorizationEpoch: "1", limit: 20 }
    const pending =
      operation === "search"
        ? googleDocsProvider.search!("spec", opts)
        : googleDocsProvider.fetch(
            { providerId: "google", kind: operation as "doc" | "sheet", id: ID, title: "Spec" },
            opts
          )
    for (let i = 0; i < 40 && !finish; i++) await Promise.resolve()
    expect(finish).toBeDefined()
    connections[0].revision = 2
    finish()
    await expect(pending).rejects.toMatchObject({ code: "notAuthorized" })
  }
)

it("drops an identity change during credential acquisition before any HTTP", async () => {
  let finish!: (value: { accessToken: string }) => void
  getCredentials.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const http = jest.fn()
  __setGoogleProviderDepsForTests({ http })
  const pending = googleDocsProvider.fetch(
    { providerId: "google", kind: "doc", id: ID, title: "Spec" },
    { accountId: "connection" }
  )
  for (let i = 0; i < 30 && !finish; i++) await Promise.resolve()
  expect(finish).toBeDefined()
  connections[0].revision = 2
  finish({ accessToken: "old" })
  await expect(pending).rejects.toMatchObject({ code: "notAuthorized" })
  expect(http).not.toHaveBeenCalled()
})

it("does not invalidate a read when only credentials rotate", async () => {
  stubHttp([["/export?", { body: "body" }]])
  connections[0].credentialRevision = 4
  expect(
    (
      await googleDocsProvider.fetch(
        { providerId: "google", kind: "doc", id: ID, title: "Spec" },
        { accountId: "connection", expectedAuthorizationEpoch: "1" }
      )
    ).text
  ).toBe("body")
})

it("clamps large Docs and rejects empty or unsupported content", async () => {
  stubHttp([["/export?", { body: "x".repeat(MAX_DOC_CHARS + 1) }]])
  expect(
    (
      await googleDocsProvider.fetch(
        { providerId: "google", kind: "doc", id: ID, title: "Spec" },
        { accountId: "connection" }
      )
    ).truncated
  ).toBe(true)
  stubHttp([["/export?", { body: "   " }]])
  await expect(
    googleDocsProvider.fetch(
      { providerId: "google", kind: "doc", id: ID, title: "Spec" },
      { accountId: "connection" }
    )
  ).rejects.toMatchObject({ code: "empty" })
  await expect(
    googleDocsProvider.fetch(
      { providerId: "google", kind: "bitable", id: ID, title: "Spec" },
      { accountId: "connection" }
    )
  ).rejects.toMatchObject({ code: "unsupportedType" })
})

it("reads visible Sheet cells as CSV and returns search refs", async () => {
  stubHttp([
    ["values:batchGet", { body: JSON.stringify({ valueRanges: [{ values: [["a", "b"]] }] }) }],
    [
      "spreadsheets/",
      {
        body: JSON.stringify({
          properties: { title: "Budget" },
          sheets: [{ properties: { title: "Q3" } }],
        }),
      },
    ],
  ])
  expect(
    await googleDocsProvider.fetch(
      { providerId: "google", kind: "sheet", id: ID, title: ID },
      { accountId: "connection" }
    )
  ).toMatchObject({ title: "Budget", format: "csv", text: "## Q3\na,b" })
  stubHttp([
    [
      "/files?",
      {
        body: JSON.stringify({
          files: [{ id: ID, name: "Spec", mimeType: "application/vnd.google-apps.document" }],
        }),
      },
    ],
  ])
  expect(await googleDocsProvider.search!("spec", { accountId: "connection", limit: 5 })).toEqual([
    {
      providerId: "google",
      kind: "doc",
      id: ID,
      title: "Spec",
      url: `https://docs.google.com/document/d/${ID}/edit`,
    },
  ])
})

it("preserves permission errors from document readers", async () => {
  stubHttp([["/export?", { status: 403, body: JSON.stringify({ error: { message: "nope" } }) }]])
  await expect(
    googleDocsProvider.fetch(
      { providerId: "google", kind: "doc", id: ID, title: "Spec" },
      { accountId: "connection" }
    )
  ).rejects.toMatchObject({ code: "noPermission" })
})

it("does not acquire credentials for pre-aborted requests and releases pending acquisition on abort", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    googleDocsProvider.search!("q", {
      accountId: "connection",
      limit: 20,
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(getCredentials).not.toHaveBeenCalled()
  const pendingController = new AbortController()
  getCredentials.mockImplementationOnce(() => new Promise(() => undefined))
  const searching = googleDocsProvider.search!("q", {
    accountId: "connection",
    limit: 20,
    signal: pendingController.signal,
  })
  pendingController.abort()
  await expect(searching).rejects.toMatchObject({ name: "AbortError" })
})
