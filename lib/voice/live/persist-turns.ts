/**
 * Writes finished voice turns into the chat history.
 *
 * A voice session that leaves no trace is a session the user cannot search,
 * resume in text, or share. But it is also the one place where writing *too*
 * much does damage, so three rules are enforced here rather than left to the
 * caller:
 *
 * - **Final turns only.** `assistantDraft` is a partial transcript that changes
 *   on every delta; persisting it would write a message per audio frame.
 *
 * - **No audio.** Only transcripts are stored. Audio bytes are large, are not
 *   searchable, and were never something the user agreed to keep.
 *
 * - **No workflow fan-out.** Each turn is stamped `triggerWorkflows: false`, so
 *   `lib/db/messages.ts` does not fire `trigger.chat.message` for speech that
 *   never went through the send path. The flag has to be on the FIRST write —
 *   metadata added later cannot retract a dispatch that already happened.
 *
 * - **Delta writes only.** A voice call does not own the session's transcript:
 *   the user can type, a connector can deliver, an agent turn can land while it
 *   runs. Turns are upserted through `commitMessageDelta`, never by reading the
 *   whole history and replacing it — a snapshot read before the write queue
 *   would delete any ordinary message committed in between.
 *
 * Tool calls ride along as `dynamic-tool` parts on the assistant message.
 * `UIMessage["role"]` has no `"tool"` member, so a tool turn is not its own row.
 */

import type { UIMessage } from "ai"

import type { LiveVoiceTurn } from "./reducer"
import type { RealtimeToolRecord } from "./tool-runtime"
import type { LiveVoiceMessageMetadata, PreparedRealtimeSession } from "./types"

/** Identifies the provider/model/region a turn was spoken to. */
export type LiveVoiceTurnProvenance = Pick<
  PreparedRealtimeSession,
  "provider" | "modelOrResource" | "region"
>

export interface LiveVoiceTurnsToMessagesOptions {
  /**
   * Identifies one voice call. Turn ids are only unique within a call — two
   * calls in the same chat both start their Gemini item counters at zero — so
   * the row id carries the call as well.
   */
  callId: string
  turns: readonly LiveVoiceTurn[]
  toolRecords?: readonly RealtimeToolRecord[]
  provenance: LiveVoiceTurnProvenance
  /** Wall clock for the first turn; later turns are spaced 1ms apart. */
  startedAt: number
  /** @internal Stable session-relative offsets reserved by the incremental writer. */
  createdAtOffsets?: readonly number[]
  /** @internal Stable offset for the aggregate tool lifecycle message. */
  toolCreatedAtOffset?: number
}

/**
 * Message ids are derived from the call and the turn id so re-persisting a
 * revised turn updates its row rather than duplicating it, while a later call
 * (or a reconnect, whose turn ids are connection-scoped) never overwrites an
 * earlier one.
 */
export function liveVoiceMessageId(sessionId: string, callId: string, turnId: string): string {
  return `voice:${sessionId}:${callId}:${turnId}`
}

/** Row id of a call's aggregate tool lifecycle message. */
export function liveVoiceToolMessageId(sessionId: string, callId: string): string {
  return liveVoiceMessageId(sessionId, callId, "tools")
}

function metadataFor(
  sessionId: string,
  provenance: LiveVoiceTurnProvenance,
  createdAt: number
): LiveVoiceMessageMetadata & { sessionId: string; createdAt: number } {
  return {
    provider: provenance.provider,
    modelOrResource: provenance.modelOrResource,
    region: provenance.region,
    modality: "audio",
    final: true,
    triggerWorkflows: false,
    // Hoisted keys — `persistMessages` reads and then strips these.
    sessionId,
    createdAt,
  }
}

/**
 * Project finished turns onto `UIMessage`s ready for `persistMessages`.
 *
 * Turns with no text survive nowhere: an empty transcript is what a turn looks
 * like when the provider heard only silence.
 */
export function liveVoiceTurnsToMessages(
  sessionId: string,
  options: LiveVoiceTurnsToMessagesOptions
): UIMessage[] {
  const messages: UIMessage[] = []

  options.turns.forEach((turn, index) => {
    const text = turn.text?.trim()
    if (!text) return
    // Ordering has to be stable and strictly increasing: `listMessages` sorts
    // by createdAt, and a whole voice session lands within the same millisecond.
    const createdAt = options.startedAt + (options.createdAtOffsets?.[index] ?? index)

    messages.push({
      id: liveVoiceMessageId(sessionId, options.callId, turn.id),
      role: turn.role,
      parts: [{ type: "text", text }],
      metadata: metadataFor(sessionId, options.provenance, createdAt),
    } as UIMessage)
  })

  if (options.toolRecords?.length) {
    messages.push({
      id: liveVoiceToolMessageId(sessionId, options.callId),
      role: "assistant",
      parts: options.toolRecords.map((record) => ({
        type: "dynamic-tool",
        toolCallId: record.callId,
        toolName: record.name,
        state: "output-available",
        // Deliberately omit provider arguments and result bodies. The history
        // records lifecycle and timing without creating a new sensitive-data sink.
        input: {},
        output: { status: record.status, durationMs: record.durationMs },
      })),
      metadata: metadataFor(
        sessionId,
        options.provenance,
        options.startedAt + (options.toolCreatedAtOffset ?? options.turns.length)
      ),
    } as UIMessage)
  }

  return messages
}

export interface PersistLiveVoiceTurnsOptions extends LiveVoiceTurnsToMessagesOptions {
  sessionId: string
  /**
   * Seam for tests. Defaults to `commitMessageDelta` (upserts only, nothing
   * the call did not write is ever touched) followed by the session's
   * last-message stamp, which only the full-transcript writer maintains.
   */
  commit?: (sessionId: string, upserts: UIMessage[]) => Promise<void>
}

async function commitVoiceUpserts(sessionId: string, upserts: UIMessage[]): Promise<void> {
  const { commitMessageDelta, stampSessionLastMessage } = await import("@/lib/db/messages")
  await commitMessageDelta(sessionId, { upserts })
  // The sidebar and Inbox read the denormalized preview; a delta write does not
  // refresh it. The stamp only moves forward, so an older revised turn cannot
  // replace a newer preview.
  let newest: UIMessage | undefined
  let newestAt = Number.NEGATIVE_INFINITY
  for (const message of upserts) {
    // The tool lifecycle row has no text to preview.
    if (!message.parts.some((part) => part.type === "text")) continue
    const createdAt = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
    if (typeof createdAt === "number" && createdAt >= newestAt) {
      newest = message
      newestAt = createdAt
    }
  }
  if (newest) {
    await stampSessionLastMessage(sessionId, {
      parts: newest.parts as Parameters<typeof stampSessionLastMessage>[1]["parts"],
      createdAt: newestAt,
    })
  }
}

/**
 * Upsert this call's finished voice turns into its chat history.
 *
 * Returns the exact projected voice records written by the successful
 * transaction. A session where nothing was said writes nothing at all.
 */
export async function persistLiveVoiceTurns(
  options: PersistLiveVoiceTurnsOptions
): Promise<UIMessage[]> {
  const voiceMessages = liveVoiceTurnsToMessages(options.sessionId, options)
  if (voiceMessages.length === 0) return []

  const commit = options.commit ?? commitVoiceUpserts
  await commit(options.sessionId, voiceMessages)
  return voiceMessages
}

export type LiveVoiceTurnPersisterOptions = Omit<
  PersistLiveVoiceTurnsOptions,
  "turns" | "toolRecords" | "createdAtOffsets" | "toolCreatedAtOffset"
> & {
  /** Runs only after Dexie accepted the projected records. */
  onPersisted?: (messages: readonly UIMessage[]) => void
}

/**
 * Serial, incremental writer for finalized turns in one live call.
 *
 * Revision-aware: a provider can revise a turn it already reported under the
 * same id (Gemini grows one input transcription item as the user keeps
 * talking), so a turn is written again whenever its text differs from what was
 * last written for that id. Re-sending identical text is a no-op.
 */
export class LiveVoiceTurnPersister {
  /** Text last committed per turn id. */
  private readonly persistedText = new Map<string, string>()
  /** Text of the newest queued write per turn id. */
  private readonly pendingText = new Map<string, string>()
  private persistedToolSignature = JSON.stringify([])
  private readonly pendingToolSignatures = new Set<string>()
  private readonly turnOffsetById = new Map<string, number>()
  private toolCreatedAtOffset: number | undefined
  private nextCreatedAtOffset = 0
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly options: LiveVoiceTurnPersisterOptions) {}

  append(
    turns: readonly LiveVoiceTurn[],
    toolRecords: readonly RealtimeToolRecord[] = []
  ): Promise<void> {
    const freshTurns = turns
      .filter((turn) => {
        if (!this.turnOffsetById.has(turn.id)) {
          this.turnOffsetById.set(turn.id, this.nextCreatedAtOffset++)
        }
        const text = turn.text
        const queued = this.pendingText.has(turn.id)
          ? this.pendingText.get(turn.id)
          : this.persistedText.get(turn.id)
        if (queued === text) return false
        this.pendingText.set(turn.id, text)
        return true
      })
      // The caller's array may be mutated later; the write must carry the text
      // that was current when it was queued.
      .map((turn) => ({ ...turn }))
    const nextToolSignature = JSON.stringify(
      toolRecords.map(({ callId, status, durationMs }) => [callId, status, durationMs])
    )
    const toolsChanged =
      nextToolSignature !== this.persistedToolSignature &&
      !this.pendingToolSignatures.has(nextToolSignature)
    if (toolsChanged) {
      this.pendingToolSignatures.add(nextToolSignature)
      this.toolCreatedAtOffset ??= this.nextCreatedAtOffset++
    }
    if (freshTurns.length === 0 && !toolsChanged) return this.tail

    // The runtime owns a mutable record array. Snapshot it now so a later tool
    // completion cannot change the payload while this write waits its turn.
    const toolSnapshot = toolRecords.map((record) => ({ ...record }))
    const operation = this.tail.then(async () => {
      const written = await persistLiveVoiceTurns({
        ...this.options,
        turns: freshTurns,
        createdAtOffsets: freshTurns.map((turn) => this.turnOffsetById.get(turn.id) ?? 0),
        ...(toolsChanged ? { toolRecords: toolSnapshot } : {}),
        ...(toolsChanged ? { toolCreatedAtOffset: this.toolCreatedAtOffset } : {}),
      })
      this.options.onPersisted?.(written)
    })
    void operation.then(
      () => {
        for (const turn of freshTurns) {
          this.persistedText.set(turn.id, turn.text)
          // A newer revision may already be queued behind this write.
          if (this.pendingText.get(turn.id) === turn.text) this.pendingText.delete(turn.id)
        }
        if (toolsChanged) {
          this.pendingToolSignatures.delete(nextToolSignature)
          this.persistedToolSignature = nextToolSignature
        }
      },
      () => {
        for (const turn of freshTurns) {
          if (this.pendingText.get(turn.id) === turn.text) this.pendingText.delete(turn.id)
        }
        if (toolsChanged) this.pendingToolSignatures.delete(nextToolSignature)
      }
    )
    // A failed write is observable to its caller but cannot poison later
    // writes; flush() can therefore retry any revision released above.
    this.tail = operation.catch(() => undefined)
    return operation
  }

  flush(
    turns: readonly LiveVoiceTurn[],
    toolRecords: readonly RealtimeToolRecord[] = []
  ): Promise<void> {
    return this.tail.then(() => this.append(turns, toolRecords))
  }
}

export function createLiveVoiceTurnPersister(
  options: LiveVoiceTurnPersisterOptions
): LiveVoiceTurnPersister {
  return new LiveVoiceTurnPersister(options)
}
