/**
 * What each prompt slot last resolved to, in this context (ADR-0236).
 *
 * The Prompt Center shows published configuration and actual use as separate
 * facts: "published revision X" is a database statement, "the last title
 * request used revision X" is this log. It is memory-only and holds ids, never
 * prompt text or task data, so nothing private is persisted or exported.
 */

import * as dbSchema from "@/lib/db/schema"
import type { PromptResolutionContext, PromptSource } from "./types"

export interface PromptResolutionRecord {
  promptId: string
  source: PromptSource
  context: PromptResolutionContext
  at: number
  /** Account database partition that owned this resolution. */
  database?: string
}

interface PartitionLog {
  latest: Map<string, PromptResolutionRecord>
  recent: PromptResolutionRecord[]
}

const MAX_RECENT = 200
const byDatabase = new Map<string, PartitionLog>()
const listeners = new Set<() => void>()
let subscribedToDbSwitch = false

function currentDatabase(): string {
  try {
    if (typeof dbSchema.activeDatabaseName === "function") {
      return dbSchema.activeDatabaseName()
    }
    return dbSchema.getDb?.()?.name ?? "default"
  } catch {
    return "default"
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A UI subscriber must never break a model call.
    }
  }
}

function ensureDatabaseSubscription(): void {
  if (subscribedToDbSwitch) return
  if (typeof dbSchema.onActiveDatabaseChange !== "function") return
  subscribedToDbSwitch = true
  dbSchema.onActiveDatabaseChange(() => {
    notifyListeners()
  })
}

function partitionFor(database: string): PartitionLog {
  let partition = byDatabase.get(database)
  if (!partition) {
    partition = { latest: new Map(), recent: [] }
    byDatabase.set(database, partition)
  }
  return partition
}

export function recordPromptResolution(record: PromptResolutionRecord): void {
  ensureDatabaseSubscription()
  const database = record.database ?? currentDatabase()
  const entry: PromptResolutionRecord = { ...record, database }
  const partition = partitionFor(database)
  partition.latest.set(entry.promptId, entry)
  partition.recent.push(entry)
  if (partition.recent.length > MAX_RECENT) {
    partition.recent.splice(0, partition.recent.length - MAX_RECENT)
  }
  notifyListeners()
}

/** The latest resolution of one prompt in the active account partition, if any. */
export function lastPromptResolution(
  promptId: string,
  database = currentDatabase()
): PromptResolutionRecord | undefined {
  return byDatabase.get(database)?.latest.get(promptId)
}

/** Recent resolutions in the active account partition, newest first. */
export function recentPromptResolutions(database = currentDatabase()): PromptResolutionRecord[] {
  const recent = byDatabase.get(database)?.recent
  return recent ? [...recent].reverse() : []
}

export function subscribePromptResolutions(listener: () => void): () => void {
  ensureDatabaseSubscription()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam. */
export function __resetPromptResolutionsForTests(): void {
  byDatabase.clear()
}
