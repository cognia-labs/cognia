/**
 * The companion sync tables feature modules own (ADR-0250 §14
 * `syncHandlers`). A module declares the tables in its manifest, with the file
 * that holds their handlers; the generated registry
 * (`lib/modules/generated/sync-handlers.ts`) lists the tables and one lazy
 * import per module, so the sync orchestrator and the host-side reader know
 * every owner without loading any feature code.
 *
 * The orchestrator's table list (`./companion-sync.ts`) keeps each table's
 * stage and ordering, which render paths read synchronously; only the pull,
 * and the host-side reader where the rows need the module's code, come from
 * the module. A file loads once per module; one that fails to load is tried
 * again on the next sync. An `experimental` module owns nothing.
 */

import { loggers } from "@cognia/logging"
import type { ModuleSyncHandlersEntry } from "@/lib/modules/manifest-types"
import { MODULE_SYNC_HANDLERS } from "@/lib/modules/generated/sync-handlers"
import type {
  SyncPull,
  SyncServe,
  SyncServeContext,
  SyncTableHandler,
  SyncableTable,
} from "./types"

type Handlers = Readonly<Partial<Record<SyncableTable, SyncTableHandler>>>

let entries: readonly ModuleSyncHandlersEntry[] = MODULE_SYNC_HANDLERS
const loads = new Map<string, Promise<Handlers>>()

function ownerOf(table: SyncableTable): ModuleSyncHandlersEntry | undefined {
  return entries.find((entry) => entry.stage !== "experimental" && entry.tables.includes(table))
}

function loadEntry(entry: ModuleSyncHandlersEntry): Promise<Handlers> {
  const pending = loads.get(entry.module)
  if (pending) return pending
  const load = entry
    .load()
    .then(({ syncHandlers }) => {
      const declared = new Set<string>(entry.tables)
      const undeclared = Object.keys(syncHandlers).filter((table) => !declared.has(table))
      if (undeclared.length > 0)
        loggers.sync.error("sync handlers a module provides but does not declare", {
          module: entry.module,
          undeclared,
        })
      return syncHandlers
    })
    .catch((error: unknown) => {
      loads.delete(entry.module)
      throw error
    })
  loads.set(entry.module, load)
  return load
}

async function handlerOf(table: SyncableTable): Promise<SyncTableHandler | undefined> {
  const entry = ownerOf(table)
  if (!entry) return undefined
  return (await loadEntry(entry))[table]
}

/** Whether an active module owns `table`'s sync. */
export function hasModuleSyncHandler(table: SyncableTable): boolean {
  return ownerOf(table) !== undefined
}

/**
 * The orchestrator's pull for a module-owned table. It loads the owner on
 * first use. With no active owner, or an owner whose file does not provide
 * the table, the run fails as `not_implemented` and names the table, so a
 * table nobody serves shows up as a failure instead of syncing nothing.
 */
export function moduleSyncPull(table: SyncableTable): SyncPull {
  return async (transport, cursor) => {
    const handler = await handlerOf(table)
    if (!handler)
      return {
        ok: false,
        failure: {
          table,
          reason: "not_implemented",
          message: `no module provides the ${table} sync handler`,
        },
      }
    return handler.pull(transport, cursor)
  }
}

/**
 * The host-side reader a module contributes for `table`, or `undefined` when
 * the table is read by the host's generic reader (no owner, or an owner whose
 * rows need no projection).
 */
export async function moduleSyncServe(table: SyncableTable): Promise<SyncServe | undefined> {
  return (await handlerOf(table))?.serve
}

/** Read `table` through its owner's reader; `undefined` when it has none. */
export async function serveModuleSyncTable(
  table: SyncableTable,
  since: number,
  context: SyncServeContext
): Promise<Awaited<ReturnType<SyncServe>> | undefined> {
  const serve = await moduleSyncServe(table)
  return serve ? serve(since, context) : undefined
}

/** Replace the registry and forget what was loaded. */
export function __setModuleSyncHandlersForTesting(
  next: readonly ModuleSyncHandlersEntry[] = MODULE_SYNC_HANDLERS
): void {
  entries = next
  loads.clear()
}
