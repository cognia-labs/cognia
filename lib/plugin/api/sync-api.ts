/** Public sync ownership and authorization; cursor mechanics live in the sync core. */
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type {
  PluginSyncAPI,
  PluginSyncDriver,
  PluginSyncRegistrationOptions,
} from "@cognia/plugin-contract/types/plugin/plugin-sync"
import { getDb } from "@/lib/db/schema"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { connectionAccess } from "@/lib/plugin/auth/connection-access"
import {
  hasPendingConnectionCleanup,
  listConsumerGrants,
  listServiceConnections,
} from "@/lib/db/external-services"
import { getIntegrationAccount } from "@/lib/db/integrations"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { bridgeSyncDriver } from "@/lib/plugin/bridge/sync-bridge"
import {
  abortExternalSyncRuns,
  isExternalSyncRunning,
  runExternalSync,
} from "@/lib/external-services/sync/core"
import {
  hasExternalSyncRegistration,
  registerExternalSync,
  requestExternalSync,
} from "@/lib/external-services/sync/runtime"
import type { ExternalSyncDriver, ExternalSyncTarget } from "@/lib/external-services/sync/types"

const activations = new Map<string, { dispose(): void }>()
interface Registration {
  target: ExternalSyncTarget
  signal: AbortSignal
  driver: ExternalSyncDriver<unknown>
  ready: Promise<void>
  dispose(): void
}
export function clearSyncForPlugin(pluginId: string): void {
  activations.get(pluginId)?.dispose()
  activations.delete(pluginId)
}
export interface PluginSyncRuntime {
  hasPermission?: (permission: string) => boolean
  signal?: AbortSignal
  callbackTimeoutMs?: number
}

/** Match the connection API's visibility and the integrations API's consumer grant binding. */
export async function assertSyncConnection(
  pluginId: string,
  ref: AuthConnectionRef,
  check: () => void,
  options: { hostIntegration?: boolean } = {}
): Promise<void> {
  const { connected, checked } = connectionAccess(pluginId, check)
  let connection: Awaited<ReturnType<typeof connected>>
  try {
    // Host-owned built-ins use integration projections/grants, not the public
    // auth service visibility contract. Public ctx.sync always takes connected().
    connection = options.hostIntegration
      ? await checked(() => getAuthConnection(ref))
      : await connected(ref)
    check()
  } catch {
    check()
    throw new Error("Sync connection unavailable")
  }
  const pendingCleanup = await checked(() => hasPendingConnectionCleanup(ref, pluginId))
  check()
  if (!connection || connection.status !== "connected" || pendingCleanup)
    throw new Error("Sync connection unavailable")
  if (connection.ownerPluginId === pluginId) return
  const projections = await checked(() => listServiceConnections({ pluginId }))
  check()
  for (const projection of projections) {
    if (
      projection.status !== "connected" ||
      projection.providerRef.kind !== "integration" ||
      projection.providerRef.authConnectionRef !== ref
    )
      continue
    const account = await checked(() =>
      getIntegrationAccount(
        pluginId,
        projection.providerRef.kind === "integration" ? projection.providerRef.accountId : ""
      )
    )
    check()
    if (
      !account ||
      account.connectionId !== ref ||
      account.providerId !== connection.providerId ||
      (account.providerOwnerPluginId !== undefined &&
        account.providerOwnerPluginId !== connection.ownerPluginId)
    )
      continue
    const grants = await checked(() => listConsumerGrants(projection.id, pluginId))
    check()
    if (
      grants.some(
        (grant) =>
          grant.consumerPluginId === pluginId &&
          grant.connectionRevision === connection.revision &&
          grant.providerFingerprint === projection.providerFingerprint &&
          (!grant.accountId || grant.accountId === account.id) &&
          !grant.workflowId &&
          !grant.sessionId &&
          grant.operationPatterns.length > 0
      )
    )
      return
  }
  throw new Error("Sync consumer grant required")
}

export function createSyncAPI(pluginId: string, runtime: PluginSyncRuntime = {}): PluginSyncAPI {
  clearSyncForPlugin(pluginId)
  const hasPermission =
    runtime.hasPermission ??
    ((permission) => getPermissionGuard().check(pluginId, permission as "sync:run"))
  const controller = new AbortController()
  const entries = new Map<string, Registration>()
  const dispose = () => {
    controller.abort()
    for (const entry of [...entries.values()]) entry.dispose()
    stopPermissions?.()
    runtime.signal?.removeEventListener("abort", dispose)
  }
  const check = () => {
    controller.signal.throwIfAborted()
    if (!hasPermission("sync:run")) throw new Error("Permission denied: sync:run is required")
  }
  let stopPermissions: (() => void) | undefined
  const subscribePermissions = () => {
    if (runtime.hasPermission || stopPermissions) return
    stopPermissions = getPermissionGuard().subscribePermissionChanges(() => {
      if (!hasPermission("sync:run")) dispose()
      else if (!hasPermission("auth:consume"))
        for (const entry of [...entries.values()]) if (entry.target.connectionRef) entry.dispose()
    })
  }
  runtime.signal?.addEventListener("abort", dispose, { once: true })
  if (runtime.signal?.aborted) dispose()
  activations.set(pluginId, { dispose })
  const validKey = (key: string) => {
    check()
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new Error("Invalid sync key")
    return `plugin:${pluginId}/${key}`
  }
  const get = (key: string) => {
    const entry = entries.get(validKey(key))
    if (!entry || !hasExternalSyncRegistration(entry.target.key))
      throw new Error("Sync key is not registered")
    return entry
  }
  const checkLive = (entry: Registration) => {
    check()
    entry.signal.throwIfAborted()
    if (entries.get(entry.target.key) !== entry)
      throw new DOMException("Sync registration disposed", "AbortError")
  }
  const verifyConnection = async (entry: Registration) => {
    checkLive(entry)
    if (entry.target.connectionRef) {
      const checkConnection = () => {
        checkLive(entry)
        if (!hasPermission("auth:consume"))
          throw new Error("Permission denied: auth:consume is required")
      }
      await assertSyncConnection(pluginId, entry.target.connectionRef, checkConnection)
      checkConnection()
    }
  }
  return {
    register<Item>(
      key: string,
      input: PluginSyncDriver<Item>,
      options: PluginSyncRegistrationOptions = {}
    ) {
      const namespaced = validKey(key)
      if (entries.has(namespaced)) throw new Error("Sync key already registered")
      const connectionRef = options.connectionRef
      if (connectionRef !== undefined && (typeof connectionRef !== "string" || !connectionRef))
        throw new Error("Invalid sync connectionRef")
      if (connectionRef && !hasPermission("auth:consume"))
        throw new Error("Permission denied: auth:consume is required")
      const lifetime = new AbortController()
      const target: ExternalSyncTarget = Object.freeze({
        key: namespaced,
        owner: `plugin:${pluginId}`,
        ...(connectionRef ? { connectionRef } : {}),
      })
      const verify = () => verifyConnection(entry)
      const driver = bridgeSyncDriver(input, {
        signal: lifetime.signal,
        check: verify,
        timeoutMs: runtime.callbackTimeoutMs,
      }) as ExternalSyncDriver<unknown>
      let unregister = () => {}
      const entry: Registration = {
        target,
        driver,
        signal: lifetime.signal,
        ready: Promise.resolve(),
        dispose() {
          if (entries.get(namespaced) !== entry) return
          lifetime.abort()
          unregister()
          entries.delete(namespaced)
        },
      }
      entries.set(namespaced, entry)
      try {
        unregister = registerExternalSync(
          target,
          async () => {
            await entry.ready
            checkLive(entry)
            await verify()
            checkLive(entry)
            return driver
          },
          {
            signal: lifetime.signal,
            onUnregister() {
              lifetime.abort()
              if (entries.get(namespaced) === entry) entries.delete(namespaced)
            },
          }
        )
        subscribePermissions()
        // Keep register synchronous for activation replay. Start authorization now,
        // and observe its rejection even if the plugin never requests a run.
        entry.ready = verify()
        void entry.ready.catch(() => {})
      } catch (error) {
        entry.dispose()
        throw error
      }
      return { dispose: entry.dispose }
    },
    async run(key, options = {}) {
      const entry = get(key)
      const signal = options.signal ? AbortSignal.any([entry.signal, options.signal]) : entry.signal
      try {
        await entry.ready
        checkLive(entry)
        signal.throwIfAborted()
        const previous = await getDb().externalSyncCursors.get(entry.target.key)
        checkLive(entry)
        signal.throwIfAborted()
        if (
          previous &&
          (previous.owner !== entry.target.owner ||
            previous.connectionRef !== entry.target.connectionRef)
        )
          return {
            status: "failed",
            errorCode: "target-mismatch",
            mode: "full",
            pages: 0,
            applied: 0,
            tombstoned: 0,
          }
        await verifyConnection(entry)
        checkLive(entry)
        signal.throwIfAborted()
        const result = await runExternalSync(Object.freeze({ ...entry.target }), entry.driver, {
          mode: options.full ? "full" : "auto",
          signal,
        })
        checkLive(entry)
        signal.throwIfAborted()
        return result
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
          return { status: "cancelled", mode: "full", pages: 0, applied: 0, tombstoned: 0 }
        throw error
      }
    },
    request(key, options) {
      const entry = get(key)
      if (!options || !["poll", "manual"].includes(options.reason))
        throw new Error("Invalid sync request reason")
      requestExternalSync(entry.target.key, options.reason, options)
    },
    async status(key) {
      const entry = get(key)
      const row = await getDb().externalSyncCursors.get(entry.target.key)
      checkLive(entry)
      return {
        lastSuccessAt: row?.lastSuccessAt,
        failures: row?.failures ?? 0,
        backoffUntil: row?.backoffUntil,
        lastErrorCode: row?.lastErrorCode,
        mode:
          row?.generation?.mode ??
          (row ? (row.invalidated || !row.cursor ? "full" : "incremental") : undefined),
        inProgress: isExternalSyncRunning(entry.target.key),
      }
    },
    async reset(key) {
      const entry = get(key)
      abortExternalSyncRuns(entry.target.key)
      const db = getDb()
      await db.transaction("rw", db.externalSyncCursors, db.externalSyncSeen, async () => {
        checkLive(entry)
        await db.externalSyncSeen.filter((row) => row.key === entry.target.key).delete()
        checkLive(entry)
        await db.externalSyncCursors.update(entry.target.key, {
          invalidated: true,
          generation: undefined,
          backoffUntil: undefined,
        })
        checkLive(entry)
      })
      checkLive(entry)
    },
  }
}
