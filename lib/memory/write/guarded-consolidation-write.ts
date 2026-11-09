import { getDb } from "@/lib/db/schema"
import { getMemory } from "@/lib/db/memories"
import {
  checkConsolidationTarget,
  type ConsolidationMutationResult,
  type ConsolidationTargetGuard,
} from "@/lib/memory/consolidate/consolidator"
import type { Memory } from "@/types/memory/memory"

/** Shared by both write factories; DB CRUD stays policy-free. No vector I/O here. */
export async function withConsolidationTarget(
  id: string,
  guard: ConsolidationTargetGuard,
  operation: "update" | "forget",
  mutate: (current: Memory) => Promise<void | ConsolidationMutationResult>
): Promise<ConsolidationMutationResult> {
  const db = getDb()
  // Nested "rw" joins the durable worker's withMemoryJobWrite transaction.
  // In-process callers get the same atomic check/write in a root transaction.
  return db.transaction("rw", [db.memories, db.memoryEvidence, db.memoryAuditEvents], async () => {
    const current = await getMemory(id)
    const result = checkConsolidationTarget(current, guard, operation)
    if (!result.ok) return result
    return (await mutate(current!)) ?? { ok: true }
  })
}
