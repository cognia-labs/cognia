/** Shared validation/discovery boundary for optional connector management. */
import { z } from "zod"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { evaluateFetchTarget } from "@cognia/network-guard"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { Capability } from "@/types/connectors/capability"
import type {
  ConnectorMenuItem,
  ConnectorManagementOperation,
  ConnectorManagementRequest,
  ConnectorLink,
} from "@/types/connectors/management"
import { rememberConnectorAssets, requireConnectorAsset, forgetConnectorAsset } from "./assets"

const id = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s))
const page = { cursor: id.optional(), limit: z.number().int().min(1).max(50).optional() }
const chat = { chatId: id }
const action = z.enum(["add", "remove"])
const memberIds = z.array(id).min(1).max(20)
const label = z.string().trim().min(1).max(256)
const menu: z.ZodType<ConnectorMenuItem> = z.lazy(() =>
  z
    .object({
      key: id,
      label,
      action: z
        .object({ type: z.enum(["prompt", "slash", "link"]), value: label })
        .strict()
        .optional(),
      children: z.array(menu).min(1).max(20).optional(),
      toggle: z.object({ enabled: z.boolean() }).strict().optional(),
    })
    .strict()
    .refine((item) => [item.action, item.children, item.toggle].filter(Boolean).length === 1)
)
const panel = z
  .object({
    scope: z.enum(["private", "group", "channel", "direct"]),
    audience: z.enum(["all", "specific"]),
    name: label,
    remarks: z.string().max(255).optional(),
    items: z
      .array(
        z
          .object({
            name: label,
            description: z.string().max(256),
            url: id.optional(),
            adminOnly: z.boolean().optional(),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict()
const source = z
  .object({
    url: z.string().max(8192).optional(),
    dataBase64: z.string().max(13_333_336).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.url) !== Boolean(v.dataBase64))
const schemas = {
  "links.create": z
    .object({
      purpose: z.literal("add-contact"),
      state: z
        .string()
        .max(1024)
        .refine((value) => [...value].length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value))
        .optional(),
    })
    .strict(),
  "assets.upload": z
    .object({
      name: label,
      mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      source,
    })
    .strict(),
  "assets.list": z.object({ cursor: id.optional() }).strict(),
  "assets.delete": z.object({ id }).strict(),
  "menus.get": z.object({}).strict(),
  "menus.set": z.object({ items: z.array(menu).max(20) }).strict(),
  "commands.list": z.object({ ...page, scope: panel.shape.scope }).strict(),
  "commands.get": z.object({ id }).strict(),
  "commands.create": z.object({ panel }).strict(),
  "commands.update": z.object({ id, panel }).strict(),
  "commands.delete": z.object({ id }).strict(),
  "commands.targets": z.object({ id, action, targetIds: memberIds }).strict(),
  "members.list": z.object({ ...chat, cursor: id.optional() }).strict(),
  "members.get": z.object({ ...chat, memberId: id }).strict(),
  "members.remove": z.object({ ...chat, memberIds, blockRejoin: z.boolean().optional() }).strict(),
  "blacklist.list": z.object({ ...chat, ...page }).strict(),
  "blacklist.update": z.object({ ...chat, action, memberIds }).strict(),
  "moderation.get": z.object(chat).strict(),
  "moderation.set": z
    .object({
      ...chat,
      members: z
        .array(
          z
            .object({
              memberId: id,
              action: z.enum(["add", "update", "remove"]),
              expiresAt: z.number().int().positive().optional(),
            })
            .strict()
        )
        .min(1)
        .max(20),
    })
    .strict(),
  "joinRequests.list": z.object({ ...chat, ...page }).strict(),
  "joinRequests.decide": z
    .object({
      ...chat,
      memberId: id,
      requestId: id,
      decision: z.enum(["approve", "decline"]),
      reason: z.string().max(256).optional(),
      blockRejoin: z.boolean().optional(),
    })
    .strict(),
  "joinPolicies.list": z.object(page).strict(),
  "joinPolicies.create": z
    .object({
      chatIds: z.array(id).min(1).max(100),
      enabled: z.boolean(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
      remarks: z.string().max(255).optional(),
    })
    .strict(),
  "joinPolicies.update": z
    .object({
      id,
      enabled: z.boolean().optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
      remarks: z.string().max(255).optional(),
      groups: z
        .object({ action, chatIds: z.array(id).min(1).max(100) })
        .strict()
        .optional(),
    })
    .strict(),
  "joinPolicies.delete": z.object({ id }).strict(),
  "joinPolicies.allowlist": z
    .object({ id, action, accountIds: z.array(id).min(1).max(10_000) })
    .strict(),
  "joinPolicies.execute": z.object({ id }).strict(),
} satisfies Record<ConnectorManagementOperation, z.ZodType>

export const CONNECTOR_MANAGEMENT_OPERATIONS = Object.keys(
  schemas
) as ConnectorManagementOperation[]
const reads = new Set<ConnectorManagementOperation>([
  "assets.list",
  "menus.get",
  "commands.list",
  "commands.get",
  "members.list",
  "members.get",
  "blacklist.list",
  "moderation.get",
  "joinRequests.list",
  "joinPolicies.list",
])
export function connectorManagementIsRead(operation: ConnectorManagementOperation) {
  return reads.has(operation)
}
export function connectorManagementCapability(operation: ConnectorManagementOperation): Capability {
  const family = operation.split(".")[0]
  if (family === "links") return "links.create"
  if (family === "assets") return "assets.manage"
  if (family === "menus") return "menus.manage"
  if (family === "commands") return "commands.manage"
  if (family === "members")
    return operation === "members.remove" ? "chat.members.remove" : "chat.members.read"
  if (family === "joinRequests") return "chat.join.requests"
  if (family === "joinPolicies") return "chat.join.policies"
  return "chat.moderation"
}

export function listConnectorManagementOperations(adapter: PlatformAdapter | undefined) {
  return CONNECTOR_MANAGEMENT_OPERATIONS.filter(
    (operation) =>
      adapter?.management?.operations.includes(operation) &&
      adapter.meta.capabilities.includes(connectorManagementCapability(operation))
  ).map((operation) => ({
    operation,
    mutation: connectorManagementIsRead(operation) ? ("read" as const) : ("destructive" as const),
    capability: connectorManagementCapability(operation),
  }))
}

/** Checks only outbound human-authored text; opaque ids and explicit bytes are not prose. */
function authoredText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(authoredText)
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) =>
    ["label", "name", "description", "remarks", "reason", "url", "state"].includes(key) &&
    typeof item === "string"
      ? [item]
      : key === "action" && typeof item === "object" && item && "value" in item
        ? [String(item.value)]
        : key === "source"
          ? []
          : authoredText(item)
  )
}

/** Validate provider receipts too: callers must never receive an unsafe invitation. */
export function validateConnectorLink(link: ConnectorLink): ConnectorLink {
  if (
    !link ||
    link.purpose !== "add-contact" ||
    typeof link.url !== "string" ||
    !link.url.length ||
    link.url.length > 8192 ||
    /[\u0000-\u0020\u007f-\u009f]/.test(link.url)
  )
    throw new TypeError("Invalid connector link receipt")
  let url: URL
  try {
    url = new URL(link.url)
  } catch {
    throw new TypeError("Invalid connector link receipt")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !evaluateFetchTarget(link.url).allowed
  )
    throw new TypeError("Connector link must use public HTTPS without credentials")
  return { purpose: link.purpose, url: url.href }
}

export function validateConnectorManagementRequest(
  request: ConnectorManagementRequest
): ConnectorManagementRequest {
  if (request.operation === "menus.set" && Array.isArray(request.input?.items)) {
    const pending = request.input.items.map((item) => ({ item, depth: 1 }))
    let count = 0
    while (pending.length) {
      const { item, depth } = pending.pop()!
      if (++count > 200 || depth > 4)
        throw new TypeError("Connector menu exceeds the shared size/depth limit")
      if (item && Array.isArray(item.children))
        pending.push(...item.children.map((child) => ({ item: child, depth: depth + 1 })))
    }
  }
  const schema = schemas[request.operation]
  const parsed = schema.safeParse(request.input)
  if (!parsed.success) throw new TypeError("Invalid connector management parameters")
  const checked = { operation: request.operation, input: parsed.data } as ConnectorManagementRequest
  if (!hasNoLeakingPiiDeep(authoredText(checked.input)))
    throw new Error("Connector management text rejected by the PII gate")
  if (checked.operation === "assets.upload") {
    const src = checked.input.source
    if (src.url) {
      const url = new URL(src.url)
      if (!evaluateFetchTarget(src.url).allowed || url.username || url.password)
        throw new TypeError("Asset source must be a public HTTP(S) URL without credentials")
    } else {
      const data = src.dataBase64!
      if (
        !data.length ||
        data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
        (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) > 10_000_000
      )
        throw new TypeError("Asset bytes must be valid base64 within the upload limit")
    }
  }
  return checked
}

export async function executeConnectorManagement(
  adapter: PlatformAdapter | undefined,
  request: ConnectorManagementRequest
) {
  if (
    !adapter?.management ||
    !listConnectorManagementOperations(adapter).some((d) => d.operation === request.operation)
  )
    throw new Error("Connector management operation is unsupported by this adapter")
  if (adapter.health().state !== "running") throw new Error("Connector is not running")
  const checked = validateConnectorManagementRequest(request)
  if (checked.operation === "assets.delete")
    await requireConnectorAsset(adapter.id, checked.input.id)
  const result = await adapter.management.execute(checked)
  if (checked.operation === "links.create") {
    if (result.status !== "ok" || !result.link)
      throw new TypeError("Invalid connector link receipt")
    return { status: "ok" as const, link: validateConnectorLink(result.link) }
  }
  if (result.asset) await rememberConnectorAssets(adapter.id, [result.asset])
  if (result.assets) await rememberConnectorAssets(adapter.id, result.assets)
  if (checked.operation === "assets.delete" && result.status === "ok")
    await forgetConnectorAsset(adapter.id, checked.input.id)
  return result
}
