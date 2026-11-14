/**
 * Schema-aware credential projection for persisted provider rows.
 *
 * A provider row (`UserProviderSettings` / `CustomProviderSettings`) carries
 * credentials in more places than its top-level `apiKey`: the key pool, the
 * per-key usage stats (keyed BY the raw key), OAuth refresh tokens, Bedrock
 * IAM secrets, OpenRouter provisioning and BYOK keys, the CLIProxyAPI
 * management key, credential-bearing static headers, and a verification
 * fingerprint written by older builds that embedded the raw key. Every export
 * that promises "API keys excluded" must go through {@link stripProviderSecrets}
 * instead of a hand-written denylist, so a new credential field is added in
 * exactly one place.
 */

/** Header names whose value authenticates the request. */
const CREDENTIAL_HEADER_RE =
  /(authorization|api[-_]?key|token|secret|cookie|password|passphrase|signature|session|credential)/i

/** Free-form parameter keys that look like a credential. */
const CREDENTIAL_PARAM_RE =
  /(token|api[-_]?key|secret|password|passphrase|private[-_]?key|credential|authorization|cookie)/i

/**
 * Top-level row fields that hold a credential. These leave the persisted
 * settings row (ADR-0256) and every export that excludes API keys.
 * `apiKeyUsageStats` is keyed BY the raw key, so it is credential material.
 */
const TOP_LEVEL_SECRET_FIELDS = [
  "apiKey",
  "apiKeys",
  "apiKeyUsageStats",
  "oauthRefreshToken",
] as const

/**
 * Top-level fields that are not credentials but only describe the credentials
 * this machine holds: an export without keys drops them, persistence keeps
 * them. The fingerprint is a digest since contract v3; older rows embedded the
 * raw key and are upgraded before they are persisted.
 */
const EXPORT_ONLY_DROPPED_FIELDS = ["currentKeyIndex", "verificationFingerprint"] as const

/**
 * Verification is a statement about the credentials this machine tested. Once
 * those credentials are removed the claim no longer describes the row.
 */
const VERIFICATION_FIELDS = ["verificationStatus", "lastVerifiedAt", "verificationMessage"] as const

const BEDROCK_SECRET_FIELDS = ["apiKey", "accessKeyId", "secretAccessKey", "sessionToken"] as const

/** Nested objects whose listed fields are credentials. */
const NESTED_SECRET_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["bedrock", BEDROCK_SECRET_FIELDS],
  // Every BYOK entry IS a credential (its `config` holds the upstream key).
  ["openRouterSettings", ["provisioningApiKey", "byokKeys"]],
  ["cliProxyAPISettings", ["managementKey"]],
]

/** Free-form parameter maps scanned for credential-looking keys. */
const PARAM_FIELDS = ["providerSpecificParams", "advancedParams"] as const

/** One path into a provider row; numbers index arrays. */
export type ProviderSecretPath = ReadonlyArray<string | number>

/** One credential leaf removed from a provider row. */
export interface ProviderSecretEntry {
  path: ProviderSecretPath
  value: unknown
}

/**
 * The credential half of one provider row: every credential leaf, by path.
 * Empty when the row carries no credential.
 */
export type ProviderRowSecrets = ProviderSecretEntry[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True when a static header name carries authentication material. */
export function isCredentialHeaderName(name: string): boolean {
  return CREDENTIAL_HEADER_RE.test(name)
}

function isCredentialParamEntry(key: string, value: unknown): boolean {
  return CREDENTIAL_PARAM_RE.test(key) && typeof value !== "boolean"
}

/** Split a free-form parameter tree, recording removed leaves under `prefix`. */
function splitCredentialParams(
  value: unknown,
  prefix: Array<string | number>,
  secrets: ProviderSecretEntry[]
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => splitCredentialParams(entry, [...prefix, index], secrets))
  }
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isCredentialParamEntry(key, entry)) {
      secrets.push({ path: [...prefix, key], value: entry })
      continue
    }
    out[key] = splitCredentialParams(entry, [...prefix, key], secrets)
  }
  return out
}

/**
 * Split a provider row into its public half and its credentials. The input is
 * never mutated, and `joinProviderSecrets(publicRow, secrets)` returns a row
 * equal to the input: nothing outside the credential leaves is dropped, so the
 * public half is what the settings row persists (ADR-0256).
 */
export function splitProviderSecrets<T>(row: T): { publicRow: T; secrets: ProviderRowSecrets } {
  if (!isRecord(row)) return { publicRow: row, secrets: [] }
  const secrets: ProviderSecretEntry[] = []
  const out: Record<string, unknown> = { ...row }

  for (const field of TOP_LEVEL_SECRET_FIELDS) {
    if (!(field in out)) continue
    if (out[field] !== undefined) secrets.push({ path: [field], value: out[field] })
    delete out[field]
  }

  if (isRecord(out.customHeaders)) {
    const kept: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(out.customHeaders)) {
      if (isCredentialHeaderName(name)) secrets.push({ path: ["customHeaders", name], value })
      else kept[name] = value
    }
    out.customHeaders = kept
  }

  for (const [field, secretFields] of NESTED_SECRET_FIELDS) {
    const nested = out[field]
    if (!isRecord(nested)) continue
    const copy: Record<string, unknown> = { ...nested }
    for (const secretField of secretFields) {
      if (!(secretField in copy)) continue
      if (copy[secretField] !== undefined) {
        secrets.push({ path: [field, secretField], value: copy[secretField] })
      }
      delete copy[secretField]
    }
    out[field] = copy
  }

  for (const field of PARAM_FIELDS) {
    if (field in out) out[field] = splitCredentialParams(out[field], [field], secrets)
  }

  return { publicRow: out as T, secrets }
}

function setAtPath(
  target: Record<string, unknown> | unknown[],
  path: ProviderSecretPath,
  value: unknown
): void {
  let cursor: Record<string, unknown> | unknown[] = target
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    const existing = (cursor as Record<string | number, unknown>)[key]
    const nextIsIndex = typeof path[i + 1] === "number"
    const copy = Array.isArray(existing)
      ? [...existing]
      : isRecord(existing)
        ? { ...existing }
        : nextIsIndex
          ? []
          : {}
    ;(cursor as Record<string | number, unknown>)[key] = copy
    cursor = copy
  }
  ;(cursor as Record<string | number, unknown>)[path[path.length - 1]!] = value
}

/**
 * Put credentials back into a public provider row. The input is never mutated;
 * containers along each path are copied. Returns the input unchanged (same
 * object) when there is nothing to join.
 */
export function joinProviderSecrets<T>(publicRow: T, secrets: ProviderRowSecrets | undefined): T {
  if (!secrets || secrets.length === 0 || !isRecord(publicRow)) return publicRow
  const out: Record<string, unknown> = { ...publicRow }
  for (const entry of secrets) {
    if (entry.path.length === 0) continue
    setAtPath(out, entry.path, entry.value)
  }
  return out as T
}

/**
 * Return a copy of a provider row with every credential removed. The input is
 * never mutated. Non-credential connection metadata (endpoint, protocol,
 * flavor, models, non-auth headers, inference defaults) is preserved so the row
 * can be re-keyed on the destination.
 */
export function stripProviderSecrets<T>(row: T): T {
  if (!isRecord(row)) return row
  const out = { ...(splitProviderSecrets(row).publicRow as Record<string, unknown>) }

  for (const field of EXPORT_ONLY_DROPPED_FIELDS) delete out[field]
  for (const field of VERIFICATION_FIELDS) delete out[field]

  if ("customHeaders" in out) {
    const headers = out.customHeaders
    const kept: Record<string, string> = {}
    if (isRecord(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value === "string") kept[name] = value
      }
    }
    if (Object.keys(kept).length > 0) out.customHeaders = kept
    else delete out.customHeaders
  }

  return out as T
}

/** Strip every row of a provider map or list. */
export function stripProviderCollectionSecrets<T>(collection: T): T {
  if (Array.isArray(collection)) return collection.map((row) => stripProviderSecrets(row)) as T
  if (!isRecord(collection)) return collection
  return Object.fromEntries(
    Object.entries(collection).map(([id, row]) => [id, stripProviderSecrets(row)])
  ) as T
}
