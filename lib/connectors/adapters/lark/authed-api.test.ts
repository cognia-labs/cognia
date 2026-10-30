jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(async () => ({
    configured: true,
    authorizationEpoch: "epoch-a",
    accessToken: "user-a",
  })),
}))
jest.mock("./auth", () => ({
  getUserAccessToken: jest.fn(),
  getTenantAccessToken: jest.fn(),
  refreshUserToken: jest.fn(),
  clearTokenCache: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  connectorsKeyringGet,
  connectorsLarkUserAuth,
  type TauriHttpRequest,
} from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken, getUserAccessToken, refreshUserToken } from "./auth"
import { LarkApiError } from "./auth-retry"
import { LARK_API_BASE, LarkAccessError, withLarkAuthedApi } from "./authed-api"
import { readLarkSpreadsheet } from "@/lib/docs-providers/providers/lark/sheets"
import { readLarkBitable } from "@/lib/docs-providers/providers/lark/bitable"
import { inspect } from "node:util"

const isTauriMock = isTauri as jest.Mock
const getAdapterInstanceMock = getAdapterInstance as jest.Mock
const keyringGetMock = connectorsKeyringGet as jest.Mock
const getUserAccessTokenMock = getUserAccessToken as jest.Mock
const getTenantAccessTokenMock = getTenantAccessToken as jest.Mock
const refreshUserTokenMock = refreshUserToken as jest.Mock

const ADAPTER = "cai_authed"

function ok(data: unknown) {
  return {
    status: 200,
    headers: {} as Record<string, string>,
    body: JSON.stringify({ code: 0, data }),
  }
}

function makeHttp(
  responses: Array<{ status: number; headers?: Record<string, string>; body: string }>
) {
  const calls: TauriHttpRequest[] = []
  const impl = jest.fn(async (req: TauriHttpRequest) => {
    calls.push(req)
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request ${req.url}`)
    return { headers: {}, ...next }
  })
  return { impl, calls }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => ({
    configured: true,
    authorizationEpoch: "epoch-a",
    accessToken: await getUserAccessTokenMock(ADAPTER),
  }))
  isTauriMock.mockReturnValue(true)
  getAdapterInstanceMock.mockResolvedValue({
    id: ADAPTER,
    type: "lark",
    enabled: true,
    displayName: "Acme Feishu",
  })
  keyringGetMock.mockImplementation(async (_id: string, key: string) =>
    key === "appId" ? "cli_app" : "secret"
  )
  getUserAccessTokenMock.mockResolvedValue(null)
  getTenantAccessTokenMock.mockResolvedValue("tat-1")
})

describe("withLarkAuthedApi — pre-flight", () => {
  it("rejects cancellation before its public promise settles across final continuations", async () => {
    let rejectedPending = 0
    let completedBeforeAbort = 0
    for (let depth = 0; depth <= 24; depth++) {
      const controller = new AbortController()
      let pendingAtAbort = false
      const abortLater = (remaining: number) =>
        queueMicrotask(() => {
          if (remaining > 0) return abortLater(remaining - 1)
          pendingAtAbort = inspect(reading).includes("<pending>")
          controller.abort(new Error("cancel final result"))
        })
      const http = jest.fn(async () => {
        abortLater(depth)
        return ok({ content: "fixture" })
      })
      const reading = withLarkAuthedApi(
        { adapterId: ADAPTER, signal: controller.signal, httpImpl: http },
        (api) => api.get("/doc")
      )
      const outcome = await reading.then(
        () => "published",
        () => "cancelled"
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (pendingAtAbort) {
        rejectedPending++
        expect(outcome).toBe("cancelled")
      } else {
        completedBeforeAbort++
        expect(outcome).toBe("published")
      }
    }
    expect(rejectedPending).toBeGreaterThan(0)
    expect(completedBeforeAbort).toBeGreaterThan(0)
  })

  it.each([undefined, "epoch-a"])(
    "fences revocation during pagination even with expected epoch %s",
    async (expectedAuthorizationEpoch) => {
      getUserAccessTokenMock.mockResolvedValue("user-a")
      let state = {
        configured: true,
        authorizationEpoch: "epoch-a",
        accessToken: "user-a" as string | null,
      }
      ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => ({ ...state }))
      const http = jest.fn(async () => {
        state = { ...state, authorizationEpoch: "revoked", accessToken: null }
        return ok({ page: 1 })
      })
      await expect(
        withLarkAuthedApi(
          { adapterId: ADAPTER, expectedAuthorizationEpoch, httpImpl: http },
          async (api) => {
            await api.get("/page-one")
            return api.get("/page-two")
          }
        )
      ).rejects.toMatchObject({ code: "notAuthorized" })
      expect(http).toHaveBeenCalledTimes(1)
    }
  )

  it("does not dispatch after cancellation while the authorization promise unwinds", async () => {
    const controller = new AbortController()
    let snapshots = 0
    ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => {
      if (++snapshots === 3) queueMicrotask(() => queueMicrotask(() => controller.abort()))
      return { configured: true, authorizationEpoch: "epoch-a" }
    })
    const { impl } = makeHttp([ok({})])
    await expect(
      withLarkAuthedApi(
        {
          adapterId: ADAPTER,
          expectedAuthorizationEpoch: "epoch-a",
          signal: controller.signal,
          httpImpl: impl,
        },
        (api) => api.get("/document")
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(impl).not.toHaveBeenCalled()
  })

  it("does not start refresh after cancellation while the post-response authorization promise unwinds", async () => {
    const controller = new AbortController()
    let responseReceived = false
    getUserAccessTokenMock.mockResolvedValue("user-a")
    ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => {
      if (responseReceived) queueMicrotask(() => queueMicrotask(() => controller.abort()))
      return { configured: true, authorizationEpoch: "epoch-a", accessToken: "user-a" }
    })
    const impl = jest.fn(async () => {
      responseReceived = true
      return { status: 401, headers: {}, body: JSON.stringify({ code: 99991677 }) }
    })
    await expect(
      withLarkAuthedApi(
        {
          adapterId: ADAPTER,
          expectedAuthorizationEpoch: "epoch-a",
          signal: controller.signal,
          httpImpl: impl,
        },
        (api) => api.get("/document")
      )
    ).rejects.toMatchObject({ name: "AbortError" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(refreshUserTokenMock).not.toHaveBeenCalled()
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it.each(["sheet", "bitable"])(
    "stops the real multi-section %s reader after caller cancellation",
    async (kind) => {
      getUserAccessTokenMock.mockResolvedValue("user-a")
      const controller = new AbortController()
      let finish!: (value: ReturnType<typeof ok>) => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const impl = jest.fn(async (req: TauriHttpRequest) => {
        if (req.url.includes("/values/") || req.method === "POST") {
          markStarted()
          return new Promise<ReturnType<typeof ok>>((resolve) => {
            finish = resolve
          })
        }
        if (req.url.includes("sheets/query"))
          return ok({ sheets: [{ sheet_id: "s1" }, { sheet_id: "s2" }] })
        if (req.url.includes("/tables?"))
          return ok({ items: [{ table_id: "t1" }, { table_id: "t2" }] })
        return ok({ spreadsheet: { title: "Grid" }, app: { name: "Base" } })
      })
      const reading = withLarkAuthedApi<unknown>(
        { adapterId: ADAPTER, signal: controller.signal, httpImpl: impl },
        async (api) =>
          kind === "sheet" ? readLarkSpreadsheet(api, "grid") : readLarkBitable(api, "base")
      )
      await started
      controller.abort(new Error("stop reader"))
      await expect(reading).rejects.toThrow("stop reader")
      finish({ status: 401, headers: {}, body: JSON.stringify({ code: 99991663 }) })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(impl).toHaveBeenCalledTimes(3)
      expect(refreshUserTokenMock).not.toHaveBeenCalled()
      expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
    }
  )

  it("discards an in-flight response after reauthorization without refreshing or falling back to the bot", async () => {
    getUserAccessTokenMock.mockResolvedValue("old-user")
    const impl = jest.fn(async () => {
      ;(connectorsLarkUserAuth as jest.Mock).mockResolvedValue({
        configured: true,
        authorizationEpoch: "epoch-b",
      })
      return { status: 401, headers: {}, body: JSON.stringify({ code: 99991677 }) }
    })
    await expect(
      withLarkAuthedApi(
        { adapterId: ADAPTER, expectedAuthorizationEpoch: "epoch-a", httpImpl: impl },
        (api) => api.get("/doc")
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
    expect(refreshUserTokenMock).not.toHaveBeenCalled()
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })
  it("rejects a pre-aborted caller before reading credentials or dispatching HTTP", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    const { impl } = makeHttp([ok({})])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl, signal: controller.signal }, (api) =>
        api.get("/x")
      )
    ).rejects.toThrow("stop")
    expect(getAdapterInstanceMock).not.toHaveBeenCalled()
    expect(impl).not.toHaveBeenCalled()
  })

  it("releases the caller and never starts another tab after an in-flight cancellation", async () => {
    const controller = new AbortController()
    let finish!: (value: ReturnType<typeof ok>) => void
    const impl = jest.fn(
      () =>
        new Promise<ReturnType<typeof ok>>((resolve) => {
          finish = resolve
        })
    )
    const reading = withLarkAuthedApi(
      { adapterId: ADAPTER, httpImpl: impl, signal: controller.signal },
      async (api) => {
        await api.get("/tab-one")
        return api.get("/tab-two")
      }
    )
    while (!finish) await Promise.resolve()
    controller.abort(new Error("stop"))
    await expect(reading).rejects.toThrow("stop")
    finish(ok({}))
    await Promise.resolve()
    expect(impl).toHaveBeenCalledTimes(1)
    expect(refreshUserTokenMock).not.toHaveBeenCalled()
  })
  it("refuses outside Tauri when no transport is injected", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(withLarkAuthedApi({ adapterId: ADAPTER }, async () => "x")).rejects.toMatchObject({
      name: "LarkAccessError",
      code: "browserUnsupported",
    })
    expect(getAdapterInstanceMock).not.toHaveBeenCalled()
  })

  it("accepts an injected transport outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { impl } = makeHttp([ok({ ok: true })])
    const out = await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get<{ ok: boolean }>("/open-apis/ping")
    )
    expect(out).toEqual({ ok: true })
  })

  it.each([
    ["missing", null],
    ["disabled", { id: ADAPTER, type: "lark", enabled: false, displayName: "x" }],
    ["wrong type", { id: ADAPTER, type: "slack", enabled: true, displayName: "x" }],
  ])("throws noAccount for a %s adapter", async (_label, row) => {
    getAdapterInstanceMock.mockResolvedValue(row)
    const { impl } = makeHttp([])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, async () => "x")
    ).rejects.toMatchObject({ code: "noAccount" })
  })

  it("throws notAuthorized carrying the account name when credentials are missing", async () => {
    keyringGetMock.mockResolvedValue(null)
    const { impl } = makeHttp([])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, async () => "x")
    ).rejects.toMatchObject({ code: "notAuthorized", account: "Acme Feishu" })
  })
})

describe("withLarkAuthedApi — identity order", () => {
  it("prefers the connected user so document ACLs apply as that user", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-1")
    const { impl, calls } = makeHttp([ok({ n: 1 })])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get("/open-apis/x")
    )
    expect(calls[0].headers?.Authorization).toBe("Bearer uat-1")
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })

  it("falls back to the bot identity when no user is connected", async () => {
    const { impl, calls } = makeHttp([ok({ n: 1 })])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get("/open-apis/x")
    )
    expect(calls[0].headers?.Authorization).toBe("Bearer tat-1")
  })

  it("falls back to the bot after the user token stays invalid through a refresh", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-dead")
    refreshUserTokenMock.mockResolvedValue("uat-dead")
    const { impl, calls } = makeHttp([
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
      ok({ n: 2 }),
    ])
    const out = await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get<{ n: number }>("/open-apis/x")
    )
    expect(out).toEqual({ n: 2 })
    expect(calls.at(-1)?.headers?.Authorization).toBe("Bearer tat-1")
  })

  it("does not fall back to the bot on an unrelated user-identity failure", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-1")
    const { impl } = makeHttp([{ status: 403, body: JSON.stringify({ code: 1254302, msg: "no" }) }])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) => api.get("/open-apis/x"))
    ).rejects.toBeInstanceOf(LarkApiError)
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })
})

describe("withLarkAuthedApi — requireUserIdentity", () => {
  it("refuses up front when no user is connected", async () => {
    const { impl } = makeHttp([])
    await expect(
      withLarkAuthedApi(
        { adapterId: ADAPTER, httpImpl: impl, requireUserIdentity: true },
        async () => "x"
      )
    ).rejects.toMatchObject({ code: "notAuthorized", account: "Acme Feishu" })
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })

  it("never silently downgrades to the bot after the user token dies", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-dead")
    refreshUserTokenMock.mockResolvedValue("uat-dead")
    const { impl } = makeHttp([
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
      { status: 401, body: JSON.stringify({ code: 99991663, msg: "invalid" }) },
    ])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl, requireUserIdentity: true }, (api) =>
        api.get("/open-apis/x")
      )
    ).rejects.toBeInstanceOf(LarkApiError)
    expect(getTenantAccessTokenMock).not.toHaveBeenCalled()
  })

  it("uses the user identity normally when one is connected", async () => {
    getUserAccessTokenMock.mockResolvedValue("uat-1")
    const { impl, calls } = makeHttp([ok({ n: 1 })])
    await withLarkAuthedApi(
      { adapterId: ADAPTER, httpImpl: impl, requireUserIdentity: true },
      (api) => api.get("/open-apis/x")
    )
    expect(calls[0].headers?.Authorization).toBe("Bearer uat-1")
  })
})

describe("withLarkAuthedApi — requests", () => {
  it("builds absolute open.feishu.cn URLs and sends JSON headers", async () => {
    const { impl, calls } = makeHttp([ok({})])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.get("/open-apis/docx/v1/documents/tok")
    )
    expect(calls[0].url).toBe(`${LARK_API_BASE}/open-apis/docx/v1/documents/tok`)
    expect(calls[0].method).toBe("GET")
    expect(calls[0].headers?.["Content-Type"]).toBe("application/json; charset=utf-8")
    expect(calls[0].body).toBeUndefined()
  })

  it("serializes POST bodies", async () => {
    const { impl, calls } = makeHttp([ok({})])
    await withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) =>
      api.post("/open-apis/bitable/v1/apps/a/tables/t/records/search", { page_size: 3 })
    )
    expect(calls[0].method).toBe("POST")
    expect(calls[0].body).toBe(JSON.stringify({ page_size: 3 }))
  })

  it("raises LarkApiError on a non-zero business code even at HTTP 200", async () => {
    const { impl } = makeHttp([
      { status: 200, body: JSON.stringify({ code: 1254005, msg: "gone" }) },
    ])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) => api.get("/open-apis/x"))
    ).rejects.toMatchObject({ name: "LarkApiError", code: 1254005, status: 200 })
  })

  it("raises LarkApiError with the body snippet when the payload is not JSON", async () => {
    const { impl } = makeHttp([{ status: 502, body: "<html>bad gateway</html>" }])
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl }, (api) => api.get("/open-apis/x"))
    ).rejects.toMatchObject({ code: null, status: 502 })
  })

  it("hands the resolved account to the callback", async () => {
    const { impl } = makeHttp([ok({})])
    const seen = await withLarkAuthedApi(
      { adapterId: ADAPTER, httpImpl: impl },
      async (_api, acct) => acct
    )
    expect(seen).toEqual({ adapterId: ADAPTER, displayName: "Acme Feishu" })
  })

  it("routes failures through mapError when one is supplied", async () => {
    const { impl } = makeHttp([{ status: 500, body: JSON.stringify({ code: 1, msg: "boom" }) }])
    const mapError = jest.fn((_err: unknown, account: string) => new Error(`mapped:${account}`))
    await expect(
      withLarkAuthedApi({ adapterId: ADAPTER, httpImpl: impl, mapError }, (api) =>
        api.get("/open-apis/x")
      )
    ).rejects.toThrow("mapped:Acme Feishu")
    expect(mapError).toHaveBeenCalledTimes(1)
  })
})

describe("LarkAccessError", () => {
  it("keeps the code and account addressable", () => {
    const err = new LarkAccessError("notAuthorized", "Acme")
    expect(err.code).toBe("notAuthorized")
    expect(err.account).toBe("Acme")
    expect(err.message).toContain("Acme")
  })
})

describe("withLarkAuthedApi — write verbs", () => {
  it("binds PATCH, PUT and DELETE to the same identity as GET and POST", async () => {
    const impl = jest.fn(async (req: { method: string; url: string; body?: string }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, data: { echo: req.method, url: req.url, body: req.body } }),
    }))
    const out = await withLarkAuthedApi(
      { adapterId: ADAPTER, httpImpl: impl as never },
      async (api) => [
        await api.patch!("/open-apis/task/v2/tasks/t1", { task: {} }),
        await api.put!("/open-apis/bitable/v1/apps/a/tables/t/records/r", { fields: {} }),
        await api.delete!("/open-apis/task/v2/tasks/t1"),
      ]
    )
    expect(out).toEqual([
      expect.objectContaining({ echo: "PATCH", body: JSON.stringify({ task: {} }) }),
      expect.objectContaining({ echo: "PUT" }),
      expect.objectContaining({ echo: "DELETE" }),
    ])
    expect((out as Array<{ body?: string }>)[2].body).toBeUndefined()
  })
})
