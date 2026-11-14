import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { contentFingerprint } from "@/lib/chat/mentions/content-fingerprint"
import { readAttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { videoAttachmentInfoOfPart } from "@/lib/chat/attachments/video/attachment-info"
import { extractContextText } from "@/lib/inbox/extract-plain-text"
import { normalizeToolName, summarizeToolCall, type ToolPartLike } from "@/lib/chat/tool-summary"
import {
  coerceResultText,
  describeToolResult,
  resultErrorPreview,
} from "@/lib/chat/tool-result-summary"

/**
 * How much of the main conversation a sidechat is told about.
 *
 * The aside exists so the user can check something adjacent without spending
 * turns in the main thread — it needs enough context to answer "this thing we
 * were just discussing", not the whole history. Feeding it everything would
 * make each aside turn cost as much as a main one, which defeats the point.
 *
 * The window counts messages that have something to say. It used to count raw
 * rows, so a run of tool-only assistant rows (a read, a grep, a test run) used
 * up the window while contributing nothing — and those rows are exactly where
 * the main thread learned its facts.
 */
export const ASIDE_CONTEXT_MAX_MESSAGES = 24

/**
 * Character budget for the rendered transcript. A rough proxy for tokens (~4
 * chars each), deliberately conservative: this rides on EVERY aside send.
 */
export const ASIDE_CONTEXT_MAX_CHARS = 8000

/** Explicit parent pins have an independent 6,000-character transcript budget. */
export const ASIDE_PINNED_CONTEXT_MAX_CHARS = 6000
export const ASIDE_PINNED_HEADER = "Messages the user pinned from the main conversation"

/** How much of one tool result is quoted. Enough for the fact, not the dump. */
export const ASIDE_TOOL_RESULT_EXCERPT_CHARS = 280

/** Tool facts quoted per message; a burst of fifty reads is summarized by its tail. */
export const ASIDE_TOOL_FACTS_PER_MESSAGE = 8

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
}

function isToolPart(part: unknown): part is ToolPartLike {
  if (!part || typeof part !== "object") return false
  const type = (part as { type?: unknown }).type
  return typeof type === "string" && (type === "dynamic-tool" || type.startsWith("tool-"))
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One tool call as a fact line: what was called on what, and what came back —
 * an excerpt of the output, the size of a diff, or the error. English, like all
 * model-facing scaffolding.
 */
export function asideToolFact(part: ToolPartLike): string {
  const summary = summarizeToolCall(part)
  const name = summary.name || normalizeToolName(part)
  const head = summary.target ? `${name} ${clip(summary.target, 120)}` : name
  if (part.state === "output-error") {
    const errorText = (part as { errorText?: unknown }).errorText
    const preview = resultErrorPreview(errorText ?? (part as { output?: unknown }).output, 200)
    return `[tool ${head} failed${preview ? `: ${preview}` : ""}]`
  }
  if (part.state !== "output-available") return `[tool ${head}: no result yet]`
  const descriptor = describeToolResult(part)
  if (descriptor?.kind === "diff") {
    return `[tool ${head}: +${descriptor.added} −${descriptor.removed} lines]`
  }
  const output = clip(
    coerceResultText((part as { output?: unknown }).output),
    ASIDE_TOOL_RESULT_EXCERPT_CHARS
  )
  return output ? `[tool ${head} → ${output}]` : `[tool ${head}: done]`
}

/** One message as the aside reads it, or "" when it has nothing to contribute. */
export function renderAsideMessage(message: UIMessage): string {
  const text = extractContextText(message.parts)
  const facts = message.parts.filter(isToolPart).map(asideToolFact)
  const keptFacts = facts.slice(-ASIDE_TOOL_FACTS_PER_MESSAGE)
  const lines = [
    ...(facts.length > keptFacts.length
      ? [`[${facts.length - keptFacts.length} earlier tool calls omitted]`]
      : []),
    ...keptFacts,
    ...(text ? [text] : []),
  ]
  if (lines.length === 0) return ""
  return `${ROLE_LABEL[message.role] ?? message.role}: ${lines.join("\n")}`
}

/**
 * Render the tail of a conversation as plain-text context for its sidechat.
 *
 * `messages` should be what the user sees — the visible branch, not every
 * sibling an edit or regenerate left behind (`selectVisibleMessages`).
 *
 * Trims from the OLDEST end on both limits, so the most recent exchange — the
 * one the user is most likely asking about — always survives. Returns an empty
 * string for a conversation with nothing quotable, which the caller passes
 * through as "no context" rather than an empty header.
 */
export function buildAsideContext(
  messages: readonly UIMessage[],
  opts: { maxMessages?: number; maxChars?: number } = {}
): string {
  return summarizeAsideInheritance(messages, opts).context
}

/** Track delivered rows directly: clipping must not hide a row from cursor acknowledgement. */
function renderAsideContext(
  messages: readonly UIMessage[],
  opts: { maxMessages?: number; maxChars?: number } = {}
): { context: string; included: readonly UIMessage[]; truncated?: string } {
  const maxMessages = opts.maxMessages ?? ASIDE_CONTEXT_MAX_MESSAGES
  const maxChars = opts.maxChars ?? ASIDE_CONTEXT_MAX_CHARS
  if (messages.length === 0 || maxMessages <= 0 || maxChars <= 0)
    return { context: "", included: [] }

  const quotable = messages
    .map((message) => ({ message, text: renderAsideMessage(message) }))
    .filter((block) => block.text.length > 0)
  let blocks = quotable.slice(-maxMessages)
  if (blocks.length === 0) return { context: "", included: [] }
  const omission = () => {
    const dropped = quotable.length - blocks.length
    if (!dropped) return ""
    const marker = `[${dropped} earlier messages not included]\n`
    // Tiny caller budgets still need room for the most recent speaker label.
    const labelLength = blocks[0].text.indexOf(": ") + 2
    return marker.length + labelLength + 1 <= maxChars ? marker : `[${dropped} omitted]\n`
  }
  let rendered = blocks.map((block) => block.text).join("\n\n")
  // Drop whole messages rather than cutting one mid-sentence: a half message
  // reads as though the speaker was interrupted, which the model then imitates.
  while (omission().length + rendered.length > maxChars && blocks.length > 1) {
    blocks = blocks.slice(1)
    rendered = blocks.map((block) => block.text).join("\n\n")
  }
  // A single message over budget is still better truncated than dropped — it is
  // the most recent thing said.
  const prefix = omission()
  const budget = maxChars - prefix.length
  let truncated: string | undefined
  if (rendered.length > budget) {
    const labelEnd = rendered.indexOf(": ") + 2
    if (budget < labelEnd + 1) return { context: "", included: [] }
    const tailLength = budget - labelEnd - 1
    rendered = `${rendered.slice(0, labelEnd)}…${tailLength ? rendered.slice(-tailLength) : ""}`
    truncated = blocks[0].message.id
  }
  return { context: prefix + rendered, included: blocks.map((block) => block.message), truncated }
}

export const ASIDE_REFERENCE_HEADER = "Main conversation — reference only"
export const ASIDE_DELTA_HEADER = "Main conversation — new since your last turn"

export interface AsideInheritanceOptions {
  maxMessages?: number
  maxChars?: number
  pins?: readonly string[]
  cursor?: ChatSession["asideContextCursor"]
  resumeSdkSessionId?: string
  inProgressMessageId?: string
  parentClearedAt?: number
}

/** Count source attachments once even when OCR/video processing produced several parts. */
function parentMessageAttachments(message: UIMessage) {
  const seen = new Set<string>()
  return message.parts.flatMap((part, partIndex) => {
    if (part.type !== "file") return []
    const extraction = readAttachmentExtractedContent(
      (part as { extractedContent?: unknown }).extractedContent
    )
    const video = videoAttachmentInfoOfPart(part)
    const key = extraction?.attachmentId ?? video?.groupId ?? `part:${partIndex}`
    if (seen.has(key)) return []
    seen.add(key)
    return [
      {
        messageId: message.id,
        partIndex,
        filename: video?.filename ?? part.filename ?? "attachment",
        mediaType: video?.sourceMediaType ?? part.mediaType,
      },
    ]
  })
}

/** The single selection plan used by both the picker and provider context builder. */
export function summarizeAsideInheritance(
  messages: readonly UIMessage[],
  options: AsideInheritanceOptions = {}
) {
  const { cursor, resumeSdkSessionId } = options
  const byId = new Map(messages.map((message) => [message.id, message]))
  const validPins = [...new Set(options.pins ?? [])].filter((id) => byId.has(id))
  const pinIds = new Set(validPins)
  const cursorIndex = cursor
    ? messages.findIndex((message) => message.id === cursor.parentMessageId)
    : -1
  const incremental = Boolean(
    cursor &&
    resumeSdkSessionId === cursor.sdkSessionId &&
    (cursorIndex >= 0 || cursor.parentMessageId === null) &&
    contentFingerprint(buildAsideContext(messages.slice(0, cursorIndex + 1))) ===
      cursor.tailFingerprint &&
    validPins.every(
      (id) =>
        !cursor.pinnedParentMessageFingerprints?.[id] ||
        cursor.pinnedParentMessageFingerprints[id] ===
          contentFingerprint(renderAsideMessage(byId.get(id)!))
    )
  )
  const selected = incremental ? messages.slice(cursorIndex + 1) : messages
  const recent = renderAsideContext(
    selected.filter((message) => !pinIds.has(message.id)),
    options
  )
  const pinned = renderAsideContext(
    messages.filter(
      (message) =>
        pinIds.has(message.id) &&
        (!incremental || !cursor?.pinnedParentMessageFingerprints?.[message.id])
    ),
    {
      maxMessages: Number.MAX_SAFE_INTEGER,
      maxChars: ASIDE_PINNED_CONTEXT_MAX_CHARS,
    }
  )
  const included = new Set([...recent.included, ...pinned.included].map((message) => message.id))
  return {
    context: [pinned.context ? `[${ASIDE_PINNED_HEADER}]\n${pinned.context}` : "", recent.context]
      .filter(Boolean)
      .join("\n\n"),
    included: messages.filter((message) => included.has(message.id)).map((message) => message.id),
    recentIncluded: recent.included.map((message) => message.id),
    pinnedIncluded: pinned.included.map((message) => message.id),
    omitted: messages
      .filter(
        (message) =>
          !included.has(message.id) &&
          renderAsideMessage(message) &&
          (!incremental ||
            selected.includes(message) ||
            (pinIds.has(message.id) && !cursor?.pinnedParentMessageFingerprints?.[message.id]))
      )
      .map((message) => message.id),
    truncated: [pinned.truncated, recent.truncated].filter((id): id is string => !!id),
    attachments: messages.flatMap(parentMessageAttachments),
    validPins,
    incremental,
  }
}

export interface AsideContextDelivery {
  context: string
  header: string
  /** Bound to the actual SDK id only after dispatch succeeds. */
  cursor?: Omit<NonNullable<ChatSession["asideContextCursor"]>, "sdkSessionId">
}

/** Resolve against a send-time snapshot; never subscribe to parent streaming tokens. */
export function prepareAsideContext(
  messages: readonly UIMessage[],
  options: AsideInheritanceOptions = {}
): AsideContextDelivery {
  const { cursor, inProgressMessageId, parentClearedAt } = options
  const needsEmptySnapshot = Boolean(cursor || parentClearedAt !== undefined)
  const delivery = summarizeAsideInheritance(messages, options)
  const { incremental } = delivery
  const cursorIndex = cursor
    ? messages.findIndex((message) => message.id === cursor.parentMessageId)
    : -1
  const selected = incremental ? messages.slice(cursorIndex + 1) : messages
  const rendered = delivery.context
  const progress = messages.find(
    (message) => message.id === inProgressMessageId && delivery.included.includes(message.id)
  )
  const context = rendered
    ? `${rendered}${progress ? "\n[Last assistant message is still in progress.]" : ""}`
    : !incremental && needsEmptySnapshot
      ? "[The main conversation currently has no visible messages.]"
      : ""
  // Only completed, quotable content can be acknowledged. If the streaming
  // tail consumes the entire budget, none of the earlier messages was sent.
  const progressIndex = selected.findIndex((message) => message.id === inProgressMessageId)
  // A live steer can append a user row after the assistant still being updated.
  // Nothing after that assistant is acknowledged until its final form is sent.
  const completed = progressIndex < 0 ? selected : selected.slice(0, progressIndex)
  const lastCompleted = [...completed]
    .reverse()
    .find((message) => message.id !== inProgressMessageId && delivery.included.includes(message.id))
  const lastIndex = lastCompleted ? messages.findIndex((m) => m.id === lastCompleted.id) : -1
  const pinFingerprints = Object.fromEntries(
    delivery.validPins.flatMap((id) => {
      const message = messages.find((row) => row.id === id)!
      const parentProgressIndex = messages.findIndex((row) => row.id === inProgressMessageId)
      const beforeProgress =
        parentProgressIndex < 0 || messages.findIndex((row) => row.id === id) < parentProgressIndex
      const fingerprint =
        delivery.pinnedIncluded.includes(id) && beforeProgress
          ? contentFingerprint(renderAsideMessage(message))
          : incremental
            ? cursor?.pinnedParentMessageFingerprints?.[id]
            : undefined
      return fingerprint ? [[id, fingerprint]] : []
    })
  )
  const pinCursor = Object.keys(pinFingerprints).length
    ? { pinnedParentMessageFingerprints: pinFingerprints }
    : {}
  return {
    context,
    header: incremental ? ASIDE_DELTA_HEADER : ASIDE_REFERENCE_HEADER,
    ...(lastCompleted
      ? {
          cursor: {
            ...pinCursor,
            parentMessageId: lastCompleted.id,
            tailFingerprint: contentFingerprint(
              buildAsideContext(messages.slice(0, lastIndex + 1))
            ),
          },
        }
      : incremental && delivery.pinnedIncluded.length && cursor
        ? {
            cursor: {
              parentMessageId: cursor.parentMessageId,
              tailFingerprint: cursor.tailFingerprint,
              ...pinCursor,
            },
          }
        : !incremental && messages.length === 0 && needsEmptySnapshot
          ? { cursor: { parentMessageId: null, tailFingerprint: contentFingerprint("") } }
          : {}),
  }
}
