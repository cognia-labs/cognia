/**
 * Squad delegations parked for an approval (schema v259).
 *
 * A delegation deferred to `awaiting_approval` (quiet hours, an operator
 * gate) has no child run yet: its record lives in the Squad store and its run
 * parameters in the orchestrator's memory, so a reload used to drop it with
 * nothing to approve. One row here keeps it until it is approved, cancelled or
 * settled. Every text in it went through the Squad persistence gate
 * (`lib/squads/persisted-text.ts`): placeholders stand where personal data
 * was, and a run whose text could not be cleaned is not kept at all (`run`
 * absent), so the restart can say so instead of running something else.
 *
 * `lib/squads/delegation-orchestrator.ts` is the only writer. Rows are taken
 * whole by an approval (`claimParkedDelegation`), which makes the approval
 * that ran it the only one that can, across windows of one database.
 */
import type Dexie from "dexie"
import type { Table } from "dexie"
import type { AgentSystemType } from "@/types/agent/agent-team"

/** What a parked delegation runs once approved, its texts redacted. */
export interface ParkedDelegationRun {
  kind: "background" | "external" | "twin" | "team"
  /** The work handed over. Empty for a team, which runs its own objective. */
  prompt: string
  systemPrompt?: string
  /**
   * background/twin: the child's id (its Job Center entry and the record's
   * `targetId`); external: the target agent id; team: the target team id.
   */
  targetId: string
  /** twin delegations only: the Employee Digital Twin to answer as. */
  twinId?: string
  /** The run that asked, when it is not the source team's live run. */
  parentRunId?: string
  personalExecutionRunId?: string
  timeoutMs?: number
  /** team delegations only: force ultracode orchestration on the target run. */
  ultracode?: boolean
}

export interface SquadParkedDelegationRow {
  /** The delegation's id. */
  id: string
  sourceTeamId: string
  sourceTaskId: string
  targetType: AgentSystemType
  targetId?: string
  /** Redacted; empty when even the redacted reason would leak. */
  reason: string
  manual: boolean
  createdAt: number
  /** The caller's metadata, kept only when none of it leaks. */
  metadata?: Record<string, unknown>
  /** Absent when the work could not be kept without personal data. */
  run?: ParkedDelegationRun
  /** True when redaction replaced something the run will be handed. */
  redacted: boolean
}

function parkedDelegations(db: Dexie): Table<SquadParkedDelegationRow, string> {
  return db.table("squadParkedDelegations")
}

/** Keep (or replace) one parked delegation. */
export async function putParkedDelegation(db: Dexie, row: SquadParkedDelegationRow): Promise<void> {
  await parkedDelegations(db).put(row)
}

/**
 * Take one parked delegation: read and delete it in one transaction, so only
 * one approval ever gets it. `undefined` when it is not (or no longer) kept.
 */
export async function claimParkedDelegation(
  db: Dexie,
  id: string
): Promise<SquadParkedDelegationRow | undefined> {
  const table = parkedDelegations(db)
  return db.transaction("rw", table, async () => {
    const row = await table.get(id)
    if (row) await table.delete(id)
    return row
  })
}

/** Forget one parked delegation. Forgetting one that is not kept is a no-op. */
export async function deleteParkedDelegation(db: Dexie, id: string): Promise<void> {
  await parkedDelegations(db).delete(id)
}

/** Every parked delegation, oldest first. */
export async function listParkedDelegations(db: Dexie): Promise<SquadParkedDelegationRow[]> {
  const rows = await parkedDelegations(db).toArray()
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
