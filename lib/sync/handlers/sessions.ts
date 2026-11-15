import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"
import { mergePortableManagedContext } from "@/lib/task-workspace/managed-workspace"

export function syncSessions(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<ChatSession>(
    {
      table: "sessions",
      getTable: () => getDb().sessions,
      applyRows: async (rows, assertCurrent) => {
        const db = getDb()
        const table = db.sessions
        await db.transaction("rw", table, async () => {
          // Every session can have a device-local Host binding. Read and merge
          // atomically so an arriving delta cannot erase a concurrent choice.
          const existing = new Map(
            (await table.bulkGet(rows.map((row) => row.id)))
              .filter((row): row is ChatSession => row !== undefined)
              .map((row) => [row.id, row])
          )
          assertCurrent()
          await table.bulkPut(
            rows.map(({ hostBinding: _untrustedBinding, ...row }) => {
              const local = existing.get(row.id)
              // Only the binding is this device's own. Everything else on the
              // row (working dir, SDK resume ids, execution context) is the
              // source Host's truth and must not be frozen at a local copy.
              const merged = row.executionContext
                ? {
                    ...row,
                    executionContext: mergePortableManagedContext(
                      row.executionContext,
                      local?.executionContext
                    ),
                  }
                : row
              return local?.hostBinding ? { ...merged, hostBinding: local.hostBinding } : merged
            })
          )
        })
      },
    },
    transport,
    cursor
  )
}
