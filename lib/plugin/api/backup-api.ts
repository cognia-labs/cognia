/**
 * Plugin Backup API (`ctx.backup`) — build / inspect / restore the app's
 * encrypted backup packages (ADR-0001) from a plugin (scheduled-backup,
 * migration, disaster-recovery plugins).
 *
 * Wraps `lib/data/{export,import}.ts` + the `lib/db/backup-history.ts`
 * ledger.
 *
 * SECURITY: a plugin must never be able to exfiltrate or overwrite the
 * user's raw API key, so `includeApiKey` is FORCED to `false` on both
 * `create` and `restore` regardless of what the plugin passes — the
 * plugin-facing option types don't even expose it.
 *
 * PERMISSIONS: `create`/`serialize`/`validate`/`listHistory` are read-shaped
 * → `backup:read`. `restore` overwrites the local database → `backup:write`
 * (a `DANGEROUS` permission requiring consent).
 */

import { buildExportEnvelope, serializePackage } from "@/lib/data/export"
import { validateEnvelope, importEnvelope } from "@/lib/data/import"
import { listBackupHistory, getLatestSuccessful } from "@/lib/db/backup-history"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PluginBackupAPI } from "@cognia/plugin-contract/lib/plugin/api/backup-api"
import type { PluginManifest } from "@cognia/plugin-contract/types/plugin/plugin"
import {
  validateBackupDestinationDeclaration,
  type BackupDestinationDeclaration,
} from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"
import { registerBackupDestination } from "@/lib/data/destinations/registry"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"

const declarations = new Map<string, readonly BackupDestinationDeclaration[]>()
const registrations = new Map<string, Set<() => void>>()
const activations = new Map<string, symbol>()

export function registerBackupDestinationDeclarationsForPlugin(manifest: PluginManifest): void {
  const defs = manifest.backupDestinations ?? []
  const ids = new Set<string>()
  for (const def of defs) {
    const errors = validateBackupDestinationDeclaration(def)
    if (errors.length) throw new Error(errors.join("; "))
    if (ids.has(def.id)) throw new Error("Duplicate backup destination descriptor")
    ids.add(def.id)
  }
  declarations.set(
    manifest.id,
    defs.map((def) => ({ ...def }))
  )
}

export function clearBackupDestinationsForPlugin(pluginId: string): void {
  activations.delete(pluginId)
  declarations.delete(pluginId)
  for (const dispose of [...(registrations.get(pluginId) ?? [])]) dispose()
  registrations.delete(pluginId)
}
export type {
  PluginBackupAPI,
  PluginBackupCreateOptions,
  PluginBackupRestoreOptions,
} from "@cognia/plugin-contract/lib/plugin/api/backup-api"

/**
 * Create the Backup API for a plugin. Reads need `backup:read`; `restore`
 * needs `backup:write`.
 */
export function createBackupAPI(pluginId: string, manifest?: PluginManifest): PluginBackupAPI {
  clearBackupDestinationsForPlugin(pluginId)
  if (manifest) registerBackupDestinationDeclarationsForPlugin(manifest)
  const activation = Symbol(pluginId)
  activations.set(pluginId, activation)
  const api: PluginBackupAPI = {
    registerDestination(contribution) {
      const guard = getPermissionGuard()
      if (!guard.check(pluginId, "backup:destination"))
        throw new Error("Permission denied: backup:destination is required")
      if (activations.get(pluginId) !== activation)
        throw new Error("Backup destination activation is no longer available")
      // Copy the public callbacks only; Host-only interval hooks cannot be supplied by a plugin.
      const { id, label, readiness, upload, list, download, delete: remove } = contribution
      const dispose = registerBackupDestination(
        { id, label, readiness, upload, list, download, delete: remove },
        { pluginId, declarations: declarations.get(pluginId) ?? [] }
      )
      const owned = registrations.get(pluginId) ?? new Set<() => void>()
      let active = true
      const unregister = () => {
        if (!active) return
        active = false
        dispose()
        stopPermissions()
        stopTiers()
        owned.delete(unregister)
      }
      const stopPermissions = guard.subscribePermissionChanges(() => {
        if (!guard.check(pluginId, "backup:destination")) unregister()
      })
      const stopTiers = guard.subscribeTierChanges((changedPluginId, permission, tier) => {
        if (
          changedPluginId === pluginId &&
          permission === "backup:destination" &&
          tier === "forbid"
        )
          unregister()
      })
      owned.add(unregister)
      registrations.set(pluginId, owned)
      return { destinationId: `plugin:${pluginId}/${contribution.id}`, unregister }
    },
    create: (opts) =>
      buildExportEnvelope({
        includeSessions: opts?.includeSessions ?? true,
        includeBuiltIns: opts?.includeBuiltIns,
        // backup:read is not memory:read. Plugins cannot exfiltrate learned memory.
        includeMemories: false,
        // Hard-forced: a plugin never gets the raw API key in a backup.
        includeApiKey: false,
      }),
    serialize: (pkg) => serializePackage(pkg),
    validate: (input) => validateEnvelope(input),
    restore: (envelope, opts) =>
      importEnvelope(envelope, {
        mergeStrategy: opts.mergeStrategy,
        includeSessions: opts.includeSessions ?? false,
        // Hard-forced: a plugin never overwrites the user's API key.
        includeApiKey: false,
      }),
    listHistory: (filter) => listBackupHistory(filter),
    getLatestSuccessful: async () => (await getLatestSuccessful()) ?? null,
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      registerDestination: "backup:destination",
      create: "backup:read",
      serialize: "backup:read",
      validate: "backup:read",
      listHistory: "backup:read",
      getLatestSuccessful: "backup:read",
      restore: "backup:write",
    },
    { consentExempt: ["registerDestination"] }
  )
}
