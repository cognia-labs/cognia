/**
 * Tests for the Share Plugin API (`ctx.share`).
 */

import { createShareAPI } from "./share-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { assertPersonalSink } from "@/lib/execution/personal-sink"
import { pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
jest.mock("@/lib/execution/personal-sink", () => ({
  ...jest.requireActual("@/lib/execution/personal-sink"),
  assertPersonalSink: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/core/invocation-identity", () => ({
  pluginExecutionContext: jest.fn(() => ({ executionRunId: "host-invocation" })),
}))

const createShareLink = jest.fn(async (..._a: unknown[]) => ({
  code: "c1",
  url: "https://x/share/view?c=c1#k=KEY",
}))
const revokeShareLink = jest.fn(async (..._a: unknown[]) => undefined)
const getShareStats = jest.fn(async (..._a: unknown[]) => ({ viewCount: 3, revoked: false }))
jest.mock("@/lib/share/client", () => ({
  createShareLink: (...a: unknown[]) => createShareLink(...a),
  revokeShareLink: (...a: unknown[]) => revokeShareLink(...a),
  getShareStats: (...a: unknown[]) => getShareStats(...a),
}))

const listSharedLinks = jest.fn(async (..._a: unknown[]) => [{ code: "c1", revoked: false }])
const getSharedLinkByCode = jest.fn(async (...a: unknown[]) =>
  a[0] === "miss" ? undefined : { code: a[0] as string }
)
const deleteSharedLink = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/shared-links", () => ({
  listSharedLinks: (...a: unknown[]) => listSharedLinks(...a),
  getSharedLinkByCode: (...a: unknown[]) => getSharedLinkByCode(...a),
  deleteSharedLink: (...a: unknown[]) => deleteSharedLink(...a),
}))

const PLUGIN = "share-plugin"

describe("createShareAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    guard = getPermissionGuard({ confirmDangerousByDefault: false })
  })

  describe("permission gating", () => {
    it("list needs share:read", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createShareAPI(PLUGIN)
      expect(() => api.list()).toThrow(PermissionError)
    })

    it("create needs share:create (read alone insufficient)", () => {
      guard.registerPlugin(PLUGIN, ["share:read"])
      const api = createShareAPI(PLUGIN)
      expect(() => api.getStats("c1")).not.toThrow()
      expect(() => api.create({} as never)).toThrow(PermissionError)
      expect(createShareLink).not.toHaveBeenCalled()
    })
  })

  describe("reads", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["share:read"]))

    it("list / getByCode / getStats forward", async () => {
      const api = createShareAPI(PLUGIN)
      expect(await api.list({ includeRevoked: true })).toHaveLength(1)
      expect(listSharedLinks).toHaveBeenCalledWith({ includeRevoked: true })
      expect(await api.getByCode("c1")).toEqual({ code: "c1" })
      expect(await api.getByCode("miss")).toBeNull()
      expect(await api.getStats("c1")).toEqual({ viewCount: 3, revoked: false })
    })
  })

  describe("writes", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["share:read", "share:create"]))

    it("create / revoke / delete forward", async () => {
      const api = createShareAPI(PLUGIN)
      const created = await api.create({ payload: { kind: "chat-md" } } as never)
      expect(created.code).toBe("c1")
      expect(createShareLink).toHaveBeenCalled()
      expect(assertPersonalSink).toHaveBeenCalledWith(
        { executionRunId: "host-invocation" },
        { kind: "unknown", label: "public share" },
        undefined,
        { kind: "public-share", pluginId: PLUGIN }
      )
      await api.revoke("c1")
      expect(revokeShareLink).toHaveBeenCalledWith("c1")
      await api.delete("c1")
      expect(deleteSharedLink).toHaveBeenCalledWith("c1")
    })

    it("withholds before publishing and obtains execution only from Host invocation state", async () => {
      jest.mocked(assertPersonalSink).mockRejectedValueOnce(new Error("personal content withheld"))
      const api = createShareAPI(PLUGIN)
      await expect(
        api.create({ executionRunId: "model-claimed-clean", payload: { kind: "chat-md" } } as never)
      ).rejects.toThrow("personal content withheld")
      expect(pluginExecutionContext).toHaveBeenCalledWith(PLUGIN)
      expect(createShareLink).not.toHaveBeenCalled()
    })
  })
})
