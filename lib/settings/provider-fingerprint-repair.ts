/**
 * Boot repair for provider verification fingerprints written by builds whose
 * fingerprint (contract v2) embedded raw API keys in the settings row. The
 * repair rewrites them into the credential-free v3 form so no second
 * plaintext copy of a key stays persisted beside the row.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { upgradeLegacyVerificationFingerprint } from "@cognia/provider-core/providers/completeness"

type ProviderRepairPatch = Partial<Pick<AppSettings, "providerSettings" | "customProviders">>

/**
 * Return the patch that rewrites every legacy fingerprint, or `null` when the
 * row carries none. Rows are copied, never mutated.
 */
export function repairLegacyProviderFingerprints(
  settings: AppSettings
): ProviderRepairPatch | null {
  const patch: ProviderRepairPatch = {}

  const providerSettings = settings.providerSettings
  if (providerSettings) {
    let changed = false
    const next: NonNullable<AppSettings["providerSettings"]> = {}
    for (const [id, row] of Object.entries(providerSettings)) {
      const upgraded = upgradeLegacyVerificationFingerprint(row)
      if (upgraded === undefined) {
        next[id] = row
      } else {
        next[id] = { ...row, verificationFingerprint: upgraded }
        changed = true
      }
    }
    if (changed) patch.providerSettings = next
  }

  const customProviders = settings.customProviders
  if (customProviders) {
    let changed = false
    const next = customProviders.map((row) => {
      const upgraded = upgradeLegacyVerificationFingerprint(row)
      if (upgraded === undefined) return row
      changed = true
      return { ...row, verificationFingerprint: upgraded }
    })
    if (changed) patch.customProviders = next
  }

  return Object.keys(patch).length > 0 ? patch : null
}
