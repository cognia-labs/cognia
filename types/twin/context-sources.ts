/**
 * What the twin module's identity section reports for the UI
 * (`SendOptions.contextSources`, ADR-0250 §14 `context` amendment): the chat
 * hook and the room runner fold the chunks and style samples into the
 * assistant message's sources part, and grounding and compaction read the
 * retrieved text.
 */

/** `contextSources["twin.identity"]`: what shaped a twin-bound reply this turn. */
export interface TwinIdentitySources {
  twinId: string
  retrievedChunks: Array<{
    chunk: { id: string; vectorDocId: string; contentRedacted: string; sourceId: string }
    score: number
    sourceTitle?: string
  }>
  selectedStyleSamples: Array<{
    id: string
    contextLabel: string
    summary: string
    tone: string[]
  }>
  /** The runtime degraded to a no-context send (embedding or store unreachable). */
  degraded: boolean
  /**
   * Formatted citations for the retrieved chunks when the agent has
   * `enableCitations` on: metadata only, never part of the prompt.
   * Structural mirror of `@cognia/rag` `Citation`.
   */
  citations?: Array<{
    id: string
    marker: string
    fullCitation: string
    source: string
    title?: string
    relevanceScore?: number
  }>
}

declare module "@/lib/modules/manifest-types" {
  interface ContextSourcesMap {
    "twin.identity": TwinIdentitySources
  }
}
