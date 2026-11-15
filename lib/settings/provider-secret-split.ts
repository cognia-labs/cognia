/**
 * Settings-row half of provider secret externalization (ADR-0256).
 *
 * Applies the provider-row split of `@cognia/provider-types/provider-secrets`
 * to the settings singleton: the built-in provider map, the custom provider
 * list and the legacy top-level `apiKey`. Pure: no storage, no platform.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  joinProviderSecrets,
  splitProviderSecrets,
  type ProviderRowSecrets,
  type ProviderSecretEntry,
} from "@cognia/provider-types/provider-secrets"

/** Every credential of one settings row, keyed by provider. */
export interface SettingsSecretSet {
  /** The legacy top-level `AppSettings.apiKey`. */
  apiKey?: string
  /** Built-in providers, keyed like `AppSettings.providerSettings`. */
  providerSettings: Record<string, ProviderRowSecrets>
  /** Custom providers, keyed by their `id` (`#<index>` for a row without one). */
  customProviders: Record<string, ProviderRowSecrets>
}

type ProviderFields = Pick<AppSettings, "apiKey" | "providerSettings" | "customProviders">

export function emptySecretSet(): SettingsSecretSet {
  return { providerSettings: {}, customProviders: {} }
}

export function isEmptySecretSet(set: SettingsSecretSet | null | undefined): boolean {
  if (!set) return true
  return (
    set.apiKey === undefined &&
    Object.keys(set.providerSettings).length === 0 &&
    Object.keys(set.customProviders).length === 0
  )
}

function customProviderKey(row: unknown, index: number): string {
  const id = (row as { id?: unknown } | null)?.id
  return typeof id === "string" && id.length > 0 ? id : `#${index}`
}

/**
 * Split a settings row into the row that may be persisted and its credentials.
 * Never mutates the input.
 */
export function splitSettingsSecrets<T extends Partial<ProviderFields>>(
  row: T
): { publicRow: T; secrets: SettingsSecretSet } {
  const secrets = emptySecretSet()
  const out: Record<string, unknown> = { ...row }

  if ("apiKey" in out) {
    if (typeof out.apiKey === "string") secrets.apiKey = out.apiKey
    delete out.apiKey
  }

  const providerSettings = row.providerSettings
  if (providerSettings && typeof providerSettings === "object") {
    const next: Record<string, unknown> = {}
    for (const [id, providerRow] of Object.entries(providerSettings)) {
      const split = splitProviderSecrets(providerRow)
      next[id] = split.publicRow
      if (split.secrets.length > 0) secrets.providerSettings[id] = split.secrets
    }
    out.providerSettings = next
  }

  const customProviders = row.customProviders
  if (Array.isArray(customProviders)) {
    out.customProviders = customProviders.map((providerRow, index) => {
      const split = splitProviderSecrets(providerRow)
      if (split.secrets.length > 0) {
        secrets.customProviders[customProviderKey(providerRow, index)] = split.secrets
      }
      return split.publicRow
    })
  }

  return { publicRow: out as T, secrets }
}

/**
 * Put credentials back into a public settings row. Credentials are joined only
 * into providers the row lists; a record for a provider the row no longer has
 * is ignored (and dropped by the next persist). Never mutates the input.
 */
export function joinSettingsSecrets<T extends Partial<ProviderFields>>(
  row: T,
  secrets: SettingsSecretSet | null | undefined
): T {
  if (!secrets || isEmptySecretSet(secrets)) return row
  const out: Record<string, unknown> = { ...row }

  if (secrets.apiKey !== undefined) out.apiKey = secrets.apiKey

  const providerSettings = row.providerSettings
  if (providerSettings && typeof providerSettings === "object") {
    const next: Record<string, unknown> = {}
    for (const [id, providerRow] of Object.entries(providerSettings)) {
      next[id] = joinProviderSecrets(providerRow, secrets.providerSettings[id])
    }
    out.providerSettings = next
  }

  const customProviders = row.customProviders
  if (Array.isArray(customProviders)) {
    out.customProviders = customProviders.map((providerRow, index) =>
      joinProviderSecrets(
        providerRow,
        secrets.customProviders[customProviderKey(providerRow, index)]
      )
    )
  }

  return out as T
}

function pathKey(entry: ProviderSecretEntry): string {
  return JSON.stringify(entry.path)
}

function overlayEntries(
  base: ProviderRowSecrets | undefined,
  override: ProviderRowSecrets | undefined
): ProviderRowSecrets {
  if (!override || override.length === 0) return base ?? []
  if (!base || base.length === 0) return override
  const overridden = new Set(override.map(pathKey))
  return [...base.filter((entry) => !overridden.has(pathKey(entry))), ...override]
}

function overlayMap(
  base: Record<string, ProviderRowSecrets>,
  override: Record<string, ProviderRowSecrets>
): Record<string, ProviderRowSecrets> {
  const out: Record<string, ProviderRowSecrets> = { ...base }
  for (const [id, entries] of Object.entries(override)) out[id] = overlayEntries(base[id], entries)
  return out
}

/**
 * Overlay `override` on `base`, field by field: a credential `override` holds
 * replaces the same credential in `base`; the rest of `base` is kept.
 */
export function overlaySecretSets(
  base: SettingsSecretSet | null | undefined,
  override: SettingsSecretSet | null | undefined
): SettingsSecretSet {
  const b = base ?? emptySecretSet()
  if (!override) return b
  const out: SettingsSecretSet = {
    providerSettings: overlayMap(b.providerSettings, override.providerSettings),
    customProviders: overlayMap(b.customProviders, override.customProviders),
  }
  const apiKey = override.apiKey ?? b.apiKey
  if (apiKey !== undefined) out.apiKey = apiKey
  return out
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    return val
  })
}

/** Content equality, independent of key order. */
export function secretSetsEqual(
  a: SettingsSecretSet | null | undefined,
  b: SettingsSecretSet | null | undefined
): boolean {
  return stableStringify(a ?? emptySecretSet()) === stableStringify(b ?? emptySecretSet())
}
