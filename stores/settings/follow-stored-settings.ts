/**
 * Keeps a loaded settings store in step with its row when something other than
 * the store writes it.
 *
 * The store reads the singleton once (`load()` returns early once loaded) and
 * then only learns of its own saves. Several writers change the row behind it:
 * the account sync applier taking another device's settings, a paired client's
 * Companion pull, a Host applying a paired client's `app_settings_update`,
 * another window of the same profile. Each left the open settings page and the
 * running appearance on the values read at boot until a reload.
 *
 * This watches the row's `updatedAt` (every writer moves it) and reads the row
 * back when it differs from what the store holds. The watch belongs to one
 * database: when the active database changes (another account or runtime
 * target) or its connection is closed and reopened, it moves to the current
 * one, and a read that finishes after the database it started on stopped
 * being active is dropped (`refreshFromDatabase`).
 */

import Dexie, { type Subscription } from "dexie"

import { getDb, type CogniaDB } from "@/lib/db/schema"
import { subscribeRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

import { useSettingsStore } from "./settings-store"

/** Wait before watching again after the connection under the watch closed. */
export const FOLLOW_RETRY_MS = 1_000

export interface FollowStoredSettingsDeps {
  /** The active database (tests). */
  activeDb?: () => CogniaDB
  /** Notified when the active account or runtime target changes (tests). */
  subscribeScope?: (listener: () => void) => () => void
}

export function followStoredSettings(deps: FollowStoredSettingsDeps = {}): () => void {
  const activeDb = deps.activeDb ?? getDb
  const subscribeScope = deps.subscribeScope ?? subscribeRuntimeTargetContext
  let watched: CogniaDB | null = null
  let subscription: Subscription | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const watch = (): void => {
    if (stopped) return
    let db: CogniaDB
    try {
      db = activeDb()
    } catch {
      // No database in this context (pre-render): nothing to follow.
      return
    }
    if (db === watched && subscription) return
    subscription?.unsubscribe()
    watched = db
    // `Dexie.liveQuery`, not the named export: the latter is undefined under
    // Jest's module interop (see `prompt-overrides-initializer.tsx`).
    subscription = Dexie.liveQuery(async () => {
      const row = await db.settings.get("singleton")
      return row?.updatedAt ?? null
    }).subscribe({
      next: (stamp) => {
        const store = useSettingsStore.getState()
        if (!store.loaded || store.loadFailed) return
        if (stamp === (store.settings?.updatedAt ?? null)) return
        void store.refreshFromDatabase(db)
      },
      error: () => {
        // The connection under the watch closed (a schema bump reopens it, a
        // database switch replaces it). Watch whatever is active now.
        subscription = null
        watched = null
        if (stopped) return
        retry = setTimeout(() => {
          retry = null
          watch()
        }, FOLLOW_RETRY_MS)
      },
    })
  }

  watch()
  const unsubscribeScope = subscribeScope(watch)
  return () => {
    stopped = true
    unsubscribeScope()
    subscription?.unsubscribe()
    subscription = null
    if (retry) clearTimeout(retry)
  }
}
