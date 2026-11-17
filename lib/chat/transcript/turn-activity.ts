/**
 * A Host's folded turn carries its activity summary (protocol 2, D12); the
 * timeline surface stamps it on the turn's reply preview so the reply draws
 * the same "Worked for …" row a local turn folds its process into, and the
 * row opens the turn's detail. Pure.
 */

import type { TranscriptTurnActivity } from "@cognia/agent-config-types"

/** Where on a preview message's metadata the stamp lives. */
export const TRANSCRIPT_ACTIVITY_METADATA_KEY = "transcriptActivity"

/** A folded turn's activity, and what opening its detail needs. */
export interface TranscriptActivityStamp {
  activity: TranscriptTurnActivity
  turnKey: string
  revision: number
  detailRevision: number
}

function isActivity(value: unknown): value is TranscriptTurnActivity {
  const candidate = value as Partial<TranscriptTurnActivity> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.toolCount === "number" &&
    typeof candidate.failedCount === "number" &&
    typeof candidate.reasoningCount === "number" &&
    typeof candidate.sourceCount === "number" &&
    Array.isArray(candidate.tools)
  )
}

/** The stamp on a message, or null when it is not a Host turn's folded reply. */
export function transcriptActivityOf(message: {
  metadata?: unknown
}): TranscriptActivityStamp | null {
  const metadata = message.metadata as Record<string, unknown> | undefined
  const stamp = metadata?.[TRANSCRIPT_ACTIVITY_METADATA_KEY] as
    Partial<TranscriptActivityStamp> | undefined
  if (
    !stamp ||
    !isActivity(stamp.activity) ||
    typeof stamp.turnKey !== "string" ||
    typeof stamp.revision !== "number" ||
    typeof stamp.detailRevision !== "number"
  ) {
    return null
  }
  return stamp as TranscriptActivityStamp
}
