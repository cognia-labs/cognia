/** QQ codec for the shared named management API; no public raw-HTTP escape. */
import type {
  ConnectorAsset,
  ConnectorManagement,
  ConnectorManagementRequest,
  ConnectorManagementResult,
  ConnectorMenuItem,
  ConnectorCommandPanel,
} from "@/types/connectors/management"
import {
  CONNECTOR_MANAGEMENT_OPERATIONS,
  validateConnectorManagementRequest,
  validateConnectorLink,
} from "@/lib/connectors/management"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"

type Data = Record<string, unknown>
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
const object = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {}
const list = (value: unknown): Data[] =>
  Array.isArray(value) ? value.slice(0, 100).map(object) : []
const requiredList = (value: unknown): Data[] => {
  if (!Array.isArray(value)) throw new Error("QQ resource inventory response is invalid")
  return list(value)
}
const string = (value: unknown) => (typeof value === "string" ? value : undefined)
const id = (value: string) => {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new TypeError("Invalid QQ resource identifier")
  return encodeURIComponent(value)
}
const responseFields = new Set([
  "items",
  "name",
  "type",
  "link",
  "send_message",
  "sub_menu_items",
  "switch",
  "switch_id",
  "default",
  "remark",
  "version",
  "desc",
  "only_admin",
  "global_rule",
  "members",
  "member_openid",
  "mute_expire_at",
  "op",
  "method",
  "message",
  "qa",
  "question",
  "answer",
  "strategy_id",
  "mode",
  "schedule_rules",
  "recurring_rules",
  "task_id",
  "start_at",
  "end_at",
  "enabled",
  "weekdays",
  "start_time",
  "end_time",
  "username",
  "union_openid",
])
function projectNested(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined
  if (typeof value === "string") return value.slice(0, 16_384)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => projectNested(item, depth + 1))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => responseFields.has(key))
        .map(([key, item]) => [key, projectNested(item, depth + 1)])
    )
  return undefined
}
const pick = (value: Data, keys: string[]) =>
  Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, projectNested(value[key])])
  )
function https(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError("QQ publication links require HTTPS without credentials")
  return url.href
}
const weighted = (value: string) =>
  [...value].reduce((sum, char) => sum + (char.codePointAt(0)! > 127 ? 2 : 1), 0)
function bounded(value: string, max: number) {
  if (!value.trim() || weighted(value) > max)
    throw new TypeError("QQ publication text exceeds the platform limit")
  return value
}
function menuItem(item: ConnectorMenuItem, nested = false): Data {
  const name = bounded(item.label, nested ? 14 : 10)
  if (item.children) {
    if (nested || item.children.length > 5)
      throw new TypeError("QQ menus support only five second-level items")
    return {
      name,
      type: "menu",
      sub_menu_items: item.children.map((child) => menuItem(child, true)),
    }
  }
  if (item.toggle) {
    if (nested) throw new TypeError("QQ second-level menus do not support switches")
    return { name, type: "switch", switch: { switch_id: item.key, default: item.toggle.enabled } }
  }
  if (!item.action) throw new TypeError("QQ menu action is missing")
  return item.action.type === "link"
    ? { name, type: "link", link: https(item.action.value) }
    : { name, type: "send_message", send_message: item.action.value }
}
function panelBody(panel: ConnectorCommandPanel): Data {
  const scope = { private: "c2c", group: "group", channel: "channel", direct: "dm" }[panel.scope]
  if (panel.audience === "specific" && !["c2c", "group"].includes(scope))
    throw new TypeError("QQ specific command panels require C2C or group scope")
  return {
    scope,
    target_type: panel.audience,
    panel: {
      remark: panel.remarks ?? panel.name,
      items: panel.items.map((item) => ({
        name: bounded(item.name, 14),
        desc: item.description ? bounded(item.description, 30) : "",
        type: item.url ? "link" : "command",
        ...(item.url ? { link: https(item.url) } : {}),
        ...(item.adminOnly !== undefined ? { only_admin: item.adminOnly } : {}),
      })),
    },
  }
}
function asset(adapterId: string, value: Data): ConnectorAsset {
  const imageId = string(value.image_id),
    reference = string(value.url)
  if (!imageId || !reference || !/^qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=-]+$/.test(reference))
    throw new Error("QQ returned an invalid reusable asset receipt")
  const expiry =
    typeof value.expires_at === "number"
      ? value.expires_at * 1000
      : typeof value.ttl === "number"
        ? Date.now() + value.ttl * 1000
        : undefined
  return {
    adapterId,
    id: imageId,
    reference,
    ...(string(value.file_name) ? { name: String(value.file_name) } : {}),
    ...(expiry !== undefined ? { expiresAt: expiry } : {}),
  }
}

export function createQQManagement(options: {
  adapterId: string
  request: (method: Method, path: string, body?: Data) => Promise<Data>
  uploadAsset: (
    input: Extract<ConnectorManagementRequest, { operation: "assets.upload" }>["input"]
  ) => Promise<Data>
  active?: () => boolean
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: () => AbortSignal | undefined
}): ConnectorManagement {
  const next = new Map<string, number>()
  let tail: Promise<unknown> = Promise.resolve()
  const wait =
    options.wait ??
    ((ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(new Error("QQ adapter stopped"))
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort)
          resolve()
        }, ms)
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
      }))
  let nextRpcAt = 0
  async function call(method: Method, path: string, body?: Data): Promise<Data> {
    if (options.active && !options.active()) throw new Error("QQ adapter is not running")
    const bucket = path.startsWith("/v2/menu")
      ? method === "GET"
        ? "menu-read"
        : "menu-write"
      : path.startsWith("/v2/panels")
        ? method === "GET"
          ? "panel-read"
          : "panel-write"
        : "groups"
    const signal = options.signal?.()
    if (signal?.aborted) throw new Error("QQ adapter stopped")
    const slot = Math.max(nextRpcAt, next.get(bucket) ?? 0)
    const delay = slot - Date.now()
    if (delay > 0) await wait(delay, signal)
    if (signal?.aborted || (signal && signal !== options.signal?.()))
      throw new Error("QQ adapter stopped")
    if (options.active && !options.active()) throw new Error("QQ adapter is not running")
    nextRpcAt = Date.now() + 2100
    next.set(
      bucket,
      Date.now() + (bucket === "menu-write" ? 12100 : bucket === "panel-write" ? 6100 : 2100)
    )
    try {
      return await options.request(method, path, body)
    } catch (error) {
      const code = (error as { platformCode?: number }).platformCode
      if ([11243, 11253].includes(code ?? 0) || (error as { status?: number }).status === 403)
        throw new ChatManagementScopeError(
          "QQ management requires the application's approved API permission and the bot's required group role",
          "QQ approved management API / group administrator",
          "qq-official"
        )
      throw new Error(`QQ management request failed${code ? ` (code ${code})` : ""}`)
    }
  }
  async function execute(request: ConnectorManagementRequest): Promise<ConnectorManagementResult> {
    const input = request.input
    const operation = request.operation
    if (options.active && !options.active()) throw new Error("QQ adapter is not running")
    let data: Data = {}
    const getPage = (path: string, args: { cursor?: string; limit?: number }) => {
      const query = new URLSearchParams()
      if (args.cursor) query.set("cursor", args.cursor)
      if (args.limit) query.set("limit", String(args.limit))
      return call("GET", `${path}${query.size ? `${path.includes("?") ? "&" : "?"}${query}` : ""}`)
    }
    switch (operation) {
      case "links.create": {
        const state = request.input.state
        if (state !== undefined && [...state].length > 32)
          throw new TypeError("QQ link callback state exceeds the32-character limit")
        data = await call(
          "POST",
          "/v2/generate_url_link",
          state !== undefined ? { callback_data: state } : {}
        )
        const link = validateConnectorLink({
          purpose: "add-contact",
          url: object(data.data).url as string,
        })
        const url = new URL(link.url)
        if (url.hostname !== "qun.qq.com" || url.port || url.pathname !== "/qunpro/robot/qunshare")
          throw new TypeError("QQ returned an unsupported invitation link")
        return { status: "ok", link }
      }
      case "assets.upload":
        data = await options.uploadAsset(request.input)
        return {
          status: "ok",
          asset: asset(options.adapterId, { ...data, file_name: request.input.name }),
        }
      case "assets.list":
        data = await getPage("/v2/media-images", request.input)
        if (!Array.isArray(data.images)) throw new Error("QQ asset inventory response is invalid")
        return {
          status: "ok",
          assets: list(data.images).map((value) => asset(options.adapterId, value)),
          nextCursor: string(data.next_cursor),
          total: typeof data.total === "number" ? data.total : undefined,
        }
      case "assets.delete":
        await call("DELETE", `/v2/media-images/${id(request.input.id)}/delete`)
        return { status: "ok" }
      case "menus.get":
        data = await call("GET", "/v2/menu")
        return { status: "ok", resource: pick(data, ["menu", "version"]) }
      case "menus.set":
        if (request.input.items.length > 10)
          throw new TypeError("QQ supports ten top-level menu items")
        data = await call("PUT", "/v2/menu", {
          menu: { items: request.input.items.map((item) => menuItem(item)) },
        })
        return { status: "ok", resource: pick(data, ["version"]) }
      case "commands.list":
        data = await getPage(
          `/v2/panels?scope=${{ private: "c2c", group: "group", channel: "channel", direct: "dm" }[request.input.scope]}`,
          request.input
        )
        return {
          status: "ok",
          items: requiredList(data.records).map((item) =>
            pick(item, ["panel_id", "scope", "target_type", "panel"])
          ),
          nextCursor: string(data.next_cursor),
        }
      case "commands.get":
        data = await call("GET", `/v2/panels/${id(request.input.id)}`)
        return {
          status: "ok",
          resource: pick(data, [
            "panel_id",
            "scope",
            "target_type",
            "panel",
            "user_openids",
            "group_openids",
            "next_cursor",
            "is_end",
          ]),
        }
      case "commands.create":
        data = await call("POST", "/v2/panels", panelBody(request.input.panel))
        if (!string(data.panel_id)) throw new Error("QQ command panel creation was not confirmed")
        return { status: "ok", resource: { id: string(data.panel_id) } }
      case "commands.update":
        data = await call("PUT", `/v2/panels/${id(request.input.id)}`, {
          panel: panelBody(request.input.panel).panel,
        })
        return { status: "ok", resource: pick(data, ["version"]) }
      case "commands.delete":
        await call("DELETE", `/v2/panels/${id(request.input.id)}`)
        return { status: "ok" }
      case "commands.targets": {
        const panel = await call("GET", `/v2/panels/${id(request.input.id)}`)
        if (panel.target_type !== "specific" || !["c2c", "group"].includes(String(panel.scope)))
          throw new TypeError("QQ target changes require a specific C2C/group panel")
        await call("PUT", `/v2/panels/${id(request.input.id)}/target`, {
          op: request.input.action === "remove" ? "del" : "add",
          [panel.scope === "c2c" ? "user_openids" : "group_openids"]: request.input.targetIds,
        })
        return { status: "ok" }
      }
      case "members.list":
        data = await getPage(`/v2/groups/${id(request.input.chatId)}/members`, request.input)
        return {
          status: "ok",
          items: requiredList(data.members).map((m) =>
            pick(m, ["member_openid", "username", "member_role", "joined_at", "bot"])
          ),
          nextCursor: string(data.next_cursor),
        }
      case "members.get":
        data = await call(
          "GET",
          `/v2/groups/${id(request.input.chatId)}/members/${id(request.input.memberId)}`
        )
        return {
          status: "ok",
          resource: pick(data, ["member_openid", "username", "member_role", "joined_at", "bot"]),
        }
      case "members.remove": {
        await assertAdmin(request.input.chatId)
        data = await call("POST", `/v2/groups/${id(request.input.chatId)}/batch_remove_members`, {
          member_openids: request.input.memberIds,
          add_to_member_blacklist: request.input.blockRejoin ?? false,
        })
        if (data.remove_members_result !== "success")
          throw new Error("QQ member removal was not confirmed")
        return {
          status: "ok",
          succeeded: request.input.memberIds,
          failed: Array.isArray(data.add_to_member_blacklist_fail_openids)
            ? data.add_to_member_blacklist_fail_openids.map((value) => ({
                id: String(value),
                reason: "Member removed but rejoin block failed",
              }))
            : [],
        }
      }
      case "blacklist.list":
        data = await getPage(
          `/v2/groups/${id(request.input.chatId)}/member_blacklist`,
          request.input
        )
        return {
          status: "ok",
          items: requiredList(data.users).map((m) =>
            pick(m, ["member_openid", "username", "banned_at"])
          ),
          nextCursor: string(data.next_cursor),
        }
      case "blacklist.update":
        await assertAdmin(request.input.chatId)
        data = await call("POST", `/v2/groups/${id(request.input.chatId)}/member_blacklist`, {
          op: request.input.action === "remove" ? "del" : "add",
          member_openids: request.input.memberIds,
        })
        return {
          status: "ok",
          failed: Array.isArray(data.fail_openids)
            ? data.fail_openids.map((value) => ({
                id: String(value),
                reason: "QQ blacklist operation failed",
              }))
            : [],
        }
      case "moderation.get":
        data = await call("GET", `/v2/groups/${id(request.input.chatId)}/restrict_chat_setting`)
        return { status: "ok", resource: pick(data, ["global_rule", "members"]) }
      case "moderation.set": {
        for (const member of request.input.members) {
          if (member.action === "remove") continue
          if (
            !member.expiresAt ||
            member.expiresAt <= Date.now() ||
            member.expiresAt - Date.now() > 30 * 86400_000
          )
            throw new TypeError("QQ member mute must expire within thirty days")
        }
        await call("POST", `/v2/groups/${id(request.input.chatId)}/restrict_chat_setting`, {
          members: request.input.members.map((m) => ({
            member_openid: m.memberId,
            op: m.action === "remove" ? "del" : m.action,
            mute_expire_at: m.action === "remove" ? "" : new Date(m.expiresAt!).toISOString(),
          })),
        })
        return { status: "ok" }
      }
      case "joinRequests.list":
        data = await getPage(
          `/v2/groups/${id(request.input.chatId)}/join_request_list`,
          request.input
        )
        return {
          status: "ok",
          items: requiredList(data.list).map((m) =>
            pick(m, [
              "join_request_id",
              "member_openid",
              "username",
              "apply_at",
              "apply_source",
              "invited_by",
              "risk_tips",
              "verify_info",
              "auto_approved",
            ])
          ),
          nextCursor: string(data.next_cursor),
        }
      case "joinRequests.decide":
        await call(
          "POST",
          `/v2/groups/${id(request.input.chatId)}/approval_join_request/${id(request.input.memberId)}`,
          {
            op: request.input.decision,
            join_request_id: request.input.requestId,
            ...(request.input.reason ? { reject_reason: request.input.reason } : {}),
            add_to_member_blacklist: request.input.blockRejoin ?? false,
          }
        )
        return { status: "ok" }
      case "joinPolicies.list":
        data = await getPage("/v2/groups/join_approval_strategy", request.input)
        return {
          status: "ok",
          items: requiredList(data.strategies).map((m) =>
            pick(m, [
              "strategy_id",
              "group_openids",
              "is_enable",
              "expire_at",
              "remark",
              "whitelist_user_count",
              "created_at",
              "updated_at",
            ])
          ),
          nextCursor: string(data.next_cursor),
        }
      case "joinPolicies.create":
        data = await call("POST", "/v2/groups/join_approval_strategy", {
          group_openids: request.input.chatIds,
          is_enable: request.input.enabled ? "on" : "off",
          ...(request.input.expiresAt ? { expire_at: request.input.expiresAt } : {}),
          ...(request.input.remarks ? { remark: request.input.remarks } : {}),
        })
        if (!string(data.strategy_id)) throw new Error("QQ join policy creation was not confirmed")
        return { status: "ok", resource: pick(data, ["strategy_id", "is_enable", "expire_at"]) }
      case "joinPolicies.update":
        await call("PATCH", `/v2/groups/join_approval_strategy/${id(request.input.id)}`, {
          ...(request.input.enabled !== undefined
            ? { is_enable: request.input.enabled ? "on" : "off" }
            : {}),
          ...(request.input.expiresAt ? { expire_at: request.input.expiresAt } : {}),
          ...(request.input.remarks ? { remark: request.input.remarks } : {}),
          ...(request.input.groups
            ? {
                group_action: {
                  op: request.input.groups.action === "remove" ? "del" : "add",
                  group_openids: request.input.groups.chatIds,
                },
              }
            : {}),
        })
        return { status: "ok" }
      case "joinPolicies.delete":
        await call("DELETE", `/v2/groups/join_approval_strategy/${id(request.input.id)}`)
        return { status: "ok" }
      case "joinPolicies.allowlist":
        if (request.input.accountIds.some((account) => !/^[1-9]\d{4,19}$/.test(account)))
          throw new TypeError("QQ join policy allowlist requires account numbers as strings")
        data = await call(
          "POST",
          `/v2/groups/join_approval_strategy/${id(request.input.id)}/whitelist_users`,
          {
            op: request.input.action === "remove" ? "del" : "add",
            whitelist_users: request.input.accountIds,
          }
        )
        return {
          status: "ok",
          resource: pick(data, ["strategy_id", "whitelist_user_count", "updated_at"]),
        }
      case "joinPolicies.execute":
        await call("POST", `/v2/groups/join_approval_strategy/${id(request.input.id)}/execute`, {})
        return { status: "accepted" }
    }
    throw new TypeError(
      `Unsupported QQ management operation: ${String(operation)} (${Object.keys(input).length})`
    )
  }
  async function assertAdmin(chatId: string) {
    const state = await call("GET", `/v2/groups/${id(chatId)}/bot_state`)
    if (!["admin", "owner"].includes(String(state.role ?? state.member_role)))
      throw new TypeError("QQ operation requires the bot to be a group administrator")
  }
  return {
    operations: CONNECTOR_MANAGEMENT_OPERATIONS,
    execute: async (request) => {
      const checked = validateConnectorManagementRequest(request)
      const signal = options.signal?.()
      const work = tail
        .catch(() => undefined)
        .then(() => {
          if (signal?.aborted || (signal && signal !== options.signal?.()))
            throw new Error("QQ adapter stopped")
          return execute(checked)
        })
      tail = work
      return work
    },
  }
}
