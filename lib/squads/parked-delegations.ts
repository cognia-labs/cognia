/**
 * A delegation parked for an approval, as it is kept across a restart
 * (`squadParkedDelegations`, schema v259) and as it comes back.
 *
 * Everything written goes through the Squad persistence gate
 * (`redactTeamTextForPersistence`). The run's prompt and system prompt keep
 * placeholders where personal data was, and an approval after a restart runs
 * with those: the originals stay only in the memory of the process that
 * created the delegation. A run whose text still leaks after redaction is not
 * written at all, so the restart can settle it with that reason instead of
 * running a stand-in. The reason shown in the panel is redacted the same way,
 * and the caller's metadata is kept only when none of it leaks.
 */

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { TeamDelegationRecord } from "@/types/agent/agent-team"
import type {
  ParkedDelegationRun,
  SquadParkedDelegationRow,
} from "@/lib/db/squad-parked-delegations"
import { redactTeamTextForPersistence } from "./persisted-text"

/** Why a restored delegation cannot run: its work was never written down. */
export const DELEGATION_RUN_WITHHELD =
  "delegation_run_withheld: its instructions could not be kept without personal data, so they did not survive the restart; delegate it again"

/** The metadata flag a restored record carries when its run text was redacted. */
export const RESTORED_REDACTED_METADATA_KEY = "restoredRedacted"

/** A plain, structured-clone-safe copy of the caller's metadata, or nothing. */
function keptMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata || !hasNoLeakingPiiDeep(metadata)) return undefined
  try {
    const copy = JSON.parse(JSON.stringify(metadata)) as unknown
    return copy && typeof copy === "object" && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The run as written, or `undefined` when one of its texts would leak. */
function keptRun(run: ParkedDelegationRun): ParkedDelegationRun | undefined {
  const prompt = redactTeamTextForPersistence(run.prompt)
  if (prompt === undefined) return undefined
  if (run.systemPrompt === undefined) return { ...run, prompt }
  const systemPrompt = redactTeamTextForPersistence(run.systemPrompt)
  return systemPrompt === undefined ? undefined : { ...run, prompt, systemPrompt }
}

/** The row `record`, parked with `run`, is kept as. */
export function parkedDelegationRow(
  record: TeamDelegationRecord,
  run: ParkedDelegationRun
): SquadParkedDelegationRow {
  const kept = keptRun(run)
  const metadata = keptMetadata(record.metadata)
  return {
    id: record.id,
    sourceTeamId: record.sourceTeamId,
    sourceTaskId: record.sourceTaskId,
    targetType: record.targetType,
    ...(record.targetId !== undefined ? { targetId: record.targetId } : {}),
    reason: redactTeamTextForPersistence(record.reason) ?? "",
    manual: record.manual,
    createdAt: record.createdAt.getTime(),
    ...(metadata ? { metadata } : {}),
    ...(kept ? { run: kept } : {}),
    redacted:
      kept !== undefined && (kept.prompt !== run.prompt || kept.systemPrompt !== run.systemPrompt),
  }
}

/** The record a kept row comes back as: still awaiting its approval. */
export function restoredDelegationRecord(
  row: SquadParkedDelegationRow,
  now: Date
): TeamDelegationRecord {
  const metadata = {
    ...row.metadata,
    ...(row.redacted ? { [RESTORED_REDACTED_METADATA_KEY]: true } : {}),
  }
  return {
    id: row.id,
    sourceTeamId: row.sourceTeamId,
    sourceTaskId: row.sourceTaskId,
    targetType: row.targetType,
    ...(row.targetId !== undefined ? { targetId: row.targetId } : {}),
    status: "awaiting_approval",
    reason: row.reason,
    manual: row.manual,
    createdAt: new Date(row.createdAt),
    updatedAt: now,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

/** True when a restored record's run will be handed redacted text. */
export function isRestoredRedacted(record: Pick<TeamDelegationRecord, "metadata">): boolean {
  return record.metadata?.[RESTORED_REDACTED_METADATA_KEY] === true
}
