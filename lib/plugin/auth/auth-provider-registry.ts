/**
 * Moved to `@cognia/plugin-contract`, which owns the plugin contract.
 * This re-export keeps host imports of `@/lib/plugin/auth/auth-provider-registry` working.
 */
export * from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"

import {
  getProvider,
  registerAuthenticationProvider as registerProvider,
  unregisterProvidersByPlugin,
  type AuthenticationProvider,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"

// Reuse the existing localStorage-backed plugin storage, in a host-reserved
// namespace. This non-secret index must be synchronous because registration
// returns a disposer synchronously. No Dexie schema change is needed. Read on
// every registration (no in-memory ownership cache); deactivation never deletes
// it. Storage errors fail closed rather than allowing an id to be reassigned.
// Browser/Tauri Storage persists across restarts. Headless installs the memory
// Storage shim in lib/headless/node-indexeddb.ts, so its bindings last only for
// the process lifetime. CLI-side durable ownership is a separate ES-09 job.
const OWNER_STORAGE_KEY = "cognia-plugin-storage:__host-auth-provider-owners__"

function readOwners(): Map<string, string> {
  if (typeof localStorage === "undefined") return new Map()
  const raw = localStorage.getItem(OWNER_STORAGE_KEY)
  if (raw === null) return new Map()
  const entries: unknown = JSON.parse(raw)
  if (!Array.isArray(entries)) throw new Error("Auth provider ownership storage is invalid")
  const owners = new Map<string, string>()
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error("Auth provider ownership storage is invalid")
    }
    if (owners.has(entry[0]) && owners.get(entry[0]) !== entry[1]) {
      throw new Error("Auth provider ownership storage has conflicting owners")
    }
    owners.set(entry[0], entry[1])
  }
  return owners
}

/** Host registrations bind an id in host Storage, including declarative contributions. */
export function registerAuthenticationProvider(provider: AuthenticationProvider): () => void {
  const existing = getProvider(provider.id)
  if (existing && existing.pluginId !== provider.pluginId) {
    throw new Error(`Auth provider "${provider.id}" is owned by another plugin.`)
  }
  claimAuthProviderOwnership(provider.id, provider.pluginId)
  return registerProvider(provider)
}

/** Declarative and imperative registration share the same persistent binding. */
export function claimAuthProviderOwnership(providerId: string, pluginId: string | null): void {
  const owners = readOwners()
  const owner = owners.get(providerId)
  if (owner !== undefined && owner !== pluginId) {
    throw new Error(`Auth provider "${providerId}" is owned by another plugin.`)
  }
  if (pluginId !== null && owner === undefined) {
    if (typeof localStorage === "undefined")
      throw new Error("Auth provider ownership storage is unavailable")
    owners.set(providerId, pluginId)
    localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify([...owners]))
  }
}

/** Terminal uninstall only, independent of whether plugin tables are kept. */
export function releaseAuthProviderOwnership(pluginId: string): void {
  const owners = readOwners()
  let changed = false
  for (const [providerId, owner] of owners) {
    if (owner === pluginId) {
      owners.delete(providerId)
      changed = true
    }
  }
  if (changed) localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify([...owners]))
  unregisterProvidersByPlugin(pluginId)
}
