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

/** Top-level row fields that are credentials or derive from one. */
const TOP_LEVEL_SECRET_FIELDS = [
  "apiKey",
  "apiKeys",
  "apiKeyUsageStats",
  "currentKeyIndex",
  "oauthRefreshToken",
  "verificationFingerprint",
] as const

/**
 * Verification is a statement about the credentials this machine tested. Once
 * those credentials are removed the claim no longer describes the row.
 */
const VERIFICATION_FIELDS = ["verificationStatus", "lastVerifiedAt", "verificationMessage"] as const

const BEDROCK_SECRET_FIELDS = ["apiKey", "accessKeyId", "secretAccessKey", "sessionToken"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True when a static header name carries authentication material. */
export function isCredentialHeaderName(name: string): boolean {
  return CREDENTIAL_HEADER_RE.test(name)
}

function stripCredentialHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isRecord(headers)) return undefined
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (isCredentialHeaderName(name)) continue
    if (typeof value === "string") kept[name] = value
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function stripCredentialParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCredentialParams)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_PARAM_RE.test(key) && typeof entry !== "boolean") continue
    out[key] = stripCredentialParams(entry)
  }
  return out
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/**
 * Return a copy of a provider row with every credential removed. The input is
 * never mutated. Non-credential connection metadata (endpoint, protocol,
 * flavor, models, non-auth headers, inference defaults) is preserved so the row
 * can be re-keyed on the destination.
 */
export function stripProviderSecrets<T>(row: T): T {
  if (!isRecord(row)) return row
  const out: Record<string, unknown> = { ...row }

  for (const field of TOP_LEVEL_SECRET_FIELDS) delete out[field]
  for (const field of VERIFICATION_FIELDS) delete out[field]

  if ("customHeaders" in out)
    setOrDelete(out, "customHeaders", stripCredentialHeaders(out.customHeaders))

  if (isRecord(out.bedrock)) {
    const bedrock: Record<string, unknown> = { ...out.bedrock }
    for (const field of BEDROCK_SECRET_FIELDS) delete bedrock[field]
    out.bedrock = bedrock
  }

  if (isRecord(out.openRouterSettings)) {
    const openRouter: Record<string, unknown> = { ...out.openRouterSettings }
    delete openRouter.provisioningApiKey
    // Every BYOK entry IS a credential (its `config` holds the upstream key).
    delete openRouter.byokKeys
    out.openRouterSettings = openRouter
  }

  if (isRecord(out.cliProxyAPISettings)) {
    const cliProxy: Record<string, unknown> = { ...out.cliProxyAPISettings }
    delete cliProxy.managementKey
    out.cliProxyAPISettings = cliProxy
  }

  for (const field of ["providerSpecificParams", "advancedParams"] as const) {
    if (field in out) out[field] = stripCredentialParams(out[field])
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
