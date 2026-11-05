/**
 * Adapter factory registry — Task 41 + Task 68 + Task 80 + Task 93 + Task 107.
 *
 * Switch on AdapterInstanceRow.type to instantiate the correct PlatformAdapter.
 * Phase 1 ships Telegram, Discord, Slack, Lark, and OneBot. A vendor with a
 * contribution (`adapters/_vendors.ts`, ADR-0250 §14) builds its own adapter.
 *
 * NOTE: OneBot does NOT use OAuth. It uses a reverse-WebSocket transport — the
 * QQ client connects to cognia-next, not the other way around. No OAuth flow is
 * needed; the only optional credential is the bearer token stored in the keyring
 * under `<adapterId>:onebotBearer`.
 */

import type { PlatformAdapter } from "@/types/connectors"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { connectorsKeyringGet, connectorsKeyringGetSnapshot } from "@/lib/connectors/tauri/commands"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { createTelegramAdapter } from "./adapters/telegram"
import { createDiscordAdapter } from "./adapters/discord"
import { fetchDiscordBotUser } from "./whoami/discord-whoami"
import { createSlackAdapter } from "./adapters/slack"
import { createOneBotAdapter } from "./adapters/onebot"
import { createWeComAdapter } from "./adapters/wecom"
import type { WeComAdapterSettings } from "./adapters/wecom/welcome"
import { createWechatPersonalAdapter } from "./adapters/wechat-personal"
import { createMatrixAdapter } from "./adapters/matrix"
import { matrixWhoamiDetailed } from "./adapters/matrix/auth"
import { createQQOfficialAdapter } from "./adapters/qq-official"
import { clearQQTokenCache, getQQAccessToken } from "./adapters/qq-official/auth"
import { createWechatOaAdapter } from "./adapters/wechat-oa"
import { getWechatOaAccessToken } from "./adapters/wechat-oa/auth"
import { createDingTalkAdapter } from "./adapters/dingtalk"
import { getDingTalkAccessToken } from "./adapters/dingtalk/auth"
import { buildPluginAdapter } from "@/lib/connectors/plugin-connector-registry"
import { connectorVendor } from "./vendor-contribution"

/**
 * Build and return a PlatformAdapter for the given row.
 *
 * Returns null for unsupported adapter types (logs a warning).
 */
export async function buildAdapterFromRow(
  row: AdapterInstanceRow
): Promise<PlatformAdapter | null> {
  // A contributed vendor builds its own adapter (ADR-0250 §14).
  const vendor = connectorVendor(row.type)
  if (vendor?.buildAdapter) return vendor.buildAdapter(row)
  switch (row.type) {
    case "telegram":
      return buildTelegramAdapter(row)
    case "discord":
      return buildDiscordAdapter(row)
    case "slack":
      return buildSlackAdapter(row)
    case "onebot":
      return buildOneBotAdapter(row)
    case "wecom":
      return buildWeComAdapter(row)
    case "wechat-personal":
      return buildWechatPersonalAdapter(row)
    case "matrix":
      return buildMatrixAdapter(row)
    case "qq-official":
      return buildQQOfficialAdapter(row)
    case "wechat-oa":
      return buildWechatOaAdapter(row)
    case "dingtalk":
      return buildDingTalkAdapter(row)
    default: {
      // Plugin-contributed kinds resolve through the registry, so a
      // plugin-backed bot is an ordinary instance row and inherits the whole
      // supervisor path — start, stop, hot reconcile, health, audit — instead
      // of the bridge starting one unmanaged adapter per plugin.
      const pluginAdapter = await buildPluginAdapter(row)
      if (pluginAdapter) return pluginAdapter
      // An instance whose plugin is disabled or uninstalled. The row survives
      // on purpose (its settings and credentials are still the user's), so say
      // why rather than pretending the type never existed.
      console.warn(
        `[adapter-registry] no implementation for adapter type "${row.type}" (id=${row.id}) — ` +
          `either an unsupported platform, or a plugin connector whose plugin is not enabled`
      )
      return null
    }
  }
}

/**
 * Instantiate a Telegram PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the bot token from the keyring and calls getMe to fetch the bot's
 * own user id (selfId), then delegates to createTelegramAdapter.
 */
export async function buildTelegramAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const transport = row.transportMode === "webhook" ? "webhook" : "longpoll"

  // Resolve selfId by calling getMe via the Tauri HTTP proxy
  const tokenRaw = await connectorsKeyringGet(row.id, "botToken")
  const token = tokenRaw ?? ""

  let selfId = ""
  try {
    const resp = await connectorsHttpRequest({
      url: `https://api.telegram.org/bot${token}/getMe`,
      method: "GET",
    })
    const parsed = JSON.parse(resp.body) as { ok: boolean; result?: { id?: number } }
    if (parsed.ok && parsed.result?.id !== undefined) {
      selfId = String(parsed.result.id)
    }
  } catch {
    // Non-fatal: selfId will be empty string; adapter still starts but may
    // not correctly detect self-mentions.
    console.warn(`[adapter-registry] getMe failed for adapter ${row.id}`)
  }

  return createTelegramAdapter({
    id: row.id,
    displayName: row.displayName,
    transport,
    botToken: () => connectorsKeyringGet(row.id, "botToken").then((t) => t ?? ""),
    selfId,
  })
}

/**
 * Instantiate a Discord PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Resolves the bot's own user id (selfId) via the shared whoami probe
 * helper (`fetchDiscordBotUser` — GET /users/@me), then delegates to
 * createDiscordAdapter.
 */
export async function buildDiscordAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const tokenRaw = await connectorsKeyringGet(row.id, "botToken")
  const token = tokenRaw ?? ""

  let selfId = ""
  try {
    selfId = (await fetchDiscordBotUser(token)).id
  } catch {
    // Non-fatal: selfId will be empty string; adapter refreshes from READY event.
    console.warn(`[adapter-registry] /users/@me failed for Discord adapter ${row.id}`)
  }

  const intentsRaw = (row.settings as Record<string, unknown> | undefined)?.intents
  const intents = typeof intentsRaw === "number" ? intentsRaw : undefined

  return createDiscordAdapter({
    id: row.id,
    displayName: row.displayName,
    botToken: () => connectorsKeyringGet(row.id, "botToken").then((t) => t ?? ""),
    selfId,
    intents,
    transportMode: row.transportMode,
  })
}

/**
 * Instantiate a Slack PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the bot token from the keyring and calls auth.test to fetch the
 * bot's own user id (selfId), then delegates to createSlackAdapter.
 */
export async function buildSlackAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const tokenRaw = await connectorsKeyringGet(row.id, "botToken")
  const token = tokenRaw ?? ""

  const settings = (row.settings ?? {}) as {
    transport?: "socket-mode" | "events-api-webhook"
    assistantAppEnabled?: unknown
    historyMaxPages?: unknown
  }
  const transport: "socket-mode" | "events-api-webhook" =
    settings.transport === "events-api-webhook" ? "events-api-webhook" : "socket-mode"

  // Validate historyMaxPages: a positive number (form inputs may persist it
  // as a string) — anything else falls back to the adapter default (10).
  const historyMaxPagesRaw = Number(settings.historyMaxPages)
  const historyMaxPages =
    Number.isFinite(historyMaxPagesRaw) && historyMaxPagesRaw >= 1
      ? Math.floor(historyMaxPagesRaw)
      : undefined

  let selfId = ""
  try {
    const resp = await connectorsHttpRequest({
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    })
    const parsed = JSON.parse(resp.body) as { ok: boolean; user_id?: string }
    if (parsed.ok && parsed.user_id) {
      selfId = parsed.user_id
    }
  } catch {
    // Non-fatal: selfId will be empty string; adapter still starts but may
    // not correctly detect self-mentions.
    console.warn(`[adapter-registry] auth.test failed for Slack adapter ${row.id}`)
  }

  return createSlackAdapter({
    id: row.id,
    displayName: row.displayName,
    botToken: () => connectorsKeyringGet(row.id, "botToken").then((t) => t ?? ""),
    appToken: () => connectorsKeyringGet(row.id, "appToken").then((t) => t ?? ""),
    signingSecret: () => connectorsKeyringGet(row.id, "signingSecret").then((t) => t ?? ""),
    // Canonical key is "userToken"; fall back to the legacy "user_token"
    // key the Slack OAuth handler wrote before the key unification, so
    // installs completed via OAuth keep their presence-status support.
    userToken: async () => {
      // Scheduled presence updates have no verified personal authorizer.
      const { admitPersonalCredential } = await import("@/lib/execution/personal-credential")
      if (!(await admitPersonalCredential(undefined, { source: "slack-user", person: row.id })).ok)
        return ""
      const token = await connectorsKeyringGet(row.id, "userToken")
      if (token) return token
      return (await connectorsKeyringGet(row.id, "user_token")) ?? ""
    },
    selfId,
    transport,
    assistantAppEnabled: settings.assistantAppEnabled === true,
    ...(historyMaxPages !== undefined ? { historyMaxPages } : {}),
  })
}

/**
 * Instantiate a OneBot PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Two transport directions are supported (selected by `row.transportMode`):
 *   - reverse-ws (default): the QQ client (NapCat/Lagrange/LLOneBot) dials
 *     cognia-next; transport starts when the WS connection is established.
 *   - forward-ws: cognia dials the NapCat WS server at
 *     `settings.forwardWsUrl` (e.g. `ws://host:3001`).
 *
 * NOTE: OneBot does not use OAuth. The only credential is the optional
 * bearer/access token (`onebotBearer`) stored in the keyring — for forward-ws
 * it is sent as `Authorization: Bearer`.
 */
export async function buildOneBotAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as {
    selfBotUin?: string
    expectedClient?: "napcat" | "lagrange" | "llonebot"
    forwardWsUrl?: string
  }
  const selfBotUin = settings.selfBotUin ?? ""
  const transportMode = row.transportMode === "forward-ws" ? "forward-ws" : "reverse-ws"

  return createOneBotAdapter({
    id: row.id,
    displayName: row.displayName,
    selfBotUin,
    bearerToken: () => connectorsKeyringGet(row.id, "onebotBearer").then((t) => t ?? ""),
    expectedClient: settings.expectedClient,
    transportMode,
    forwardWsUrl: settings.forwardWsUrl,
  })
}

/**
 * Instantiate a WeCom 智能机器人 PlatformAdapter from a persisted row.
 *
 * Reads `botId` + `secret` from the keyring (the long-connection credentials)
 * and passes the non-secret settings (welcome message) through. No identity
 * probe is needed — the bot's `aibotid` arrives on the first inbound frame and
 * the adapter captures it as `selfId`.
 */
export async function buildWeComAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  return createWeComAdapter({
    id: row.id,
    displayName: row.displayName,
    botId: () => connectorsKeyringGet(row.id, "botId").then((v) => v ?? ""),
    secret: () => connectorsKeyringGet(row.id, "secret").then((v) => v ?? ""),
    settings: (row.settings ?? {}) as WeComAdapterSettings,
  })
}

/**
 * Instantiate a personal-WeChat (iLink) PlatformAdapter from a persisted row.
 *
 * Reads the iLink `botToken` from the keyring (obtained via the QR-login
 * wizard) and the per-session `baseUrl` from non-secret settings. iLink is a
 * reply-only HTTP long-poll channel; no identity probe.
 */
export async function buildWechatPersonalAdapter(
  row: AdapterInstanceRow
): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as { baseUrl?: string }
  return createWechatPersonalAdapter({
    id: row.id,
    displayName: row.displayName,
    token: () => connectorsKeyringGet(row.id, "botToken").then((v) => v ?? ""),
    tokenSnapshot: () => connectorsKeyringGetSnapshot(row.id, "botToken"),
    baseUrl: async () => settings.baseUrl ?? "",
  })
}

/**
 * Instantiate a Matrix PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the access token from the keyring and the non-secret homeserver URL
 * from `settings.homeserver`, then calls detailed `whoami` to resolve both
 * the user and device identity required by matrix-sdk-crypto. A missing
 * device id is passed through as an empty value so the adapter enters its
 * actionable degraded state without starting sync or sending plaintext.
 */
export async function buildMatrixAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const settings = (row.settings ?? {}) as { homeserver?: string }
  const homeserver = settings.homeserver ?? ""

  const accessTokenRaw = await connectorsKeyringGet(row.id, "accessToken")
  const accessToken = accessTokenRaw ?? ""

  let selfId = ""
  let deviceId = ""
  try {
    const resolved = await matrixWhoamiDetailed(homeserver, accessToken)
    if (resolved) {
      selfId = resolved.userId
      deviceId = resolved.deviceId ?? ""
    }
  } catch {
    console.warn(`[adapter-registry] whoami failed for Matrix adapter ${row.id}`)
  }

  return createMatrixAdapter({
    id: row.id,
    displayName: row.displayName,
    homeserver,
    accessToken: () => connectorsKeyringGet(row.id, "accessToken").then((t) => t ?? ""),
    selfId,
    deviceId,
  })
}

/**
 * Instantiate a QQ Official Bot PlatformAdapter from a persisted row.
 *
 * Reads `appId` + `clientSecret` from the keyring; the access token is
 * resolved (and cached) on demand by `getQQAccessToken`. No identity probe is
 * needed — the bot's id arrives on the gateway READY event (webhook mode has
 * no READY; selfId stays empty there).
 *
 * `transportMode` is the only transport source FOR THIS PLATFORM. That is not
 * true repo-wide: `buildSlackAdapter` above and Lark's `buildLarkAdapter` still read
 * `settings.transport`, which is a separate persisted field carrying the
 * platform-specific spelling (`socket-mode` / `events-api-webhook`,
 * `long-connection` / `webhook`) that those factories need. There is no
 * migration reconciling the two, so `adapterNeedsInboundServer` deliberately
 * trusts the adapter's declared `transportModes` over the row.
 */
export async function buildQQOfficialAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  const credentials = async () => ({
    appId: (await connectorsKeyringGet(row.id, "appId")) ?? "",
    secret: (await connectorsKeyringGet(row.id, "clientSecret")) ?? "",
  })
  return createQQOfficialAdapter({
    id: row.id,
    displayName: row.displayName,
    transportMode: row.transportMode === "webhook" ? "webhook" : "gateway",
    receiveGuildMessages: row.settings.receiveGuildMessages === true,
    receiveMessageAudit: row.settings.receiveMessageAudit === true,
    // Startup identity confirmation happens after start(), so read its latest
    // persisted result instead of retaining the row used to build the adapter.
    selfId: async () => (await getAdapterInstance(row.id))?.selfIdentity?.platformAccountId ?? "",
    accessToken: async () => {
      const { appId, secret } = await credentials()
      return getQQAccessToken(appId, secret)
    },
    // Lets `refreshCredentials()` and the gateway's INVALID_SESSION path
    // evict the cached mint for THIS row's credential pair.
    clearTokenCache: async () => {
      const { appId, secret } = await credentials()
      clearQQTokenCache(appId, secret)
    },
  })
}

/**
 * Instantiate a WeChat Official Account PlatformAdapter from a persisted row.
 *
 * Reads `appId` + `appSecret` from the keyring for the access token; the
 * webhook `token` + `encodingAesKey` are also stored in the keyring (read by
 * the Rust webhook handler under the same adapter id). No identity probe is
 * needed — the official account id arrives on the first inbound message.
 */
export async function buildWechatOaAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  return createWechatOaAdapter({
    id: row.id,
    displayName: row.displayName,
    accessToken: async () => {
      const appId = (await connectorsKeyringGet(row.id, "appId")) ?? ""
      const appSecret = (await connectorsKeyringGet(row.id, "appSecret")) ?? ""
      return getWechatOaAccessToken(appId, appSecret)
    },
  })
}

/**
 * Instantiate a DingTalk PlatformAdapter from a persisted AdapterInstanceRow.
 *
 * Reads the AppKey + AppSecret from the keyring. Inbound uses Stream mode
 * (clientId/clientSecret = appKey/appSecret); outbound mints an app access
 * token from the same credentials. All three are resolvers so a rotated
 * credential is picked up on the next call without a restart.
 */
export async function buildDingTalkAdapter(row: AdapterInstanceRow): Promise<PlatformAdapter> {
  return createDingTalkAdapter({
    id: row.id,
    displayName: row.displayName,
    appKey: () => connectorsKeyringGet(row.id, "appKey").then((v) => v ?? ""),
    appSecret: () => connectorsKeyringGet(row.id, "appSecret").then((v) => v ?? ""),
    accessToken: async () => {
      const appKey = (await connectorsKeyringGet(row.id, "appKey")) ?? ""
      const appSecret = (await connectorsKeyringGet(row.id, "appSecret")) ?? ""
      return getDingTalkAccessToken(appKey, appSecret)
    },
  })
}
