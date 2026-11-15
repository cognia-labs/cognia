/**
 * Brain durability (ADR-0059).
 *
 * fake-indexeddb is in-memory; the long-lived serve process persists it
 * through the SQLite durability store (`./persistence/`): every committed
 * Dexie transaction is on disk before it resolves, so there is no debounce
 * window to lose on a crash. This module arms it for one account and adds:
 *
 * - **Exit hooks**: SIGINT/SIGTERM close the store.
 * - **RSS gauge**: `rss()` feeds the bridge pong frames so the server can
 *   watch the in-memory dataset ceiling.
 */
import { getDb } from "@/lib/db/schema"

import { prepareBuiltinPluginSchema } from "../db/bootstrap"
import type { SnapshotSource } from "../db/snapshot"
import {
  openDurabilityStore,
  type DurabilityDbLike,
  type DurabilitySourceLike,
  type DurabilityStore,
} from "./persistence/store"
import type { DurabilityBackendId } from "./persistence/types"

export interface DurabilityOptions {
  /** Persistence home (`~/.cognia/serve` by default at the call site). */
  home: string
  accountId: string
  /** Injected process for signal hooks (tests). */
  proc?: Pick<NodeJS.Process, "on" | "off" | "memoryUsage">
  /** Warn when the long-lived brain crosses this RSS ceiling. */
  rssWarningBytes?: number
  /** Injected alert sink (tests/embedding). */
  onRssWarning?: (rssBytes: number, limitBytes: number) => void
}

export interface DurabilityHandle {
  /** The backend this process armed. */
  backend: DurabilityBackendId
  /**
   * Required by `bootstrapHeadlessRuntimes`. A no-op: every committed
   * transaction is already on disk by the time it resolves.
   */
  notifyDbWrite: () => void
  /** RSS + last-flush gauge for the bridge pong frames. */
  rss(): { rssBytes: number; lastFlushAt: number }
  /** Close the store + detach signal hooks. Safe to call more than once. */
  dispose(): Promise<void>
}

/**
 * The one database the headless brain persists.
 *
 * There used to be two: the account database plus the scheduler's own
 * `CogniaSchedulerDB`. Schema v219 folded the schedule into the account
 * database, so the second source is gone. The run-history exclusion moved onto
 * the primary source: an append-heavy run-history table would make the store
 * grow with uptime.
 */
async function resolveDurabilitySources(): Promise<DurabilitySourceLike[]> {
  const { SCHEDULER_SNAPSHOT_EXCLUDED_TABLES } = await import("@/lib/scheduler/scheduler-db")
  const primary = getDb() as unknown as DurabilityDbLike
  return [
    {
      name: primary.name ?? "CogniaDB",
      db: primary,
      excludeTables: SCHEDULER_SNAPSHOT_EXCLUDED_TABLES,
    },
  ]
}

/**
 * Open the account's durability store and arm the exit hooks.
 *
 * The store installs its capture middleware before Dexie opens: `db.use()`
 * only records the middleware, and the DBCore stack is generated at open time
 * (`generateMiddlewareStacks`), so a post-open `use()` would be inert.
 */
export async function startDurability(opts: DurabilityOptions): Promise<DurabilityHandle> {
  const proc = opts.proc ?? process
  const rssWarningBytes = opts.rssWarningBytes ?? 1_500 * 1024 * 1024
  const onRssWarning =
    opts.onRssWarning ??
    ((rssBytes: number, limitBytes: number) => {
      process.emitWarning(
        `cognia serve RSS ${rssBytes} bytes exceeded the ${limitBytes} byte durability ceiling`,
        { code: "COGNIA_SERVE_RSS_HIGH" }
      )
    })
  let rssWarningActive = false

  function readRss(): number {
    const rssBytes = proc.memoryUsage().rss
    if (rssBytes >= rssWarningBytes) {
      if (!rssWarningActive) onRssWarning(rssBytes, rssWarningBytes)
      rssWarningActive = true
    } else {
      rssWarningActive = false
    }
    return rssBytes
  }

  // `startDurability` is reachable from tests and embedders that have not
  // installed the shim, and `getDb()` throws without `window`.
  const { installFakeIndexedDb } = await import("@/lib/headless/node-indexeddb")
  await installFakeIndexedDb()

  const store: DurabilityStore = await openDurabilityStore({
    home: opts.home,
    accountId: opts.accountId,
    getSources: resolveDurabilitySources,
    prepareDynamicSchema: (sources, persistedVersions, persistedTables) =>
      prepareBuiltinPluginSchema(
        sources as unknown as SnapshotSource[],
        persistedVersions,
        persistedTables
      ),
    whenReady: async () => {
      const { whenSeeded } = await import("@/lib/db/schema")
      await whenSeeded()
    },
  })

  let disposed = false
  const onSignal = (): void => {
    void dispose()
  }
  proc.on("SIGINT", onSignal)
  proc.on("SIGTERM", onSignal)

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    proc.off?.("SIGINT", onSignal)
    proc.off?.("SIGTERM", onSignal)
    await store.close()
  }

  return {
    backend: store.backend.id,
    notifyDbWrite: () => {},
    rss: () => ({ rssBytes: readRss(), lastFlushAt: store.sequence() }),
    dispose,
  }
}
