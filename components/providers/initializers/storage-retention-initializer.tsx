"use client"

// Fires once on app boot. Runs an initial prune of unbounded Dexie tables
// (deleting `agentTraces` spans older than
// `storageRetention.traceRetentionDays`) and schedules a daily sweep so the
// table can't grow without bound. Mirrors `AuditRetentionInitializer` — the
// per-table LRU caps elsewhere are the lower bound; this enforces the
// operator-configured upper-bound time window.

import { useEffect } from "react"

import { startStorageRetentionSweeper, type Unsubscribe } from "@/lib/storage/retention"

export function StorageRetentionInitializer() {
  useEffect(() => {
    let stopped = false
    let unsubscribe: Unsubscribe | undefined
    void startStorageRetentionSweeper().then((dispose) => {
      if (stopped) dispose()
      else unsubscribe = dispose
    })
    return () => {
      stopped = true
      unsubscribe?.()
    }
  }, [])

  return null
}

export default StorageRetentionInitializer
