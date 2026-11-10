import { liveQuery } from "dexie"
import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import { getDb, LEGACY_COGNIA_DB_NAME } from "@/lib/db/schema"
import { getNotificationIdentity } from "@/lib/notifications/identity-cache"
import { isCapacitor, isHeadlessHost, isTauri } from "@/lib/platform/detect"
import {
  getActiveRuntimeTargetContext,
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import {
  encryptedRuntimeTargetDatabaseName,
  RuntimeTargetRegistry,
} from "@/lib/runtime/target-registry"

export interface CleanupOwnership {
  kind: "local" | "session-rows" | "host-managed" | "unknown"
  revision: string
}

const UNKNOWN: CleanupOwnership = { kind: "unknown", revision: "" }
let cached: { binding: string; ownership: CleanupOwnership } | undefined

export function cleanupDatabaseName(): string {
  // schema.ts primes this synchronously on every DB activation. Reading it
  // never opens Dexie, including during a React render or static prerender.
  return getNotificationIdentity()?.namespaceId ?? LEGACY_COGNIA_DB_NAME
}

function bindingKey(): string {
  return JSON.stringify([getRuntimeTargetScopeKey(), cleanupDatabaseName()])
}

function nativeOwnership(): CleanupOwnership | undefined {
  const identity = getNotificationIdentity()
  // Desktop base DBs also contain persisted HostState mirrors. Only rows with
  // established local session ownership may be cleaned, even after disconnect.
  if (
    (isTauri() || isHeadlessHost()) &&
    identity &&
    identity.namespaceId === encryptedAccountDatabaseName(identity.accountId)
  )
    return isHeadlessHost()
      ? { kind: "local", revision: "native-account" }
      : { kind: "session-rows", revision: "native-session-rows" }
}

/** Read persisted data ownership; execution snapshots and credentials are not owners. */
export async function readCleanupOwnership(databaseName: string): Promise<CleanupOwnership> {
  const binding = bindingKey()
  const scope = getActiveRuntimeTargetContext()
  if (databaseName !== cleanupDatabaseName()) return UNKNOWN
  const native = nativeOwnership()
  if (native) return native
  const identity = getNotificationIdentity()
  if (
    isCapacitor() &&
    identity &&
    scope?.accountId === identity.accountId &&
    databaseName === encryptedAccountDatabaseName(identity.accountId)
  ) {
    try {
      // setMobileRuntimeMode persists this choice through saveSettings in this
      // account's active DB. Never use the hydrated store or default the mode.
      const db = getDb()
      if (db.name !== databaseName) return UNKNOWN
      const settings = await db.settings.get("singleton")
      if (bindingKey() !== binding || getDb() !== db) return UNKNOWN
      return settings?.mobileRuntimeMode === "standalone"
        ? { kind: "local", revision: "mobile-standalone" }
        : UNKNOWN
    } catch {
      return UNKNOWN
    }
  }
  if (
    !scope ||
    databaseName !== encryptedRuntimeTargetDatabaseName(scope.accountId, scope.targetId)
  )
    return UNKNOWN
  let registry: RuntimeTargetRegistry | undefined
  try {
    registry = new RuntimeTargetRegistry()
    const target = await registry.getActiveTarget(scope.accountId)
    if (bindingKey() !== binding || target?.id !== scope.targetId) return UNKNOWN
    return {
      kind: target.kind === "standalone" ? "local" : "host-managed",
      revision: JSON.stringify([target.kind, target.updatedAt, target.lastUsedAt]),
    }
  } catch {
    // A missing/unreadable registry must never unlock mirrored source tables.
    return UNKNOWN
  } finally {
    registry?.close()
  }
}

export function getCleanupOwnership(): CleanupOwnership {
  return nativeOwnership() ?? (cached?.binding === bindingKey() ? cached.ownership : UNKNOWN)
}

export function canCleanHostSourceTables(): boolean {
  return getCleanupOwnership().kind === "local"
}

/** Render-safe: reads only activation identity and already hydrated ownership. */
export function getCleanupTargetKey(ownership?: CleanupOwnership): string {
  try {
    const owner = ownership ?? getCleanupOwnership()
    return JSON.stringify([bindingKey(), owner.kind, owner.revision])
  } catch {
    return ""
  }
}

/** Hydrate outside render and invalidate confirmations on persisted owner changes. */
export function subscribeCleanupTarget(listener: () => void): () => void {
  let subscription: { unsubscribe(): void } | undefined
  const observe = () => {
    subscription?.unsubscribe()
    const binding = bindingKey()
    listener()
    subscription = liveQuery(() => readCleanupOwnership(cleanupDatabaseName())).subscribe(
      (ownership) => {
        if (bindingKey() !== binding) return
        cached = { binding, ownership }
        listener()
      }
    )
  }
  const unsubscribeContext = subscribeRuntimeTargetContext(observe)
  observe()
  return () => {
    subscription?.unsubscribe()
    unsubscribeContext()
  }
}
