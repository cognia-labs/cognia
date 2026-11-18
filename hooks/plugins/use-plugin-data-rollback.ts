"use client"

/**
 * What rolling a plugin back to a version does to its data (ADR-0258), for the
 * confirmations that ask before a rollback or a backup restore.
 *
 * Re-read whenever the backup index changes, which every rollback and restore
 * signals, because a restore deletes the snapshot it used.
 */

import { useEffect, useState } from "react"

import { getDb } from "@/lib/db/schema"
import {
  describePluginDataRollback,
  type PluginDataRollback,
} from "@/lib/plugin/dexie/data-rollback"
import { usePluginBackupIndexRevision } from "./use-plugin-rollback-availability"

interface Loaded {
  key: string
  data?: PluginDataRollback
  error?: string
}

export interface PluginDataRollbackState {
  /** `null` while loading, or when there is nothing to ask about. */
  data: PluginDataRollback | null
  error: string | null
}

export function usePluginDataRollback(
  pluginId: string | null,
  version: string | null
): PluginDataRollbackState {
  const revision = usePluginBackupIndexRevision()
  const key = pluginId && version ? `${pluginId}@${version}` : null
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!pluginId || !version) return
    let cancelled = false
    const requested = `${pluginId}@${version}`
    describePluginDataRollback(() => getDb(), pluginId, version).then(
      (data) => {
        if (!cancelled) setLoaded({ key: requested, data })
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoaded({
            key: requested,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [pluginId, version, revision])

  // Only ever answer for the version being asked about.
  const current = loaded && loaded.key === key ? loaded : null
  return { data: current?.data ?? null, error: current?.error ?? null }
}
