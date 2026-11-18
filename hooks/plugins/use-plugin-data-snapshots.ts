"use client"

/**
 * A plugin's data snapshots, newest first (ADR-0258), so its page can say
 * which data versions a rollback can bring back and which ones it cannot.
 *
 * Re-read whenever the backup index changes (every rollback and restore
 * signals it) and when an activation finishes, which is when a migration
 * takes a new snapshot.
 */

import { useEffect, useState } from "react"

import { getDb } from "@/lib/db/schema"
import {
  listPluginDataSnapshots,
  type PluginDataSnapshotRecord,
} from "@/lib/db/plugin-data-snapshots"
import { usePluginStore } from "@/stores/plugin-runtime"
import { usePluginBackupIndexRevision } from "./use-plugin-rollback-availability"

interface Loaded {
  pluginId: string
  records?: PluginDataSnapshotRecord[]
  error?: string
}

export interface PluginDataSnapshotsState {
  /** `null` while loading. */
  records: PluginDataSnapshotRecord[] | null
  error: string | null
}

export function usePluginDataSnapshots(pluginId: string, enabled = true): PluginDataSnapshotsState {
  const revision = usePluginBackupIndexRevision()
  const status = usePluginStore((state) => state.plugins[pluginId]?.status)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    listPluginDataSnapshots(getDb(), pluginId).then(
      (records) => {
        if (!cancelled) setLoaded({ pluginId, records })
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoaded({ pluginId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [pluginId, enabled, revision, status])

  const current = loaded && loaded.pluginId === pluginId ? loaded : null
  return { records: current?.records ?? null, error: current?.error ?? null }
}
