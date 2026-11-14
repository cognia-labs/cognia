// Settings → Provider Profile Store dual-write (ADR-0090 Phase 1).
//
// After every settings save that touches provider configuration, re-derive
// the profile documents and write them ONLY when the derivation changed
// (hash compare), so repeated saves don't spin the CAS profileVersion and a
// derive→write→derive loop is structurally impossible (the sync never writes
// back to `settings`).

import type { AppSettings } from "@cognia/agent-config-types"
import {
  deriveProfiles,
  type DerivedProfiles,
  type LegacyCustomProviderRow,
  type LegacyProviderSettingsRow,
} from "@cognia/provider-types/profile-migration"
import { getBuiltInProviderCatalog } from "@cognia/provider-types/built-in-provider-catalog"

import { putDerivedProfiles } from "@/lib/db/provider-profiles"
import { getDb } from "@/lib/db/schema"

/** The settings keys whose change makes a re-derivation necessary. */
export function touchesProviderConfiguration(
  patch: Partial<Record<keyof AppSettings, unknown>>
): boolean {
  return "providerSettings" in patch || "customProviders" in patch
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, function replacerSortKeys(this: unknown, _key, val) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    return val
  })
}

/**
 * Last written derivation, per database. The active account/runtime target
 * selects a different database (`activateAccountDatabase`), and each one holds
 * its own profile store: a memo shared across them would skip populating an
 * empty database whose settings derive to the same content as the previous
 * one's.
 */
const lastDerivationHashByDb = new Map<string, string>()

/** Test hook — the memo is module-global. */
export function __resetProviderProfileSync(): void {
  lastDerivationHashByDb.clear()
}

type ProfileDb = ReturnType<typeof getDb>

async function currentStoreHash(db: ProfileDb): Promise<string> {
  const [providers, deployments, transports] = await Promise.all([
    db.providerProfiles.toArray(),
    db.deploymentProfiles.toArray(),
    db.transportProfiles.toArray(),
  ])
  const legacyAliases: Record<string, string> = {}
  for (const deployment of deployments) {
    if (deployment.legacyProviderId) legacyAliases[deployment.legacyProviderId] = deployment.id
  }
  // Sort with the same comparator deriveProfiles uses so identical content
  // hashes identically regardless of IndexedDB's key ordering.
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id))
  const derived: DerivedProfiles = {
    providerProfiles: byId(providers),
    deploymentProfiles: byId(deployments),
    transportProfiles: byId(transports),
    legacyAliases,
  }
  return stableStringify(derived)
}

/**
 * Re-derive profiles from the post-save settings and persist when changed.
 * Returns the new profileVersion, or null when nothing changed. Errors are
 * the caller's to handle (the settings save path wraps this fire-and-forget).
 */
export async function syncProviderProfilesFromSettings(
  settings: Pick<AppSettings, "providerSettings" | "customProviders">
): Promise<number | null> {
  const derived = deriveProfiles({
    catalog: getBuiltInProviderCatalog(),
    providerSettings: settings.providerSettings as
      Record<string, LegacyProviderSettingsRow> | undefined,
    customProviders: settings.customProviders as LegacyCustomProviderRow[] | undefined,
  })
  const nextHash = stableStringify(derived)

  const db = getDb()
  const dbKey = db.name
  let lastHash = lastDerivationHashByDb.get(dbKey)
  if (lastHash === undefined) {
    // First sync against this database: compare with what its store already
    // holds so a reload doesn't burn a version on identical content.
    lastHash = await currentStoreHash(db)
    lastDerivationHashByDb.set(dbKey, lastHash)
  }
  if (nextHash === lastHash) return null

  const version = await putDerivedProfiles(derived)
  // Record against the database the profiles were derived for; if the active
  // database changed during the write, the next sync re-reads its own store.
  if (getDb().name === dbKey) lastDerivationHashByDb.set(dbKey, nextHash)
  else lastDerivationHashByDb.delete(dbKey)
  return version
}
