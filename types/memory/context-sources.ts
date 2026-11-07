/**
 * What the memory module's context contributions report for the UI
 * (`SendOptions.contextSources`, ADR-0250 §14 `context` amendment): the chat
 * hook folds them into the assistant message's sources part, and grounding
 * and compaction read the recalled text.
 */

import type { MemoryContextSnapshot } from "@cognia/memory"
import type {
  MemoryEvidenceState,
  MemoryReviewStatus,
  MemoryType,
  ProjectMemoryKind,
} from "@cognia/memory/types/memory"

/** `contextSources["memory.recall"]`: the personal memories this turn recalled. */
export interface MemoryRecallSources {
  retrievedMemories: Array<{
    id: string
    type: MemoryType
    text: string
    score: number
    evidenceState?: MemoryEvidenceState
    reviewStatus?: MemoryReviewStatus
  }>
  proceduralCount: number
  withheldCount?: number
  budget?: { limit: number; used: number; truncated: boolean }
  degraded: boolean
  /**
   * `"prepared"` delivery receipt for the injection pass; the chat hook's
   * sources merge upgrades it to `delivered` as it lands on the message.
   */
  snapshot?: MemoryContextSnapshot
}

/**
 * `contextSources["memory.continuity"]`: the claims mined from this
 * workspace's history this turn recalled, each with the message it was
 * observed in.
 */
export interface ProjectContinuitySources {
  claims: Array<{
    id: string
    kind: ProjectMemoryKind
    text: string
    relevance: number
    observedAt?: number
    validatedAt?: number
    sourceSessionId?: string
    sourceMessageId?: string
  }>
  withheldCount: number
  budget: { limit: number; used: number; truncated: boolean }
  /** Retrieval was thin — claims existed but did not make it in. */
  weak: boolean
  degraded: boolean
}

declare module "@/lib/modules/manifest-types" {
  interface ContextSourcesMap {
    "memory.recall": MemoryRecallSources
    "memory.continuity": ProjectContinuitySources
  }
}
