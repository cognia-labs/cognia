/**
 * Settings profile transfer — portable export / import / reset of the app's
 * configuration, distinct from the full-database backup in `lib/data`.
 *
 * Export produces a small JSON document a user can carry to another machine.
 * Secrets are stripped two ways: an explicit top-level denylist plus a
 * recursive key-name scrub (anything that looks like a token / key / password).
 * Import validates the envelope and returns a `Partial<AppSettings>` patch with
 * identity / instance fields and secrets dropped — it can only ever loosen,
 * never exfiltrate, credentials.
 *
 * Import accepts every key the app can export (`SETTINGS_SYNC` classifies every
 * `AppSettings` key), so an optional override such as `colorTheme` survives the
 * round trip. Each value is checked: a closed-set key must hold one of its
 * values, any other key with a default must hold the same kind of value. A key
 * that fails is skipped and named in the result rather than saved.
 *
 * Reset reuses the canonical `DEFAULTS` so "restore defaults" never drifts from
 * the real shape. The caller names the keys (a section's, or every preference
 * key for a global reset, `globalResetKeys` in `section-keys.ts`). A global
 * reset deliberately KEEPS credentials (resetting preferences shouldn't sign
 * you out): search providers keep their keys and endpoints, and any other key
 * whose current value holds a credential is left as it is.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { SETTINGS_SYNC } from "@cognia/agent-config-types/settings-sync"
import { stripProviderCollectionSecrets } from "@cognia/provider-types/provider-secrets"
import { DEFAULTS } from "@/lib/db/settings"
import { locales } from "@/lib/i18n/config"

import { PERMISSION_MODES } from "./permission-mode-meta"

export const SETTINGS_PROFILE_SCHEMA = "cognia-settings" as const
export const SETTINGS_PROFILE_VERSION = 1 as const

/** Secret / account-bound top-level keys never written to an export. */
export const SECRET_KEYS = [
  "apiKey",
  "apiBaseUrl",
  "skillsShToken",
] as const satisfies readonly (keyof AppSettings)[]

/** Identity / instance keys that must never transfer between installs. */
export const NON_TRANSFERABLE_KEYS = [
  "id",
  "updatedAt",
  "installUuid",
] as const satisfies readonly (keyof AppSettings)[]

/**
 * Provider connections are carried by the dedicated Provider export
 * (`components/settings/provider/provider-import-export.tsx`), which has a
 * per-row schema, conflict resolution and keeps destination credentials. A
 * preferences profile neither writes nor accepts them: the importer has no
 * merge that would keep the destination's keys, so carrying them here only
 * produced a file whose provider section could never be restored.
 */
export const PROVIDER_CONNECTION_KEYS = [
  "providerSettings",
  "customProviders",
] as const satisfies readonly (keyof AppSettings)[]

/** Nested object keys whose name marks them as a secret — scrubbed recursively. */
const SECRET_KEY_RE =
  /(token|apikey|secret|password|passphrase|privatekey|credential|authorization|cookie|managementkey)/i
const SEARCH_LOCAL_FIELDS = new Set(["apiKey", "apiKeys", "cx", "baseUrl", "allowPrivateEndpoint"])

export interface SettingsProfile {
  schema: typeof SETTINGS_PROFILE_SCHEMA
  version: number
  exportedAt: string
  settings: Partial<AppSettings>
}

export type ImportResult =
  | {
      ok: true
      patch: Partial<AppSettings>
      /** Keys the file held that were not taken: unknown here, or a value they cannot hold. */
      skipped: string[]
    }
  | { ok: false; errorKey: string }

/**
 * Every value of each closed-set setting. An imported value outside its set is
 * skipped; `ClosedSetsCover` below fails the typecheck when a set misses a
 * value its type allows.
 */
const CLOSED_SETS = {
  theme: ["light", "dark", "system"],
  fontScale: ["xs", "sm", "md", "lg", "xl"],
  language: locales,
  languageMode: ["system", "manual"],
  colorTheme: ["default", "ocean", "forest", "sunset", "lavender", "rose", "slate", "amber"],
  permissionMode: PERMISSION_MODES,
} as const satisfies { [K in keyof AppSettings]?: readonly NonNullable<AppSettings[K]>[] }

type ClosedSetKey = keyof typeof CLOSED_SETS
type ClosedSetGaps = {
  [K in ClosedSetKey]: Exclude<NonNullable<AppSettings[K]>, (typeof CLOSED_SETS)[K][number]>
}[ClosedSetKey]
/** Compile-time: every closed set lists every value its key's type allows. */
const ClosedSetsCover: [ClosedSetGaps] extends [never] ? true : never = true
void ClosedSetsCover

type ValueKind = "string" | "number" | "boolean" | "array" | "object" | "null"

function kindOf(value: unknown): ValueKind | null {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return Number.isFinite(value) ? "number" : null
    case "boolean":
      return "boolean"
    case "object":
      return "object"
    default:
      return null
  }
}

/** Whether an imported value is one this key can hold. */
function acceptsValue(key: string, value: unknown): boolean {
  const kind = kindOf(value)
  if (kind === null) return false
  if (Object.hasOwn(CLOSED_SETS, key)) {
    return (CLOSED_SETS[key as ClosedSetKey] as readonly unknown[]).includes(value)
  }
  const fallback = (DEFAULTS as unknown as Record<string, unknown>)[key]
  // No default (an optional override) or a null one: nothing to compare against.
  if (fallback === undefined || fallback === null) return true
  return kindOf(fallback) === kind
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSecretValue(value: unknown): boolean {
  // Secrets are strings (a token) or string arrays (e.g. `apiKeys`). Boolean
  // preference flags like `revealSecrets` / `rememberPassphrase` share the
  // secret-y name but are NOT secrets — keep them.
  if (typeof value === "string") return true
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")
}

/**
 * Recursively drop any key whose normalized name matches the secret pattern AND
 * whose value actually looks like a secret (string / string[]).
 */
function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase()
}

function isSecretEntry(key: string, value: unknown): boolean {
  const normalized = normalizedKey(key)
  return (
    normalized !== "apikeyrotationstrategy" &&
    SECRET_KEY_RE.test(normalized) &&
    isSecretValue(value)
  )
}

export function deepStripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepStripSecrets)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const normalized = normalizedKey(k)
      if (isSecretEntry(k, v)) continue
      // Workflow HTTP nodes also accept headers/body as serialized JSON.
      if (normalized.endsWith("json") && typeof v === "string") {
        try {
          const parsed: unknown = JSON.parse(v)
          if (isPlainObject(parsed) || Array.isArray(parsed)) {
            out[k] = JSON.stringify(deepStripSecrets(parsed))
            continue
          }
        } catch {
          // Preserve ordinary non-JSON authored text.
        }
      }
      out[k] = deepStripSecrets(v)
    }
    return out
  }
  return value
}

/**
 * Whether a value holds a credential `deepStripSecrets` would remove: a
 * secret-named entry with a non-empty string, at any depth (serialized JSON
 * fields included). An empty placeholder (`apiKey: ""`) holds none.
 */
export function holdsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsSecret)
  if (!isPlainObject(value)) return false
  return Object.entries(value).some(([k, v]) => {
    if (isSecretEntry(k, v)) {
      return Array.isArray(v)
        ? v.some((item) => typeof item === "string" && item.trim() !== "")
        : typeof v === "string" && v.trim() !== ""
    }
    if (normalizedKey(k).endsWith("json") && typeof v === "string") {
      try {
        return holdsSecret(JSON.parse(v))
      } catch {
        return false
      }
    }
    return holdsSecret(v)
  })
}

/**
 * Strip every credential from a whole settings row (full backup without API
 * keys). Provider rows go through the schema-aware provider projection first —
 * their credentials (BYOK configs, key-indexed usage stats, auth headers) do
 * not all carry a secret-looking key name — then the generic recursive scrub.
 */
export function stripSettingsRowSecrets<T extends object>(row: T): T {
  const projected: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const key of PROVIDER_CONNECTION_KEYS) {
    if (key in projected) projected[key] = stripProviderCollectionSecrets(projected[key])
  }
  return deepStripSecrets(projected) as T
}

/** Search credentials and self-hosted endpoint authority cannot travel hosts. */
function portableSearchProviders(value: unknown): unknown {
  if (!isPlainObject(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, provider]) => {
      if (!isPlainObject(provider)) return []
      return [
        [
          id,
          deepStripSecrets(
            Object.fromEntries(
              Object.entries(provider).filter(([key]) => !SEARCH_LOCAL_FIELDS.has(key))
            )
          ),
        ],
      ]
    })
  )
}

/** Keys excluded from any export: explicit secrets + identity/instance fields. */
function excludedExportKeys(): Set<string> {
  return new Set<string>([...SECRET_KEYS, ...NON_TRANSFERABLE_KEYS, ...PROVIDER_CONNECTION_KEYS])
}

/**
 * Build the export document. `now` is injectable for deterministic tests; in
 * the browser the caller passes `new Date().toISOString()`.
 */
export function exportSettingsProfile(settings: AppSettings, now: string): SettingsProfile {
  const excluded = excludedExportKeys()
  const sanitized: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (excluded.has(k)) continue
    sanitized[k] = k === "searchProviders" ? portableSearchProviders(v) : deepStripSecrets(v)
  }
  return {
    schema: SETTINGS_PROFILE_SCHEMA,
    version: SETTINGS_PROFILE_VERSION,
    exportedAt: now,
    settings: sanitized as Partial<AppSettings>,
  }
}

/** Serialize a profile to a pretty JSON string for download. */
export function serializeSettingsProfile(profile: SettingsProfile): string {
  return JSON.stringify(profile, null, 2)
}

/**
 * Validate + sanitize an imported profile. Unknown top-level keys are dropped
 * (only keys present in DEFAULTS are accepted), and secrets / identity fields
 * are stripped even if a hand-edited file tries to smuggle them in.
 */
export function importSettingsProfile(raw: unknown): ImportResult {
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, errorKey: "invalidJson" }
    }
  }
  if (!isPlainObject(parsed)) return { ok: false, errorKey: "invalidPayload" }
  if (parsed.schema !== SETTINGS_PROFILE_SCHEMA) return { ok: false, errorKey: "wrongSchema" }
  if (typeof parsed.version !== "number" || !Number.isFinite(parsed.version)) {
    return { ok: false, errorKey: "missingVersion" }
  }
  if (parsed.version > SETTINGS_PROFILE_VERSION) {
    return { ok: false, errorKey: "versionTooNew" }
  }
  if (!isPlainObject(parsed.settings)) return { ok: false, errorKey: "missingSettings" }

  const excluded = excludedExportKeys()
  const patch: Record<string, unknown> = {}
  const skipped: string[] = []
  for (const [k, v] of Object.entries(parsed.settings)) {
    // Secrets, identity and provider connections never come in, by design.
    if (excluded.has(k)) continue
    if (!Object.hasOwn(SETTINGS_SYNC, k) || !acceptsValue(k, v)) {
      skipped.push(k)
      continue
    }
    patch[k] = k === "searchProviders" ? portableSearchProviders(v) : deepStripSecrets(v)
  }
  if (Object.keys(patch).length === 0) return { ok: false, errorKey: "emptyProfile" }
  return { ok: true, patch: patch as Partial<AppSettings>, skipped }
}

export interface ResetOptions {
  /**
   * The row being reset. With it, credentials stay: search providers keep
   * their keys and endpoints, and a key whose value holds a credential is left
   * out of the patch (a global reset promises to keep them).
   */
  keepCredentialsOf?: Partial<AppSettings> | null
}

/** Search providers at their defaults, each keeping this install's keys and endpoint. */
function resetSearchProviders(current: unknown): unknown {
  const defaults: Record<string, unknown> = isPlainObject(DEFAULTS.searchProviders)
    ? DEFAULTS.searchProviders
    : {}
  const mine = isPlainObject(current) ? current : {}
  const out: Record<string, unknown> = {}
  for (const [id, base] of Object.entries(defaults)) {
    const own = isPlainObject(mine[id]) ? mine[id] : {}
    const local = Object.fromEntries(
      Object.entries(own).filter(([field]) => SEARCH_LOCAL_FIELDS.has(field))
    )
    out[id] = { ...(isPlainObject(base) ? base : {}), ...local }
  }
  // A provider this build has no default for stays only while it holds a key.
  for (const [id, own] of Object.entries(mine)) {
    if (!(id in out) && holdsSecret(own)) out[id] = own
  }
  return out
}

/**
 * Build a reset patch: the given keys at their default value (`undefined`
 * clears an optional override). See {@link ResetOptions} for credentials.
 */
export function buildResetPatch(
  keys: readonly (keyof AppSettings)[],
  options: ResetOptions = {}
): Partial<AppSettings> {
  const current = options.keepCredentialsOf
  const patch: Record<string, unknown> = {}
  for (const key of keys) {
    if (current) {
      if (key === "searchProviders") {
        patch[key] = resetSearchProviders(current.searchProviders)
        continue
      }
      if (holdsSecret(current[key])) continue
    }
    patch[key] = DEFAULTS[key]
  }
  return patch as Partial<AppSettings>
}
