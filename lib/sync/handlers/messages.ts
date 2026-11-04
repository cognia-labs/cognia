import { preservePersonalMarkMetadata } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { StoredMessage } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Sync recent chat messages. The server caps the response at the last 200
 * messages per session so a freshly-paired phone doesn't pull every
 * historical line — older history is fetched on demand when the user
 * scrolls into a session.
 */
export function syncMessages(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<StoredMessage>(
    {
      table: "messages",
      getTable: () => getDb().messages,
      applyRows: async (rows, assertCurrent) => {
        const db = getDb()
        await db.transaction("rw", db.messages, async () => {
          const previous = await db.messages.bulkGet(rows.map((row) => row.id))
          assertCurrent()
          const merged = rows.map((row, index) => ({
            ...row,
            metadata: preservePersonalMarkMetadata(row.metadata, previous[index]?.metadata, {
              rowExists: !!previous[index],
            }),
          }))
          await db.messages.bulkPut(merged)
        })
      },
    },
    transport,
    cursor
  )
}
