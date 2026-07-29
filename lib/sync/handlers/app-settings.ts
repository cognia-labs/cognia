import type { Table } from "dexie"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { AppSettings } from "@cognia/agent-config-types"
import { CROSS_PLATFORM_SETTING_KEYS } from "@cognia/agent-config-types/settings-sync"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Settings fields that are safe to mirror from the host onto a paired client.
 *
 * The singleton `AppSettings` row mixes portable preferences (theme, language,
 * model defaults) with desktop-only / device-local state (filesystem
 * `defaultWorkingDir`, `networkProxy`, `apiKey`, OCR provider config, …). A
 * blind whole-row `bulkPut` would clobber the client's own device-local fields
 * with the host's, so we merge only this subset.
 *
 * The list is no longer written here: it is derived from the one classification
 * table in `packages/agent-config-types/src/settings-sync.ts`, which also
 * generates the Rust write-allowlist. They used to be two hand-maintained lists
 * and had drifted badly — ~51 fields were writable up but never mirrored back
 * (so the phone's appearance, TTS, notification and search preferences silently
 * diverged from the desktop's forever), and the WebRTC/signaling fields were
 * classified in exactly the wrong direction.
 */
export { CROSS_PLATFORM_SETTING_KEYS }

/**
 * Merge the allowlisted cross-platform fields from the desktop's settings
 * row onto the phone's local singleton, preserving the phone's device-local
 * fields. `rows` is the singleton delta (0 or 1 row) from `sync_pull`.
 */
async function applySettingsRows(rows: AppSettings[]): Promise<void> {
  const incoming = rows[0]
  if (!incoming) return
  const db = getDb()
  const current = (await db.settings.get("singleton")) ?? { id: "singleton" as const }
  const merged: Record<string, unknown> = { ...current, id: "singleton" }
  for (const key of CROSS_PLATFORM_SETTING_KEYS) {
    if (incoming[key] !== undefined) merged[key] = incoming[key]
  }
  await db.settings.put(merged as unknown as AppSettings)
}

/**
 * Sync the singleton AppSettings row. The desktop emits the row whenever
 * the caller's cursor predates the row's `updatedAt` (or on the first pull
 * when `since === 0`). Only the cross-platform subset is applied — see
 * {@link CROSS_PLATFORM_SETTING_KEYS} — so the phone keeps its own
 * device-local preferences.
 */
export function syncAppSettings(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AppSettings>(
    {
      table: "settings",
      // `settings` is typed `Table<AppSettings, "singleton">`; widen the key
      // type so it satisfies `runSyncHandler`'s `Table<TRow, string>`.
      getTable: () => getDb().settings as unknown as Table<AppSettings, string>,
      applyRows: applySettingsRows,
    },
    transport,
    cursor
  )
}
