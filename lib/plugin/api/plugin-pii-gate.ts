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
import type { PluginCredentialRef } from "@cognia/plugin-contract/types/plugin/plugin"

export type PluginEgressPiiPolicy = "redact" | "block"
export type LiteralCredentialPolicy = "observe" | "inspect"
export type CredentialPosition = "header" | "query" | "body"

/** Flips to inspect in the release after this ships; tracked by the ES-05 ledger row. */
export const DEFAULT_LITERAL_CREDENTIAL_POLICY: LiteralCredentialPolicy = "observe"

export interface PluginNetworkEgressInput {
  url: string
  headers?: Record<string, string | PluginCredentialRef>
  query?: Record<string, string | PluginCredentialRef>
  body?: unknown
  piiPolicy?: PluginEgressPiiPolicy
}

export interface PluginNetworkEgressOutput {
  url: string
  headers?: Record<string, string | PluginCredentialRef>
  query?: Record<string, string | PluginCredentialRef>
  body?: unknown
}

/** Trusted host facts, supplied separately from plugin-facing network options. */
export interface PluginNetworkEgressContext {
  oauthTokenKeys?: ReadonlySet<string>
  isBuiltin?: boolean
  literalCredentials?: LiteralCredentialPolicy
  onLiteralCredential?: (position: CredentialPosition, name: string) => void
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

export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase())
}

const SECRET_REF_BRAND = Symbol.for("cognia.plugin.secretRef")
const credentialSnapshots = new WeakSet<object>()

/** Only gate-created, immutable references may reach the resolver. */
export function isHostCredentialSnapshot(value: object): boolean {
  return credentialSnapshots.has(value)
}

/** JSON data cannot opt into credential resolution. Validate branded values only. */
export function isPluginCredentialRef(value: unknown): value is PluginCredentialRef {
  if (!value || typeof value !== "object") return false
  const brand = Object.getOwnPropertyDescriptor(value, SECRET_REF_BRAND)
  if (brand?.value !== true) return false
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    !Object.hasOwn(value, "$secretRef") ||
    brand.enumerable ||
    keys.some((key) => key !== "$secretRef" && key !== "prefix" && key !== SECRET_REF_BRAND) ||
    Object.values(descriptors).some((entry) => !("value" in entry) || !entry.enumerable) ||
    typeof descriptors.$secretRef?.value !== "string" ||
    !descriptors.$secretRef.value.trim() ||
    (Object.hasOwn(value, "prefix") && typeof descriptors.prefix?.value !== "string")
  ) {
    throw new Error("Malformed network credential reference: expected { $secretRef, prefix? }")
  }
  return true
}

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
  host: PluginNetworkEgressContext,
  key?: string,
  position: CredentialPosition = "body"
): unknown {
  if (isPluginCredentialRef(value)) {
    if (!key || !isCredentialKey(key)) {
      throw new Error("Network credential reference is only valid in a credential field")
    }
    const snapshot: PluginCredentialRef = {
      $secretRef: value.$secretRef,
      ...(value.prefix !== undefined
        ? {
            prefix: sanitizeValue(
              pluginId,
              site,
              value.prefix,
              policy,
              host,
              key,
              position
            ) as string,
          }
        : {}),
    }
    Object.defineProperty(snapshot, SECRET_REF_BRAND, { value: true })
    Object.freeze(snapshot)
    credentialSnapshots.add(snapshot)
    return snapshot
  }
  if (
    typeof value === "string" &&
    key &&
    isCredentialKey(key) &&
    (host.literalCredentials ?? DEFAULT_LITERAL_CREDENTIAL_POLICY) === "observe"
  ) {
    host.onLiteralCredential?.(position, key)
    return value
  }
  if (typeof value === "string") return sanitizeString(pluginId, site, value, policy)
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(pluginId, site, entry, policy, host))
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(pluginId, site, entryValue, policy, host, entryKey),
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
            : sanitizeValue(pluginId, "ctx.network.body", value, policy, host, key),
        ])
      )
    }
  }
  return sanitizeValue(pluginId, "ctx.network.body", body, policy, host)
}

function sanitizeUrl(
  pluginId: string,
  url: string,
  policy: PluginEgressPiiPolicy,
  host: PluginNetworkEgressContext
): string {
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
  const query = [...parsed.searchParams].map(([key, value]) => [
    key,
    sanitizeValue(pluginId, "ctx.network.url.query", value, policy, host, key, "query") as string,
  ])
  parsed.search = new URLSearchParams(query).toString()
  return parsed.toString()
}

/**
 * Apply the host-owned PII/secret gate to one plugin network request. The gate
 * defaults to redaction; callers may opt into the stricter blocking policy but
 * cannot bypass inspection. The transitional observe policy preserves literal
 * credentials and reports field names; only valid references remain opaque in inspect mode.
 */
export function sanitizePluginNetworkEgress(
  pluginId: string,
  input: PluginNetworkEgressInput,
  host: PluginNetworkEgressContext = {}
): PluginNetworkEgressOutput {
  const policy = input.piiPolicy ?? "redact"
  const sanitizeFields = (
    fields: PluginNetworkEgressInput["headers"],
    position: "header" | "query"
  ) => {
    if (isPluginCredentialRef(fields)) {
      throw new Error("Network credential reference must be a credential field value")
    }
    return fields
      ? (Object.fromEntries(
          Object.entries(fields).map(([key, value]) => {
            // Non-string primitives (numbers, booleans) pass through as before;
            // only an object that is not a valid reference is refused.
            if (value !== null && typeof value === "object" && !isPluginCredentialRef(value)) {
              throw new Error(
                "Malformed network credential reference: expected a string or reference"
              )
            }
            return [
              key,
              sanitizeValue(
                pluginId,
                `ctx.network.${position}`,
                value,
                policy,
                host,
                key,
                position
              ),
            ]
          })
        ) as Record<string, string | PluginCredentialRef>)
      : undefined
  }
  const headers = sanitizeFields(input.headers, "header")
  const query = sanitizeFields(input.query, "query")

  let body = input.body
  const oauthTokenKeys = host.oauthTokenKeys
  const contentTypeHeader = Object.entries(input.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "content-type"
  )?.[1]
  const contentType =
    oauthTokenKeys && typeof contentTypeHeader === "string"
      ? contentTypeHeader.split(";")[0].trim().toLowerCase()
      : undefined
  if (
    oauthTokenKeys &&
    typeof body === "string" &&
    contentType === "application/x-www-form-urlencoded"
  ) {
    // Only host-built PKCE forms use decoded, per-key inspection. Unmarked
    // forms retain the existing whole-string behavior.
    const fields = new URLSearchParams(body)
    body = new URLSearchParams(
      [...fields].map(([key, value]) => [
        key,
        oauthTokenKeys.has(key)
          ? value
          : (sanitizeValue(pluginId, "ctx.network.body", value, policy, host, key) as string),
      ])
    ).toString()
  } else if (typeof body === "string") {
    const rawBody = body
    let parsed: unknown
    let isJson = true
    try {
      parsed = JSON.parse(rawBody) as unknown
    } catch {
      isJson = false
    }
    body = isJson
      ? JSON.stringify(sanitizeNetworkBody(pluginId, input.url, parsed, policy, host))
      : sanitizeString(pluginId, "ctx.network.body", rawBody, policy)
  } else if (body !== undefined) {
    body = sanitizeNetworkBody(pluginId, input.url, body, policy, host)
  }

  return {
    url: sanitizeUrl(pluginId, input.url, policy, host),
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}
