import type {
  StoredMessage,
  TranscriptBranchGroupSummary,
  TranscriptDirection,
  TranscriptErrorCode,
  TranscriptMediaReference,
  TranscriptMessage,
  TranscriptMessagePreview,
  TranscriptTimelineItem,
} from "@cognia/agent-config-types"
import {
  TRANSCRIPT_PROTOCOL_VERSION,
  TRANSCRIPT_SUMMARY_BYTE_LIMIT,
  TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
} from "@cognia/agent-config-types"
import { isToolPartType } from "@/lib/chat/agent-flow-grouping"
import { resolveBranchWinners, visibleThread } from "@/lib/chat/branch-visibility"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"
import { assistantAgentKey } from "@/lib/chat/transcript-agents"

interface ProjectTimelineOptions {
  sessionId: string
  revision: number
  messages: StoredMessage[]
  activeTurnKey?: string
  activeBranchByGroup?: Record<string, string>
}

/**
 * Where the next backward page starts: just older than this row. A keyset,
 * not a row count from the newest edge, so it stays valid while the session
 * grows at the newest edge (a reply streaming in bumps the revision on every
 * checkpoint). Earlier cursors were a revision-bound `position`; one of those
 * reads as stale, and the client re-reads from the newest page.
 */
interface TimelineCursorPayload {
  version: typeof TRANSCRIPT_PROTOCOL_VERSION
  kind: "keyset"
  sessionId: string
  direction: TranscriptDirection
  before: { createdAt: number; id: string }
}

/** A position inside one turn, valid while that turn's version holds. */
interface TurnDetailCursorPayload {
  version: typeof TRANSCRIPT_PROTOCOL_VERSION
  sessionId: string
  turnKey: string
  detailRevision: number
  position: number
}

type CursorValidation<T> = { ok: true; value: T } | { ok: false; code: TranscriptErrorCode }

const encoder = new TextEncoder()
const PREVIEW_TEXT_BYTE_LIMIT = 24 * 1024

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  // encodeInto stops at a whole code point when the preview buffer fills.
  // Encoding the entire response, then binary-searching and re-encoding its
  // prefixes, needlessly scans megabytes to display at most 24 KB.
  const buffer = new Uint8Array(Math.min(maxBytes, value.length * 3))
  const { read } = encoder.encodeInto(value, buffer)
  return { text: value.slice(0, read), truncated: read < value.length }
}

function messageText(message: StoredMessage): string {
  const chunks: string[] = []
  // A companion's turn preview shows the typed text, not the context envelope.
  for (const part of stripPromptPreambleFromParts(message.parts)) {
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type === "text" && typeof candidate.text === "string") {
      chunks.push(candidate.text)
    }
  }
  return chunks.join("\n")
}

function collectMedia(message: StoredMessage): TranscriptMediaReference[] {
  const media: TranscriptMediaReference[] = []
  for (const part of message.parts) {
    const candidate = part as {
      type?: unknown
      url?: unknown
      mediaType?: unknown
      filename?: unknown
    }
    if (
      candidate.type === "file" &&
      typeof candidate.url === "string" &&
      candidate.url.startsWith("cognia-media:")
    ) {
      media.push({
        ref: candidate.url,
        ...(typeof candidate.mediaType === "string" ? { mediaType: candidate.mediaType } : {}),
        ...(typeof candidate.filename === "string" ? { filename: candidate.filename } : {}),
      })
    }
  }
  return media
}

function preview(message: StoredMessage): TranscriptMessagePreview {
  const textResult = truncateUtf8(messageText(message), PREVIEW_TEXT_BYTE_LIMIT)
  const allMedia = collectMedia(message)
  const agentKey = assistantAgentKey(message)
  return {
    id: message.id,
    role: message.role,
    ...(textResult.text ? { text: textResult.text } : {}),
    ...(allMedia.length > 0 ? { media: allMedia.slice(0, TRANSCRIPT_SUMMARY_MEDIA_LIMIT) } : {}),
    createdAt: message.createdAt,
    ...(agentKey ? { agentKey } : {}),
    ...(textResult.truncated || allMedia.length > TRANSCRIPT_SUMMARY_MEDIA_LIMIT
      ? { truncated: true }
      : {}),
  }
}

function fullMessage(message: StoredMessage): TranscriptMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    ...(message.turnKey ? { turnKey: message.turnKey } : {}),
    role: message.role,
    parts: message.parts,
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.senderKind ? { senderKind: message.senderKind } : {}),
    ...(message.collaboration ? { collaboration: message.collaboration } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    createdAt: message.createdAt,
  }
}

function branchSummary(
  messages: StoredMessage[],
  activeBranchByGroup: Record<string, string> | undefined
): { groups: TranscriptBranchGroupSummary[] } | undefined {
  const groups = new Map<string, string[]>()
  for (const message of messages) {
    const groupId = message.metadata?.branchGroupId
    if (typeof groupId !== "string") continue
    groups.set(groupId, [...(groups.get(groupId) ?? []), message.id])
  }
  if (groups.size === 0) return undefined
  // The same winner the local list shows: explicit choice, else newest sibling.
  const winners = resolveBranchWinners(messages, activeBranchByGroup ?? {})
  return {
    groups: [...groups.entries()].map(([groupId, messageIds]) => ({
      groupId,
      selectedMessageId: winners.get(groupId)!,
      messageIds,
    })),
  }
}

function fitSummary(item: TranscriptTimelineItem): TranscriptTimelineItem {
  if (item.kind !== "completed-turn" || byteLength(item) <= TRANSCRIPT_SUMMARY_BYTE_LIMIT) {
    return item
  }
  const previews = [...item.userMessages, item.finalResponse, item.visibleResult].filter(
    (value): value is TranscriptMessagePreview => value !== undefined
  )
  let remaining = previews.reduce((sum, value) => sum + (value.text?.length ?? 0), 0)
  while (byteLength(item) > TRANSCRIPT_SUMMARY_BYTE_LIMIT && remaining > 0) {
    const target = previews.reduce((longest, value) =>
      (value.text?.length ?? 0) > (longest.text?.length ?? 0) ? value : longest
    )
    const current = target.text ?? ""
    let nextLength = Math.max(0, Math.floor(current.length * 0.75))
    // The combined-summary budget also clips text; do not leave half an emoji.
    const last = current.charCodeAt(nextLength - 1)
    const next = current.charCodeAt(nextLength)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) nextLength--
    target.text = current.slice(0, nextLength)
    target.truncated = true
    remaining -= current.length - nextLength
  }
  return item
}

/**
 * A completed turn's own version: changes whenever one of its rows is added,
 * rewritten or removed, and only then. Built from each row's id and the
 * Host's durable per-write stamp (`syncRevision`, `lib/db/message-sync-revision.ts`),
 * so a reply streaming into another turn, or a write elsewhere in the session,
 * leaves it alone. That is what lets a client keep a turn's detail across a
 * session revision bump. Compared for equality only; a 53-bit FNV-1a pair.
 */
export function transcriptTurnVersion(rows: readonly StoredMessage[]): number {
  let high = 0x811c9dc5
  let low = 0x01000193 ^ rows.length
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      high = Math.imul(high ^ code, 0x01000193)
      low = Math.imul(low ^ code, 0x01000193 ^ 0x5bd1e995)
    }
  }
  for (const row of rows) {
    const stamp = (row as StoredMessage & { syncRevision?: number }).syncRevision
    mix(`${row.id}\u0000${typeof stamp === "number" ? stamp : ""}\u0001`)
  }
  return (high >>> 0) * 0x200000 + ((low >>> 0) >>> 11)
}

function completedTurn(
  turnKey: string,
  messages: StoredMessage[],
  revision: number,
  activeBranchByGroup: Record<string, string> | undefined
): TranscriptTimelineItem {
  // The folded turn shows the thread the user selected: a regenerated reply
  // or an edited question the selection hides is not its preview.
  const visible = visibleThread(messages, activeBranchByGroup ?? {})
  const userMessages = visible.filter((message) => message.role === "user")
  const finalResponseMessage = visible.filter((message) => message.role === "assistant").at(-1)
  const finalResponseIndex = finalResponseMessage ? messages.indexOf(finalResponseMessage) : -1
  const mediaCount = messages.reduce((sum, message) => sum + collectMedia(message).length, 0)
  const branches = branchSummary(messages, activeBranchByGroup)
  const item: TranscriptTimelineItem = {
    kind: "completed-turn",
    itemKey: turnKey,
    turnKey,
    revision,
    detailRevision: transcriptTurnVersion(messages),
    status: messages.some((message) => message.metadata?.status === "failed")
      ? "failed"
      : "completed",
    userMessages: userMessages.map(preview),
    ...(finalResponseMessage ? { finalResponse: preview(finalResponseMessage) } : {}),
    collapsed: {
      exists:
        messages.length > userMessages.length + (finalResponseMessage ? 1 : 0) ||
        (finalResponseMessage?.parts.some(
          (part) =>
            isToolPartType(part.type) && "state" in part && part.state === "output-available"
        ) ??
          false),
      messageCount: messages.length,
      trailingCount:
        finalResponseIndex >= 0 ? Math.max(0, messages.length - finalResponseIndex - 1) : 0,
      mediaCount,
    },
    ...(branches ? { branchSummary: branches } : {}),
    startedAt: messages[0]?.createdAt ?? 0,
    completedAt: messages.at(-1)?.createdAt,
    durationMs: Math.max(0, (messages.at(-1)?.createdAt ?? 0) - (messages[0]?.createdAt ?? 0)),
  }
  const fitted = fitSummary(item)
  if (fitted.kind === "completed-turn") {
    // A two-message turn still has hidden detail when a preview was clipped.
    // Keep its expansion route available without altering persisted messages.
    fitted.collapsed.exists ||= Boolean(
      fitted.finalResponse?.truncated || fitted.userMessages.some((message) => message.truncated)
    )
  }
  return fitted
}

export function projectTranscriptTimeline(
  options: ProjectTimelineOptions
): TranscriptTimelineItem[] {
  const { messages, revision, activeTurnKey, activeBranchByGroup } = options
  const items: TranscriptTimelineItem[] = []
  let current: { turnKey: string; messages: StoredMessage[] } | null = null

  const flush = () => {
    if (!current) return
    if (current.turnKey === activeTurnKey) {
      const first = current.messages[0]
      items.push({
        kind: "active-turn",
        itemKey: current.turnKey,
        turnKey: current.turnKey,
        revision,
        status: "active",
        messages: current.messages.map(fullMessage),
        startedAt: first?.createdAt ?? 0,
      })
    } else {
      items.push(completedTurn(current.turnKey, current.messages, revision, activeBranchByGroup))
    }
    current = null
  }

  for (const message of messages) {
    if (message.role === "system" && current === null && !message.turnKey) {
      items.push({
        kind: "system",
        itemKey: `system:${message.id}`,
        revision,
        status: "completed",
        message: preview(message),
        startedAt: message.createdAt,
        completedAt: message.createdAt,
        durationMs: 0,
      })
      continue
    }

    const explicitKey = message.turnKey
    const startsNewImplicitTurn = message.role === "user" && current !== null && !explicitKey
    const changesExplicitTurn =
      explicitKey !== undefined && current !== null && explicitKey !== current.turnKey
    if (startsNewImplicitTurn || changesExplicitTurn) flush()

    if (!current) {
      const turnKey = explicitKey ?? `turn:${message.id}`
      current = { turnKey, messages: [] }
    }
    current.messages.push(message)
  }
  flush()
  return items
}

function encodeCursor(value: TimelineCursorPayload | TurnDetailCursorPayload): string {
  const bytes = encoder.encode(JSON.stringify(value))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

function decodeCursor(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function encodeTimelineCursor(
  value: Omit<TimelineCursorPayload, "version" | "kind">
): string {
  return encodeCursor({ version: TRANSCRIPT_PROTOCOL_VERSION, kind: "keyset", ...value })
}

export function encodeTurnDetailCursor(value: Omit<TurnDetailCursorPayload, "version">): string {
  return encodeCursor({ version: TRANSCRIPT_PROTOCOL_VERSION, ...value })
}

export function validateTimelineCursor(
  cursor: string,
  expected: Pick<TimelineCursorPayload, "sessionId" | "direction">
): CursorValidation<TimelineCursorPayload> {
  try {
    const value = decodeCursor(cursor) as Partial<TimelineCursorPayload> & { position?: unknown }
    if (value.version !== TRANSCRIPT_PROTOCOL_VERSION || typeof value.sessionId !== "string") {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    // A position cursor from before keyset paging: the client re-reads from
    // the newest page instead of failing.
    if (value.kind === undefined && typeof value.position === "number") {
      return { ok: false, code: "TRANSCRIPT_STALE" }
    }
    const before = value.before
    if (
      value.kind !== "keyset" ||
      (value.direction !== "backward" && value.direction !== "forward") ||
      !before ||
      typeof before.id !== "string" ||
      before.id.length === 0 ||
      !Number.isSafeInteger(before.createdAt) ||
      before.createdAt < 0
    ) {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    if (value.sessionId !== expected.sessionId || value.direction !== expected.direction) {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    return { ok: true, value: value as TimelineCursorPayload }
  } catch {
    return { ok: false, code: "INVALID_PARAMS" }
  }
}

export function validateTurnDetailCursor(
  cursor: string,
  expected: Pick<TurnDetailCursorPayload, "sessionId" | "turnKey" | "detailRevision">
): CursorValidation<TurnDetailCursorPayload> {
  try {
    const value = decodeCursor(cursor) as Partial<TurnDetailCursorPayload>
    if (
      value.version !== TRANSCRIPT_PROTOCOL_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.turnKey !== "string" ||
      typeof value.detailRevision !== "number" ||
      typeof value.position !== "number" ||
      value.position < 0
    ) {
      return { ok: false, code: "INVALID_PARAMS" }
    }
    if (value.sessionId !== expected.sessionId) return { ok: false, code: "INVALID_PARAMS" }
    if (value.turnKey !== expected.turnKey) return { ok: false, code: "TURN_NOT_FOUND" }
    if (value.detailRevision !== expected.detailRevision) {
      return { ok: false, code: "TRANSCRIPT_STALE" }
    }
    return { ok: true, value: value as TurnDetailCursorPayload }
  } catch {
    return { ok: false, code: "INVALID_PARAMS" }
  }
}
