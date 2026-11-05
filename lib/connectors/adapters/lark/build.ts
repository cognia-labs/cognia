/**
 * Build a Lark adapter from its persisted row, and refresh the bot's own
 * open_id on demand. Contributed to the adapter registry through
 * `./contribution.ts` (ADR-0250 §14); the refresh is the Lark form's
 * "Refresh bot open_id" affordance.
 */

import type { PlatformAdapter } from "@/types/connectors"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { normalizeQuickCommandList } from "@/lib/connectors/quick-commands"
import { resolveWebEntryBase } from "@/lib/connectors/adapters/lark/entry/deep-links"
import { getTenantToken } from "@/lib/auth-providers/feishu/auth"
import { createLarkAdapter } from "./index"
import { normalizeLarkCardPresentation } from "./card-presentation"

/**
 * Instantiate a Lark PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads App ID + App Secret from the keyring, obtains a tenant_access_token to
 * call /open-apis/bot/v3/info, and resolves the bot's own open_id (selfBotOpenId).
 * If the API call fails the adapter still starts, but with an EMPTY
 * selfBotOpenId — self-mention detection is disabled (there is no header
 * fallback; the factory warns loudly) until the whoami probe succeeds.
 *
 * Caches a successful probe back to `row.settings.selfBotOpenId` so the
 * next cold start can skip the API call. The cache is invalidated by the
 * UI affordance `refreshSelfBotOpenId(adapterId)` (Settings → Lark form).
 */
export async function buildLarkAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as {
    transport?: "long-connection" | "webhook"
    selfBotOpenId?: string
    /**
     * Persisted Dexie rows may carry the legacy `eventKey` shape from
     * before the cross-adapter rename to `triggerKey`. We pass through
     * `normalizeQuickCommandList` below so the factory always sees
     * canonical rows.
     */
    quickCommands?: unknown
    [key: string]: unknown
  }
  const transport: "long-connection" | "webhook" =
    settings.transport === "webhook" ? "webhook" : "long-connection"

  const appIdRaw = await connectorsKeyringGet(row.id, "appId")
  const appId = appIdRaw ?? ""
  const appSecretRaw = await connectorsKeyringGet(row.id, "appSecret")
  const appSecret = appSecretRaw ?? ""

  // Resolve the bot's own open_id to enable accurate self-mention detection.
  let selfBotOpenId = settings.selfBotOpenId ?? ""

  // Skip the probe when we already have a cached open_id; the
  // `refreshSelfBotOpenId` affordance is the canonical way to flush a
  // stale cache.
  if (!selfBotOpenId) {
    try {
      const tat = await getTenantToken({ appId, appSecret }, "adapter-admin")
      const resp = await connectorsHttpRequest({
        url: "https://open.feishu.cn/open-apis/bot/v3/info",
        method: "GET",
        headers: { Authorization: `Bearer ${tat}` },
      })
      const parsed = JSON.parse(resp.body) as {
        code?: number
        bot?: { open_id?: string }
      }
      if (parsed.code === 0 && parsed.bot?.open_id) {
        selfBotOpenId = parsed.bot.open_id
        // Persist the resolved open_id back to the row so subsequent
        // cold starts skip this probe. Best-effort — a Dexie write
        // failure must not break adapter startup.
        try {
          await updateAdapterInstance(row.id, {
            settings: { ...settings, selfBotOpenId },
          })
        } catch (err) {
          console.warn(
            `[adapter-registry] failed to persist selfBotOpenId for ${row.id}:`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    } catch {
      // Non-fatal: selfBotOpenId will be empty; adapter still starts but mention
      // detection may miss cases where the bot is addressed without an explicit @.
      console.warn(`[adapter-registry] bot/v3/info failed for Lark adapter ${row.id}`)
    }
  }

  return createLarkAdapter({
    id: row.id,
    displayName: row.displayName,
    appId: () => connectorsKeyringGet(row.id, "appId").then((v) => v ?? ""),
    appSecret: () => connectorsKeyringGet(row.id, "appSecret").then((v) => v ?? ""),
    encryptKey: () => connectorsKeyringGet(row.id, "encryptKey").then((v) => v ?? ""),
    verificationToken: () => connectorsKeyringGet(row.id, "verificationToken").then((v) => v ?? ""),
    selfBotOpenId,
    quickCommands: normalizeQuickCommandList(settings.quickCommands),
    sendAsUser: settings.sendAsUser === true,
    replyInThread: settings.replyInThread !== false,
    webEntryBaseUrl: resolveWebEntryBase(row),
    cardPresentation: normalizeLarkCardPresentation(settings.cardPresentation),
    transport,
  })
}

export interface RefreshSelfBotOpenIdSuccess {
  ok: true
  openId: string
}

export interface RefreshSelfBotOpenIdFailure {
  ok: false
  reason: "not-lark" | "missing-credentials" | "tat-failed" | "api-failed"
  message: string
}

export type RefreshSelfBotOpenIdResult = RefreshSelfBotOpenIdSuccess | RefreshSelfBotOpenIdFailure

/**
 * Re-run the `/open-apis/bot/v3/info` probe the adapter normally runs at
 * startup, and persist the resolved `open_id` back to the adapter row's
 * `settings.selfBotOpenId` so the next cold start can skip the probe.
 *
 * Surfaced as an explicit affordance in the Lark form (Identity section →
 * "Refresh bot open_id") so when the silent startup probe fails the
 * operator can see why instead of guessing why mention detection is
 * degraded.
 */
export async function refreshSelfBotOpenId(adapterId: string): Promise<RefreshSelfBotOpenIdResult> {
  const row = await getAdapterInstance(adapterId)
  if (!row) {
    return { ok: false, reason: "missing-credentials", message: `Adapter not found: ${adapterId}` }
  }
  if (row.type !== "lark") {
    return {
      ok: false,
      reason: "not-lark",
      message: `Adapter type ${row.type} does not have a self bot open_id`,
    }
  }

  const appIdRaw = await connectorsKeyringGet(adapterId, "appId")
  const appSecretRaw = await connectorsKeyringGet(adapterId, "appSecret")
  const appId = appIdRaw ?? ""
  const appSecret = appSecretRaw ?? ""
  if (!appId || !appSecret) {
    return {
      ok: false,
      reason: "missing-credentials",
      message: "App ID and App Secret must be saved before refreshing the bot open_id",
    }
  }

  let tat: string
  try {
    tat = await getTenantToken({ appId, appSecret }, "adapter-admin")
  } catch (err) {
    return {
      ok: false,
      reason: "tat-failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    const resp = await connectorsHttpRequest({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: `Bearer ${tat}` },
    })
    // Lark /open-apis/bot/v3/info returns `{code, msg, bot: {open_id, ...}}`
    // (mirrors `whoami.ts`'s `LarkBotInfoResponse`). The earlier `data.open_id`
    // shape was a misread of the docs and made this affordance always fail.
    const parsed = JSON.parse(resp.body) as {
      code?: number
      msg?: string
      bot?: { open_id?: string }
    }
    if (parsed.code !== 0 || !parsed.bot?.open_id) {
      return {
        ok: false,
        reason: "api-failed",
        message: parsed.msg ?? `Lark returned code ${parsed.code ?? "?"}`,
      }
    }
    const openId = parsed.bot.open_id
    const nextSettings = { ...(row.settings ?? {}), selfBotOpenId: openId }
    await updateAdapterInstance(adapterId, { settings: nextSettings })
    return { ok: true, openId }
  } catch (err) {
    return {
      ok: false,
      reason: "api-failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
