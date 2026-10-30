import { createQQManagement } from "./management"
function setup() {
  const request = jest.fn(
    async (_method: string, path: string, _body?: Record<string, unknown>) => {
      if (path.endsWith("/bot_state")) return { member_role: "admin" }
      if (/\/members\/[^/]+$/.test(path)) return { member_role: "member", bot: false }
      if (path === "/v2/panels/panel") return { scope: "group", target_type: "specific" }
      if (path.endsWith("/batch_remove_members"))
        return { remove_members_result: "success", add_to_member_blacklist_fail_openids: [] }
      return {
        version: 2,
        panel_id: "panel",
        next_cursor: "next",
        members: [],
        strategies: [],
        list: [],
      }
    }
  )
  const uploadAsset = jest.fn(async () => ({
    image_id: "image",
    url: "qqbot-media://image/v1/token",
    ttl: 7776000,
    preview_url: "https://storage.example.org/?secret=never-return",
  }))
  const manager = createQQManagement({
    adapterId: "qq",
    request,
    uploadAsset,
    wait: async () => undefined,
  })
  return { manager, request, uploadAsset }
}
describe("QQ add-contact links", () => {
  const url = "https://qun.qq.com/qunpro/robot/qunshare?robot_appid=123&data=launch"
  it.each([undefined, "", "campaign_123", "邀".repeat(32), "🚀".repeat(32)])(
    "maps bounded shared state %j to callback_data and returns only the link",
    async (state) => {
      const h = setup()
      h.request.mockResolvedValueOnce({
        data: { url, token: "secret" },
        trace_id: "secret",
      } as never)
      await expect(
        h.manager.execute({
          operation: "links.create",
          input: { purpose: "add-contact", ...(state !== undefined ? { state } : {}) },
        } as never)
      ).resolves.toEqual({
        status: "ok",
        link: { purpose: "add-contact", url },
      })
      expect(h.request).toHaveBeenCalledWith(
        "POST",
        "/v2/generate_url_link",
        state !== undefined ? { callback_data: state } : {}
      )
    }
  )
  it.each(["a".repeat(33), "🚀".repeat(33), "private@example.com", "bad\u0000state"])(
    "rejects inadmissible state before HTTP: %j",
    async (state) => {
      const h = setup()
      await expect(
        h.manager.execute({
          operation: "links.create",
          input: { purpose: "add-contact", state },
        } as never)
      ).rejects.toThrow(/limit|PII|parameters/)
      expect(h.request).not.toHaveBeenCalled()
    }
  )
  it.each([
    {},
    { url },
    { data: { url: "https://127.0.0.1" } },
    { data: { url: "javascript:alert(1)" } },
    { data: { url: "https://example.org/invite" } },
    { data: { url: "https://qun.qq.com/other" } },
    { data: { url: "https://qun.qq.com:8443/qunpro/robot/qunshare" } },
  ])("rejects malformed or unsafe receipts: %j", async (response) => {
    const h = setup()
    h.request.mockResolvedValueOnce(response as never)
    await expect(
      h.manager.execute({ operation: "links.create", input: { purpose: "add-contact" } } as never)
    ).rejects.toThrow(/link/i)
  })
})
it("maps generic menu actions and command publication without a QQ-specific public input", async () => {
  const h = setup()
  await h.manager.execute({
    operation: "menus.set",
    input: {
      items: [
        { key: "help", label: "Help", action: { type: "slash", value: "/help" } },
        { key: "search", label: "Search", toggle: { enabled: false } },
      ],
    },
  })
  expect(h.request).toHaveBeenCalledWith("PUT", "/v2/menu", {
    menu: {
      items: [
        { name: "Help", type: "send_message", send_message: "/help" },
        { name: "Search", type: "switch", switch: { switch_id: "search", default: false } },
      ],
    },
  })
  const panel = {
    scope: "group" as const,
    audience: "specific" as const,
    name: "Commands",
    items: [{ name: "/help", description: "Help" }],
  }
  await h.manager.execute({ operation: "commands.create", input: { panel } })
  await h.manager.execute({ operation: "commands.update", input: { id: "panel", panel } })
  expect(h.request).toHaveBeenLastCalledWith("PUT", "/v2/panels/panel", {
    panel: { remark: "Commands", items: [{ name: "/help", desc: "Help", type: "command" }] },
  })
  await h.manager.execute({
    operation: "commands.targets",
    input: { id: "panel", action: "remove", targetIds: ["group"] },
  })
  expect(h.request).toHaveBeenLastCalledWith("PUT", "/v2/panels/panel/target", {
    op: "del",
    group_openids: ["group"],
  })
})
it.each([
  ["private", "c2c"],
  ["group", "group"],
  ["channel", "channel"],
  ["direct", "dm"],
] as const)("lists %s command panels with required scope and pagination", async (scope, wire) => {
  const h = setup()
  h.request.mockResolvedValueOnce({
    records: [
      {
        panel_id: "p",
        panel: { items: [{ name: "Help", token: "secret" }], credential: "secret" },
      },
    ],
    next_cursor: "next",
  } as never)
  const result = await h.manager.execute({
    operation: "commands.list",
    input: { scope, cursor: "previous", limit: 20 },
  })
  expect(h.request).toHaveBeenCalledWith(
    "GET",
    `/v2/panels?scope=${wire}&cursor=previous&limit=20`,
    undefined
  )
  expect(JSON.stringify(result)).not.toContain("secret")
  expect(result.items?.[0]).toMatchObject({ panel: { items: [{ name: "Help" }] } })
})
it("uses public mute and join approval APIs without invited member-read prerequisites", async () => {
  const h = setup()
  h.request.mockImplementation(async (_method, path) => {
    if (path.endsWith("bot_state") || path.includes("/members/"))
      throw Object.assign(new Error("not invited"), { platformCode: 11253 })
    return {} as never
  })
  await h.manager.execute({
    operation: "moderation.set",
    input: {
      chatId: "g",
      members: [{ memberId: "m", action: "add", expiresAt: Date.now() + 60_000 }],
    },
  })
  await h.manager.execute({
    operation: "joinRequests.decide",
    input: { chatId: "g", memberId: "m", requestId: "r", decision: "approve" },
  })
  expect(h.request).toHaveBeenCalledTimes(2)
  expect(h.request.mock.calls.every(([method]) => method === "POST")).toBe(true)
})
it("does not resume a management operation from a stopped adapter generation", async () => {
  let signal = new AbortController()
  let release!: () => void
  const request = jest.fn(async () => ({}))
  const manager = createQQManagement({
    adapterId: "a",
    request,
    uploadAsset: jest.fn(),
    signal: () => signal.signal,
    wait: () =>
      new Promise((done) => {
        release = done
      }),
  })
  await manager.execute({ operation: "menus.get", input: {} })
  const pending = manager.execute({ operation: "menus.get", input: {} })
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve()
  signal.abort()
  signal = new AbortController()
  release()
  await expect(pending).rejects.toThrow(/stopped/)
  expect(request).toHaveBeenCalledTimes(1)
})
it("applies publication bounds and never accepts local or credential-bearing links", async () => {
  const h = setup()
  for (const value of ["file:///a", "https://u:p@example.org", "http://example.org"])
    await expect(
      h.manager.execute({
        operation: "menus.set",
        input: { items: [{ key: "x", label: "Link", action: { type: "link", value } }] },
      })
    ).rejects.toThrow(/HTTPS|PII/)
  await expect(
    h.manager.execute({
      operation: "menus.set",
      input: {
        items: [{ key: "x", label: "超过五个中文字符", action: { type: "prompt", value: "Help" } }],
      },
    })
  ).rejects.toThrow(/limit/)
  expect(h.request).not.toHaveBeenCalled()
})
it("returns only owned durable asset references, with no signed preview URL", async () => {
  const h = setup()
  const out = await h.manager.execute({
    operation: "assets.upload",
    input: { name: "image.png", mimeType: "image/png", source: { dataBase64: "aGVsbG8=" } },
  })
  expect(out.asset).toMatchObject({
    adapterId: "qq",
    id: "image",
    reference: "qqbot-media://image/v1/token",
    name: "image.png",
  })
  expect(JSON.stringify(out)).not.toMatch(/preview_url|never-return/)
})
it("preserves destructive member results and validates administrator and target roles", async () => {
  const h = setup()
  expect(
    await h.manager.execute({
      operation: "members.remove",
      input: { chatId: "group", memberIds: ["member"], blockRejoin: true },
    })
  ).toMatchObject({ status: "ok", succeeded: ["member"] })
  expect(h.request).toHaveBeenCalledWith("POST", "/v2/groups/group/batch_remove_members", {
    member_openids: ["member"],
    add_to_member_blacklist: true,
  })
  const expiresAt = Date.now() + 60000
  await h.manager.execute({
    operation: "moderation.set",
    input: { chatId: "group", members: [{ memberId: "member", action: "add", expiresAt }] },
  })
  expect(h.request).toHaveBeenLastCalledWith("POST", "/v2/groups/group/restrict_chat_setting", {
    members: [
      { member_openid: "member", op: "add", mute_expire_at: new Date(expiresAt).toISOString() },
    ],
  })
  h.request.mockResolvedValueOnce({ member_role: "member" })
  await expect(
    h.manager.execute({
      operation: "members.remove",
      input: { chatId: "group", memberIds: ["member"] },
    })
  ).rejects.toThrow(/administrator/)
})
it("requires an exact join request and distinguishes asynchronous policy execution from completion", async () => {
  const h = setup()
  await h.manager.execute({
    operation: "joinRequests.decide",
    input: { chatId: "group", memberId: "member", requestId: "request", decision: "decline" },
  })
  expect(h.request).toHaveBeenLastCalledWith(
    "POST",
    "/v2/groups/group/approval_join_request/member",
    { op: "decline", join_request_id: "request", add_to_member_blacklist: false }
  )
  expect(
    await h.manager.execute({ operation: "joinPolicies.execute", input: { id: "policy" } })
  ).toEqual({ status: "accepted" })
  await expect(
    h.manager.execute({
      operation: "joinRequests.decide",
      input: { chatId: "group", memberId: "member", decision: "approve" },
    } as never)
  ).rejects.toThrow(/parameters/)
})
it("surfaces missing invited API access without leaking the raw provider response", async () => {
  const h = setup()
  h.request.mockRejectedValueOnce(Object.assign(new Error("token=secret"), { platformCode: 11253 }))
  await expect(
    h.manager.execute({ operation: "members.list", input: { chatId: "group" } })
  ).rejects.toMatchObject({ name: "ChatManagementScopeError", requiredScope: expect.any(String) })
})
