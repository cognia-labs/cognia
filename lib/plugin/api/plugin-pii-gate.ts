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

/** Feishu transport compatibility boundary: only the shared authentication
 * provider's exact token exchange may preserve protocol credential fields.
 * It remains subject to permission and network policy checks at the caller.
 * Ordinary plugins, other endpoints and unrelated fields retain the PII gate. */
function sanitizeNetworkBody(
  pluginId: string,
  url: string,
  body: unknown,
  policy: PluginEgressPiiPolicy
): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const fields = body as Record<string, unknown>
    if (
      pluginId === "feishu-auth" &&
      url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token" &&
      ["authorization_code", "refresh_token", "client_credentials"].includes(
        String(fields.grant_type)
      )
    ) {
      const credentials = new Set(["client_secret", "refresh_token", "code", "code_verifier"])
      return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          credentials.has(key) && typeof value === "string"
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
  input: PluginNetworkEgressInput
): PluginNetworkEgressOutput {
  const policy = input.piiPolicy ?? "redact"
  const headers = input.headers
    ? (sanitizeValue(pluginId, "ctx.network.headers", input.headers, policy) as Record<
        string,
        string
      >)
    : undefined

  let body = input.body
  if (typeof body === "string") {
    const rawBody = body
    try {
      const parsed = JSON.parse(rawBody) as unknown
      body = JSON.stringify(sanitizeNetworkBody(pluginId, input.url, parsed, policy))
    } catch {
      body = sanitizeString(pluginId, "ctx.network.body", rawBody, policy)
    }
  } else if (body !== undefined) {
    body = sanitizeNetworkBody(pluginId, input.url, body, policy)
  }

  return {
    url: sanitizeUrl(pluginId, input.url, policy),
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}
