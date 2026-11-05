/**
 * Avatar lookup for Lark actors, contributed to the framework's avatar
 * resolver (`lib/connectors/platform-avatar.ts`, through `./contribution.ts`).
 *
 * Bots resolve through the verified self identity or a sibling adapter's
 * confirmed whoami, apps through `/application/v6/applications`, users and
 * chats through the contact and chat APIs. Every URL Lark returns passes the
 * framework's `publicUrl` screen before it is used.
 */

import type { AvatarSource } from "@/lib/connectors/platform-avatar"
import type { ConnectorVendorAvatarContext } from "@/lib/connectors/vendor-contribution"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { larkTenantRequest } from "./http"

const LARK = "lark"

// The resolver's own readers (`platform-avatar.ts`), kept identical.
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export async function resolveLarkAvatar(
  context: ConnectorVendorAvatarContext
): Promise<AvatarSource | undefined> {
  const { target, adapter } = context
  const { adapterId, kind, remoteId } = target
  const encode = encodeURIComponent
  const [appId, appSecret] = await Promise.all([
    connectorsKeyringGet(adapterId, "appId"),
    connectorsKeyringGet(adapterId, "appSecret"),
  ])
  if (!appId || !appSecret || !context.active()) return undefined
  const tenantRequest = (path: string, purpose: "service-data" | "adapter-admin") =>
    larkTenantRequest({ appId, appSecret }, "GET", path, undefined, purpose, {
      avatarPolicy: true,
    })
  if (target.actorKind === "bot" || target.remoteIdType === "app_id") {
    const whoami = record(adapter.lastWhoamiResult)
    const own = remoteId === appId || (whoami?.appId === appId && whoami.openId === remoteId)
    if (!own && target.remoteIdType !== "app_id") {
      const siblings = await listAdapterInstancesByType(LARK)
      if (!context.active()) return undefined
      for (const sibling of siblings) {
        const identity = sibling.lastWhoamiResult
        if (identity?.openId !== remoteId || !identity.botAvatar) continue
        const confirmedAppId = await connectorsKeyringGet(sibling.id, "appId")
        if (!context.active()) return undefined
        const safe =
          confirmedAppId === identity.appId
            ? context.publicUrl(identity.botAvatar, true)
            : undefined
        if (safe) return { url: safe }
      }
    }
    // Only the verified self bot may use bot/v3/info. Never substitute its
    // picture for an unknown bot's open_id or query contact users with app_id.
    if (own || target.remoteIdType !== "app_id") {
      const bot = record(record(await tenantRequest("/bot/v3/info", "adapter-admin"))?.bot)
      if (!context.active()) return undefined
      if (own || bot?.open_id === remoteId) {
        const safe = context.publicUrl(bot?.avatar_url, true)
        return safe ? { url: safe } : undefined
      }
      return undefined
    }
    const app = record(
      record(
        record(
          await tenantRequest(
            `/application/v6/applications/${encode(remoteId)}?lang=zh_cn`,
            "service-data"
          )
        )?.data
      )?.app
    )
    const safe = context.publicUrl(app?.avatar_url, true)
    return safe ? { url: safe } : undefined
  }
  const result = record(
    await tenantRequest(
      kind === "user"
        ? `/contact/v3/users/${encode(remoteId)}?user_id_type=open_id`
        : `/im/v1/chats/${encode(remoteId)}`,
      "service-data"
    )
  )
  const data = record(result?.data)
  const avatar = record(record(data?.user)?.avatar)
  const url =
    kind === "user"
      ? (str(avatar?.avatar_240) ?? str(avatar?.avatar_72) ?? str(avatar?.avatar_640))
      : data?.avatar
  const safe = context.publicUrl(url, true)
  return safe ? { url: safe } : undefined
}
