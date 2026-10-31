/**
 * PII red-line for plugin-initiated model calls.
 *
 * The app-wide rule (Twin/Goal/Connector auto-mode, enforced via
 * `packages/redact/src/index.ts:hasNoLeakingPii` and the
 * `lib/connectors/ai-loop/safe-send-prompt.ts` wrapper) is: raw
 * user-supplied text MUST pass the PII gate before it leaves the device.
 * `ctx.ai.chat/embed` and `ctx.vector.embed/embedBatch` are plugin-driven
 * model sends with no human review step, so the same gate applies here.
 */

import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

export type PluginEgressPiiPolicy = "redact" | "block"

export interface PluginNetworkEgressInput {
  url: string
  headers?: Record<string, string>
  body?: unknown
  piiPolicy?: PluginEgressPiiPolicy
}

export interface PluginNetworkEgressOutput {
  url: string
  headers?: Record<string, string>
  body?: unknown
}

/** Trusted host facts, supplied separately from plugin-facing network options. */
export interface PluginNetworkEgressContext {
  oauthTokenKeys?: ReadonlySet<string>
  isBuiltin?: boolean
}

const CREDENTIAL_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "access-token",
  "access_token",
])

export class PluginPiiError extends Error {
  public readonly pluginId: string
  public readonly site: string

  constructor(pluginId: string, site: string) {
    super(
      `[${site}] blocked for plugin "${pluginId}": content failed the PII redaction gate ` +
        `(hasNoLeakingPii). Redact emails/ids/keys before sending to a model.`
    )
    this.name = "PluginPiiError"
    this.pluginId = pluginId
    this.site = site
  }
}

/**
 * Throws `PluginPiiError` when any of `texts` trips the PII detector.
 * Non-string / empty entries are ignored.
 */
export function assertNoLeakingPii(
  pluginId: string,
  site: string,
  texts: ReadonlyArray<string | undefined | null>
): void {
  for (const text of texts) {
    if (typeof text === "string" && text.length > 0 && !hasNoLeakingPii(text)) {
      throw new PluginPiiError(pluginId, site)
    }
  }
}

/**
 * Deep variant for structured values (e.g. vector document metadata):
 * throws when any nested string trips the PII detector.
 */
export function assertNoLeakingPiiDeep(
  pluginId: string,
  site: string,
  values: ReadonlyArray<unknown>
): void {
  for (const value of values) {
    if (value !== undefined && value !== null && !hasNoLeakingPiiDeep(value)) {
      throw new PluginPiiError(pluginId, site)
    }
  }
}

function sanitizeString(
  pluginId: string,
  site: string,
  value: string,
  policy: PluginEgressPiiPolicy
): string {
  if (policy === "block") {
    assertNoLeakingPii(pluginId, site, [value])
    return value
  }
  return redactText(value).redacted
}

function sanitizeValue(
  pluginId: string,
  site: string,
  value: unknown,
  policy: PluginEgressPiiPolicy,
  key?: string
): unknown {
  if (key && CREDENTIAL_KEYS.has(key.toLowerCase())) return value
  if (typeof value === "string") return sanitizeString(pluginId, site, value, policy)
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(pluginId, site, entry, policy))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(pluginId, site, entryValue, policy, entryKey),
      ])
    )
  }
  return value
}

function sanitizeNetworkBody(
  pluginId: string,
  url: string,
  body: unknown,
  policy: PluginEgressPiiPolicy,
  host: PluginNetworkEgressContext
): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const fields = body as Record<string, unknown>
    // Interim compatibility boundary until ADR-0246's host-coordinated refresh
    // lands: only the bundled Feishu provider's exact JSON refresh request.
    // Permissions, allowlist and audit remain enforced by the caller.
    const exemptKeys =
      host.oauthTokenKeys ??
      (host.isBuiltin &&
      pluginId === "feishu-auth" &&
      url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token" &&
      fields.grant_type === "refresh_token"
        ? new Set(["client_secret", "refresh_token"])
        : undefined)
    if (exemptKeys) {
      return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          exemptKeys.has(key) && typeof value === "string"
            ? value
            : sanitizeValue(pluginId, "ctx.network.body", value, policy, key),
        ])
      )
    }
  }
  return sanitizeValue(pluginId, "ctx.network.body", body, policy)
}

function sanitizeUrl(pluginId: string, url: string, policy: PluginEgressPiiPolicy): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PluginPiiError(pluginId, "ctx.network.url")
  }

  if (parsed.username) {
    parsed.username = sanitizeString(pluginId, "ctx.network.url.username", parsed.username, policy)
  }
  if (parsed.password) {
    parsed.password = sanitizeString(pluginId, "ctx.network.url.password", parsed.password, policy)
  }
  parsed.pathname = parsed.pathname
    .split("/")
    .map((segment) => {
      const decoded = decodeURIComponent(segment)
      return encodeURIComponent(sanitizeString(pluginId, "ctx.network.url.path", decoded, policy))
    })
    .join("/")
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    parsed.searchParams.set(
      key,
      CREDENTIAL_KEYS.has(key.toLowerCase())
        ? value
        : sanitizeString(pluginId, "ctx.network.url.query", value, policy)
    )
  }
  return parsed.toString()
}

/**
 * Apply the host-owned PII/secret gate to one plugin network request. The gate
 * defaults to redaction; callers may opt into the stricter blocking policy but
 * cannot bypass inspection. Recognized credential fields are preserved so
 * allowlisted provider authentication continues to work.
 */
export function sanitizePluginNetworkEgress(
  pluginId: string,
  input: PluginNetworkEgressInput,
  host: PluginNetworkEgressContext = {}
): PluginNetworkEgressOutput {
  const policy = input.piiPolicy ?? "redact"
  const headers = input.headers
    ? (sanitizeValue(pluginId, "ctx.network.headers", input.headers, policy) as Record<
        string,
        string
      >)
    : undefined

  let body = input.body
  const oauthTokenKeys = host.oauthTokenKeys
  const contentType = oauthTokenKeys
    ? Object.entries(input.headers ?? {})
        .find(([key]) => key.toLowerCase() === "content-type")?.[1]
        .split(";")[0]
        .trim()
        .toLowerCase()
    : undefined
  if (
    oauthTokenKeys &&
    typeof body === "string" &&
    contentType === "application/x-www-form-urlencoded"
  ) {
    // Only host-built PKCE forms use decoded, per-key inspection. Unmarked
    // forms retain the existing whole-string behavior (ES-05 is deferred).
    const fields = new URLSearchParams(body)
    body = new URLSearchParams(
      [...fields].map(([key, value]) => [
        key,
        oauthTokenKeys.has(key)
          ? value
          : (sanitizeValue(pluginId, "ctx.network.body", value, policy, key) as string),
      ])
    ).toString()
  } else if (typeof body === "string") {
    const rawBody = body
    try {
      const parsed = JSON.parse(rawBody) as unknown
      body = JSON.stringify(sanitizeNetworkBody(pluginId, input.url, parsed, policy, host))
    } catch {
      body = sanitizeString(pluginId, "ctx.network.body", rawBody, policy)
    }
  } else if (body !== undefined) {
    body = sanitizeNetworkBody(pluginId, input.url, body, policy, host)
  }

  return {
    url: sanitizeUrl(pluginId, input.url, policy),
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}
