jest.mock("@/lib/connectors/adapters/lark/host-auth", () => ({
  listLarkConnections: jest.fn(),
  larkConnectionAdapter: jest.fn(),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { subscribe: jest.fn(() => jest.fn()) },
  transport: { subscribe: jest.fn(() => jest.fn()) },
}))
jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  ...jest.requireActual("@/lib/connectors/adapters/lark/authed-api"),
  withLarkAuthedApi: jest.fn(),
}))
jest.mock("@/lib/twin/ingest/lark-doc-fetcher", () => ({
  ...jest.requireActual("@/lib/twin/ingest/lark-doc-fetcher"),
  fetchLarkDocAsRawSource: jest.fn(),
}))

import {
  listLarkConnections,
  larkConnectionAdapter,
} from "@/lib/connectors/adapters/lark/host-auth"
import { ConnectionRevisionChanged } from "@/lib/plugin/auth/connection-manager"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  ...jest.requireActual("@/lib/plugin/auth/connection-manager"),
  getConnectionManager: jest.fn(() => ({ onDidChange: jest.fn(() => jest.fn()) })),
}))
import {
  LarkAccessError,
  withLarkAuthedApi,
  type LarkAuthedApi,
} from "@/lib/connectors/adapters/lark/authed-api"
import { LarkApiError } from "@/lib/connectors/adapters/lark/auth-retry"
import { LarkIngestError, fetchLarkDocAsRawSource } from "@/lib/twin/ingest/lark-doc-fetcher"
import { MAX_DOC_CHARS } from "@/lib/docs-providers/limits"
import { DocsProviderError } from "@/lib/docs-providers/types"
import { larkDocsProvider } from "./index"
import { localTransport, transport } from "@/lib/tauri/transport-instance"

const listConnectionsMock = listLarkConnections as jest.Mock
const withAuthMock = withLarkAuthedApi as jest.Mock
const fetchDocMock = fetchLarkDocAsRawSource as jest.Mock

const ACCOUNT = "host-connection-ref"
const ADAPTER = "cai_1"

/**
 * Stubs are written against `unknown` because `LarkAuthedApi`'s methods are
 * generic in their return type — a concrete stub can never satisfy `<T>() => T`,
 * so the cast happens once here rather than at every call site.
 */
interface StubLarkApi {
  get?: (path: string) => Promise<unknown>
  post?: (path: string, body?: unknown) => Promise<unknown>
}

/** Run the provider's callback against a stubbed API, like the real harness does. */
function runWith(api: StubLarkApi) {
  const stub: StubLarkApi = {
    get: async () => {
      throw new Error("unstubbed get")
    },
    post: async () => {
      throw new Error("unstubbed post")
    },
    ...api,
  }
  withAuthMock.mockImplementation(async (_opts: unknown, fn: (a: LarkAuthedApi) => unknown) =>
    fn(stub as unknown as LarkAuthedApi)
  )
}

const connection = {
  id: ACCOUNT,
  providerId: "lark",
  accountLabel: "Ada",
  revision: 1,
  scopes: ["search:docs:read"],
  status: "connected",
  hostMetadata: { adapterId: ADAPTER, authorizationEpoch: "native-a" },
}
beforeEach(() => {
  jest.clearAllMocks()
  listConnectionsMock.mockResolvedValue([connection])
  ;(larkConnectionAdapter as jest.Mock).mockImplementation(async (_ref, revision) => {
    if (revision !== undefined && revision !== 1)
      throw new ConnectionRevisionChanged(ACCOUNT, revision, 1)
    return { connection, adapterId: ADAPTER }
  })
})

describe("larkDocsProvider — shape", () => {
  it("releases an aborted caller while the initial native authorization snapshot is pending", async () => {
    const controller = new AbortController()
    let finish!: (value: unknown) => void
    ;(larkConnectionAdapter as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const reading = larkDocsProvider.fetch(
      { providerId: "lark", kind: "doc", id: "doc", title: "Doc" },
      { accountId: ACCOUNT, signal: controller.signal }
    )
    let settled = false
    const observed = reading.catch((error: unknown) => {
      settled = true
      return error
    })
    controller.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const releasedBeforeSnapshot = settled
    finish({ connection, adapterId: ADAPTER })
    expect(await observed).toMatchObject({ name: "AbortError" })
    expect(releasedBeforeSnapshot).toBe(true)
  })

  it.each(["fetch", "search"])(
    "does not publish %s results after cancellation during the final authorization continuation",
    async (operation) => {
      const controller = new AbortController()
      let snapshots = 0
      ;(larkConnectionAdapter as jest.Mock).mockImplementation(async () => {
        if (++snapshots === 2) queueMicrotask(() => queueMicrotask(() => controller.abort()))
        return { connection, adapterId: ADAPTER }
      })
      fetchDocMock.mockResolvedValue({ title: "Doc", text: "must not publish" })
      withAuthMock.mockResolvedValue([])
      const options = { accountId: ACCOUNT, signal: controller.signal, limit: 20 }
      const reading =
        operation === "fetch"
          ? larkDocsProvider.fetch(
              { providerId: "lark", kind: "doc", id: "doc", title: "Doc" },
              options
            )
          : larkDocsProvider.search!("query", options)
      await expect(reading).rejects.toMatchObject({ name: "AbortError" })
    }
  )

  it("subscribes native authorization events on the local credential host", () => {
    const listener = jest.fn()
    const stop = larkDocsProvider.subscribeAccounts!(listener)
    expect(localTransport.subscribe).toHaveBeenCalledWith(
      "lark-user-authorization-changed",
      listener
    )
    expect(transport.subscribe).not.toHaveBeenCalled()
    const manager = jest.mocked(getConnectionManager).mock.results.at(-1)!.value
    const changed = manager.onDidChange.mock.calls[0][0]
    changed({ providerId: "lark" })
    changed({ providerId: "other" })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    expect(manager.onDidChange.mock.results[0].value).toHaveBeenCalled()
  })

  it("declares a colon-terminated prefix and the four readable kinds", () => {
    expect(larkDocsProvider.id).toBe("lark")
    expect(larkDocsProvider.mentionPrefix).toBe("lark:")
    expect([...larkDocsProvider.kinds].sort()).toEqual(["bitable", "doc", "sheet", "wiki"])
  })

  it("is desktop-only because open.feishu.cn sends no CORS headers", () => {
    expect(larkDocsProvider.hosts).toEqual(["tauri"])
  })
})

describe("larkDocsProvider.listAccounts", () => {
  it("returns connection references and numeric revisions rather than adapter ids", async () => {
    expect(await larkDocsProvider.listAccounts()).toEqual([
      { id: ACCOUNT, label: "Ada", authorizationEpoch: "1", searchable: true },
    ])
    expect(ACCOUNT).not.toBe(ADAPTER)
  })
  it("does not advertise disconnected, unavailable, or needs-reauth connections", async () => {
    listConnectionsMock.mockResolvedValue(
      ["tombstoned", "provider-unavailable", "needs-reauth"].map((status) => ({
        ...connection,
        status,
      }))
    )
    expect(await larkDocsProvider.listAccounts()).toEqual([])
  })
  it("rejects a stale connection revision before reading a document", async () => {
    await expect(
      larkDocsProvider.fetch(
        {
          providerId: "lark",
          id: "doc",
          kind: "doc",
          title: "Old",
          accountBinding: { accountId: ACCOUNT, authorizationEpoch: "2" },
        },
        { accountId: ACCOUNT, expectedAuthorizationEpoch: "2" }
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
    expect(fetchDocMock).not.toHaveBeenCalled()
  })
  it("does not advertise document search without the connected scope", async () => {
    listConnectionsMock.mockResolvedValue([{ ...connection, scopes: [] }])
    expect(await larkDocsProvider.listAccounts()).toEqual([
      expect.objectContaining({ searchable: false }),
    ])
  })
  it("returns no accounts without a Host connection", async () => {
    listConnectionsMock.mockResolvedValue([])
    expect(await larkDocsProvider.listAccounts()).toEqual([])
  })
})

describe("larkDocsProvider.matchRef", () => {
  it.each([
    ["https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890", "doc"],
    ["https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789", "wiki"],
    ["https://acme.feishu.cn/docs/doccnAbCdEfGh1234567890", "doc"],
    ["https://acme.feishu.cn/sheets/shtcnAbCdEfGh1234567890", "sheet"],
    ["https://acme.feishu.cn/base/bascnAbCdEfGh1234567890", "bitable"],
  ])("maps %s to kind %s and keeps the URL", (input, kind) => {
    expect(larkDocsProvider.matchRef(input)).toEqual({
      kind,
      id: input.split("/").pop(),
      url: input,
    })
  })

  it("accepts a bare token but records no URL for it", () => {
    expect(larkDocsProvider.matchRef("doxcnAbCdEfGh1234567890")).toEqual({
      kind: "doc",
      id: "doxcnAbCdEfGh1234567890",
    })
  })

  it("returns null for anything it cannot read", () => {
    expect(larkDocsProvider.matchRef("https://acme.feishu.cn/slides/slicnAbCdEfGh12345")).toBeNull()
    expect(larkDocsProvider.matchRef("https://github.com/x/y")).toBeNull()
  })
})

describe("larkDocsProvider.search", () => {
  it("demands the user identity the Feishu search endpoint requires", async () => {
    runWith({ post: async () => ({ docs_entities: [] }) })
    await larkDocsProvider.search?.("q", { accountId: ACCOUNT, limit: 10 })
    expect(withAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: ADAPTER, identity: "user" }),
      expect.any(Function)
    )
  })

  it("returns typed refs for readable kinds", async () => {
    runWith({
      post: async () => ({
        docs_entities: [
          { docs_token: "doxcn1", docs_type: "doc", title: "Spec" },
          { docs_token: "shtcn1", docs_type: "sheet", title: "Budget" },
          { docs_token: "sli1", docs_type: "slides", title: "Deck" },
        ],
      }),
    })
    expect(await larkDocsProvider.search?.("q", { accountId: ACCOUNT, limit: 10 })).toEqual([
      { providerId: "lark", kind: "doc", sourceType: "doc", id: "doxcn1", title: "Spec" },
      { providerId: "lark", kind: "sheet", id: "shtcn1", title: "Budget" },
    ])
  })

  it("surfaces a missing OAuth connection as notAuthorized, not a bot permission error", async () => {
    withAuthMock.mockRejectedValue(new LarkAccessError("notAuthorized", "Acme"))
    await expect(
      larkDocsProvider.search?.("q", { accountId: ACCOUNT, limit: 10 })
    ).rejects.toMatchObject({ name: "DocsProviderError", code: "notAuthorized" })
  })
})

describe("larkDocsProvider.fetch — documents", () => {
  it("rejects a result from another account before acquiring credentials or reading content", async () => {
    await expect(
      larkDocsProvider.fetch(
        {
          providerId: "lark",
          kind: "doc",
          id: "doc1",
          title: "Spec",
          accountBinding: { accountId: "other" },
        },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
    expect(withAuthMock).not.toHaveBeenCalled()
    expect(fetchDocMock).not.toHaveBeenCalled()
  })

  it.each(["docx", "doc"] as const)(
    "round-trips an opaque %s search result through the real fetcher",
    async (sourceType) => {
      const token = "Z1FjAbCdEfGh1234567890"
      const get = jest.fn(async (path: string) =>
        path.endsWith("/raw_content")
          ? { content: "Fetched search result" }
          : { document: { title: "Search hit" } }
      )
      runWith({
        get,
        post: async () => ({
          docs_entities: [{ docs_token: token, docs_type: sourceType, title: "Search hit" }],
        }),
      })
      fetchDocMock.mockImplementation(
        jest.requireActual("@/lib/twin/ingest/lark-doc-fetcher").fetchLarkDocAsRawSource
      )
      const hits = await larkDocsProvider.search!("hit", { accountId: ACCOUNT, limit: 10 })
      await expect(larkDocsProvider.fetch(hits[0], { accountId: ACCOUNT })).resolves.toMatchObject({
        text: "Fetched search result",
      })
      expect(get).toHaveBeenCalledWith(
        sourceType === "docx"
          ? `/open-apis/docx/v1/documents/${token}/raw_content`
          : `/open-apis/doc/v2/${token}/raw_content`
      )
    }
  )

  it("delegates document bodies to the existing twin fetcher with identity and transfer bounds", async () => {
    fetchDocMock.mockResolvedValue({ title: "Spec", text: "body" })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "doc", id: "doxcn1", title: "stale" },
      { accountId: ACCOUNT }
    )
    expect(fetchDocMock).toHaveBeenCalledWith(
      "doxcn1",
      expect.objectContaining({
        adapterId: ADAPTER,
        expectedAuthorizationEpoch: "native-a",
        maxResponseBytes: 10 * 1024 * 1024,
      })
    )
    expect(out).toEqual({
      ref: { providerId: "lark", kind: "doc", id: "doxcn1", title: "Spec" },
      title: "Spec",
      text: "body",
      format: "text",
      truncated: false,
    })
  })

  it("prefers the captured URL over the bare token so tenant hosts resolve", async () => {
    fetchDocMock.mockResolvedValue({ title: "T", text: "b" })
    await larkDocsProvider.fetch(
      {
        providerId: "lark",
        kind: "doc",
        id: "doxcn1",
        title: "T",
        url: "https://acme.feishu.cn/docx/doxcn1",
      },
      { accountId: ACCOUNT }
    )
    expect(fetchDocMock).toHaveBeenCalledWith(
      "https://acme.feishu.cn/docx/doxcn1",
      expect.objectContaining({ adapterId: ADAPTER })
    )
  })

  it("clamps an oversized body and reports it", async () => {
    fetchDocMock.mockResolvedValue({ title: "Big", text: "x".repeat(MAX_DOC_CHARS + 10) })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "doc", id: "d", title: "Big" },
      { accountId: ACCOUNT }
    )
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("Truncated by Cognia")
  })

  it("translates the ingest error taxonomy into provider codes", async () => {
    fetchDocMock.mockRejectedValue(new LarkIngestError("larkNoPermission", { account: "Acme" }))
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "doc", id: "d", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ name: "DocsProviderError", code: "noPermission" })
  })
})

describe("Lark Wiki resource dispatch", () => {
  it.each(["doc", "docx"])("keeps the Wiki citation while reading its %s body", async (objType) => {
    const token = "doxcnAbCdEfGh1234567890"
    runWith({
      get: async (path) =>
        path.includes("get_node")
          ? { node: { obj_token: token, obj_type: objType, title: "Wiki title" } }
          : path.endsWith("raw_content")
            ? { content: "Actual document" }
            : { document: { title: "Body title" } },
    })
    fetchDocMock.mockImplementation(
      jest.requireActual("@/lib/twin/ingest/lark-doc-fetcher").fetchLarkDocAsRawSource
    )
    const ref = {
      providerId: "lark",
      kind: "wiki" as const,
      id: "wikcnAbCdEfGh123456789",
      title: "Old",
      url: "https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789",
    }
    const result = await larkDocsProvider.fetch(ref, { accountId: ACCOUNT })
    expect(result.ref).toEqual({ ...ref, title: "Wiki title" })
    expect(result.text).toBe("Actual document")
  })

  it.each([{}, { obj_token: "x", obj_type: "slides" }])(
    "rejects unreadable Wiki objects before dispatch",
    async (node) => {
      runWith({ get: async () => ({ node }) })
      await expect(
        larkDocsProvider.fetch(
          { providerId: "lark", kind: "wiki", id: "wiki", title: "Wiki" },
          { accountId: ACCOUNT }
        )
      ).rejects.toMatchObject({ code: "unsupportedType" })
      expect(fetchDocMock).not.toHaveBeenCalled()
    }
  )

  it("preserves Wiki permission failures", async () => {
    runWith({
      get: async () => {
        throw new LarkApiError({ status: 403, code: 99991672, message: "denied" })
      },
    })
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "wiki", id: "wiki", title: "Wiki" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "noPermission" })
  })

  it.each(["sheet", "bitable"])(
    "reads a Wiki %s through the existing reader and preserves its citation",
    async (objType) => {
      runWith({
        get: async (path) => {
          if (path.includes("get_node"))
            return { node: { obj_token: "resource", obj_type: objType, title: "Wiki title" } }
          if (path.includes("sheets/query")) return { sheets: [{ sheet_id: "s1", title: "Data" }] }
          if (path.includes("/values/")) return { valueRange: { values: [[0, false]] } }
          if (path.includes("/tables?")) return { items: [{ table_id: "t1", name: "Data" }] }
          return { spreadsheet: { title: "Grid" }, app: { name: "Base" } }
        },
        post: async () => ({ items: [{ fields: { Count: 0, Active: false } }] }),
      })
      const ref = {
        providerId: "lark",
        kind: "wiki" as const,
        id: "wikcnAbCdEfGh123456789",
        title: "Old",
        url: "https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789",
      }
      const body = await larkDocsProvider.fetch(ref, { accountId: ACCOUNT })
      expect(body.ref).toEqual({ ...ref, title: "Wiki title" })
      expect(body.title).toBe("Wiki title")
      expect(body.format).toBe("csv")
      expect(body.text).toContain("0,false")
    }
  )

  it("rejects authorization changes while a body is in flight", async () => {
    fetchDocMock.mockImplementation(async () => {
      ;(larkConnectionAdapter as jest.Mock).mockRejectedValue(
        new ConnectionRevisionChanged(ACCOUNT, 1, 2)
      )
      return { title: "New account", text: "must not attach" }
    })
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", id: "d", kind: "doc", title: "Old" },
        { accountId: ACCOUNT, expectedAuthorizationEpoch: "1" }
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
  })
})

describe("larkDocsProvider.fetch — grids", () => {
  it.each(["\n", "\r\n", "\t\n"])(
    "rejects a real sheet whose cells only contain %j",
    async (cell) => {
      runWith({
        get: async (path) =>
          path.includes("/sheets/query")
            ? {
                sheets: [
                  {
                    sheet_id: "s",
                    title: "Empty",
                    grid_properties: { row_count: 99999, column_count: 1 },
                  },
                ],
              }
            : path.includes("values/")
              ? { valueRange: { values: [[cell]] } }
              : { spreadsheet: { title: "Empty" } },
      })
      await expect(
        larkDocsProvider.fetch(
          { providerId: "lark", kind: "sheet", id: "sheet", title: "Empty" },
          { accountId: ACCOUNT }
        )
      ).rejects.toMatchObject({ code: "empty" })
    }
  )

  it("rejects a Base with visible tables but no data", async () => {
    runWith({
      get: async (path) =>
        path.includes("/tables")
          ? { items: [{ table_id: "t", name: "Empty" }] }
          : { app: { name: "Empty" } },
      post: async () => ({ items: [] }),
    })
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "bitable", id: "base", title: "Empty" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "empty" })
  })

  it("reads a spreadsheet as CSV without demanding the user identity", async () => {
    runWith({
      get: async (path: string) =>
        path.includes("/sheets/query")
          ? {
              sheets: [
                { sheet_id: "s1", title: "Q3", grid_properties: { row_count: 1, column_count: 1 } },
              ],
            }
          : path.includes("values/")
            ? { valueRange: { values: [["a"]] } }
            : { spreadsheet: { title: "Budget" } },
    })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "sheet", id: "shtcn1", title: "stale" },
      { accountId: ACCOUNT }
    )
    expect(out.format).toBe("csv")
    expect(out.title).toBe("Budget")
    expect(out.text).toBe("## Q3\na")
    expect(withAuthMock.mock.calls[0][0]).toHaveProperty("identity", "user")
  })

  it("reads a Bitable app as CSV", async () => {
    runWith({
      get: async (path: string) =>
        path.includes("/tables")
          ? { items: [{ table_id: "t1", name: "Tasks" }] }
          : { app: { name: "Road" } },
      post: async () => ({ items: [{ fields: { Name: "Ship" } }] }),
    })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "bitable", id: "bascn1", title: "stale" },
      { accountId: ACCOUNT }
    )
    expect(out.title).toBe("Road")
    expect(out.text).toBe("## Tasks\nName\nShip")
  })

  it("reports an empty grid rather than staging a blank attachment", async () => {
    runWith({ get: async () => ({}) })
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "sheet", id: "shtcn1", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "empty" })
  })

  it("maps a raw Lark API failure through the shared business-code table", async () => {
    withAuthMock.mockRejectedValue(
      new LarkApiError({ status: 200, code: 1254005, message: "gone" })
    )
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "bitable", id: "b", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "notFound" })
  })

  it("passes a DocsProviderError through unchanged", async () => {
    withAuthMock.mockRejectedValue(new DocsProviderError("rateLimited"))
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "sheet", id: "s", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "rateLimited" })
  })
})
