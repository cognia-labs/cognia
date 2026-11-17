/**
 * Drawing a member agent's live reply beside the Host's timeline (P6e).
 *
 * The brain persists the reply about once a second while the live frames
 * (`live-frames.ts`) arrive every tenth of a second, so a timeline read during
 * the turn already holds an older copy of the same reply. The live reply wins
 * for that turn: the timeline keeps the turn's user side and drops its reply
 * previews, and the live tail draws the reply. A turn the timeline has not
 * read yet is drawn whole from the chat store's tail plus the live reply.
 */

import type { UIMessage } from "ai"
import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

import type { TranscriptLiveTurn } from "./live-frames"

/** Whether a timeline item is the turn that answers `userMessageId`. */
function isTurnOf(item: TranscriptTimelineItem, userMessageId: string): boolean {
  if (item.kind === "system") return false
  if (item.turnKey === `turn:${userMessageId}`) return true
  return item.kind === "completed-turn"
    ? item.userMessages.some((message) => message.id === userMessageId)
    : item.messages.some((message) => message.id === userMessageId)
}

function withoutReply(item: TranscriptTimelineItem, replyId: string): TranscriptTimelineItem {
  if (item.kind === "completed-turn") {
    const { finalResponse, visibleResult, ...rest } = item
    return {
      ...rest,
      ...(finalResponse && finalResponse.id !== replyId ? { finalResponse } : {}),
      ...(visibleResult && visibleResult.id !== replyId ? { visibleResult } : {}),
      // Its detail holds the same reply, older: not while it is drawn live.
      collapsed: { ...item.collapsed, exists: false },
    }
  }
  if (item.kind === "active-turn") {
    return { ...item, messages: item.messages.filter((message) => message.id !== replyId) }
  }
  return item
}

/**
 * The timeline without what the store's unfinished tail draws. A timeline read
 * during the turn already holds the rows the Host persisted so far (the
 * question, a partial reply) as a folded turn; drawn beside the tail, the turn
 * appeared twice. The tail is the newer copy, so the timeline gives up those
 * messages, and the turn itself once nothing else of it is left.
 */
function withoutTail(items: TranscriptTimelineItem[], tail: UIMessage[]): TranscriptTimelineItem[] {
  if (tail.length === 0) return items
  const drawn = new Set(tail.map((message) => message.id))
  let changed = false
  const kept: TranscriptTimelineItem[] = []
  for (const item of items) {
    const next = withoutMessages(item, drawn)
    if (next !== item) changed = true
    if (next) kept.push(next)
  }
  return changed ? kept : items
}

/** `item` minus the messages in `ids`; `null` when none of it remains. */
function withoutMessages(
  item: TranscriptTimelineItem,
  ids: ReadonlySet<string>
): TranscriptTimelineItem | null {
  if (item.kind === "system") return ids.has(item.message.id) ? null : item
  if (item.kind === "active-turn") {
    if (!item.messages.some((message) => ids.has(message.id))) return item
    const messages = item.messages.filter((message) => !ids.has(message.id))
    return messages.length > 0 ? { ...item, messages } : null
  }
  const covered =
    item.userMessages.some((message) => ids.has(message.id)) ||
    (item.finalResponse !== undefined && ids.has(item.finalResponse.id)) ||
    (item.visibleResult !== undefined && ids.has(item.visibleResult.id))
  if (!covered) return item
  const { finalResponse, visibleResult, ...rest } = item
  const userMessages = item.userMessages.filter((message) => !ids.has(message.id))
  const keepFinal = finalResponse && !ids.has(finalResponse.id) ? finalResponse : undefined
  const keepResult = visibleResult && !ids.has(visibleResult.id) ? visibleResult : undefined
  if (userMessages.length === 0 && !keepFinal && !keepResult) return null
  return {
    ...rest,
    userMessages,
    ...(keepFinal ? { finalResponse: keepFinal } : {}),
    ...(keepResult ? { visibleResult: keepResult } : {}),
    // Its detail holds the same rows, older: not while the tail draws them.
    collapsed: { ...item.collapsed, exists: false },
  }
}

export interface LiveTurnView {
  items: TranscriptTimelineItem[]
  liveMessages: UIMessage[]
}

/**
 * The timeline and live tail to draw. `tail` is the chat store's unfinished
 * tail (`selectActiveTurnMessages`); `live` is the reply to draw, or `null`.
 */
export function withLiveTurn(input: {
  items: TranscriptTimelineItem[]
  tail: UIMessage[]
  live: TranscriptLiveTurn | null
}): LiveTurnView {
  const { items, tail, live } = input
  if (!live) return { items: withoutTail(items, tail), liveMessages: tail }
  const reply: UIMessage = { id: live.messageId, role: "assistant", parts: live.parts }
  const turn = items.findIndex((item) => isTurnOf(item, live.replyTo))
  if (turn >= 0) {
    return {
      items: items.map((item, index) =>
        index === turn ? withoutReply(item, live.messageId) : item
      ),
      liveMessages: [reply],
    }
  }
  return { items, liveMessages: withLiveReply(tail, live) }
}

/**
 * A message list with a live reply drawn in: in place of its stored copy
 * (whose other fields stay), or after the rest when nothing is stored yet.
 * Shared by the timeline's live tail above and a shared run's members, who
 * draw a flat list (ADR-0241).
 */
export function withLiveReply(messages: UIMessage[], live: TranscriptLiveTurn | null): UIMessage[] {
  if (!live) return messages
  const reply: UIMessage = { id: live.messageId, role: "assistant", parts: live.parts }
  return messages.some((message) => message.id === live.messageId)
    ? messages.map((message) =>
        message.id === live.messageId ? { ...message, ...reply } : message
      )
    : [...messages, reply]
}

/**
 * Whether a settled reply has been replaced by the timeline: the timeline has
 * read past the revision the brain had persisted before its final frame.
 * Without that revision, any timeline read after the settle counts.
 */
export function settledReplyCaughtUp(
  live: TranscriptLiveTurn,
  timelineRevision: number | null,
  revisionAtSettle: number | null
): boolean {
  if (live.state !== "settled" || timelineRevision === null) return false
  if (live.afterRevision !== undefined) return timelineRevision > live.afterRevision
  return revisionAtSettle !== null && timelineRevision !== revisionAtSettle
}

function textOf(message: UIMessage): string {
  return message.parts
    .flatMap((part) =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : []
    )
    .join("\n")
}

/**
 * The question a regenerate sends again: the last user message the view
 * draws, by id and the words it shows. The live tail is newer than the
 * timeline. `null` when the conversation has no question yet.
 */
export function lastUserMessageOf(view: LiveTurnView): { id: string; text: string } | null {
  for (let index = view.liveMessages.length - 1; index >= 0; index -= 1) {
    const message = view.liveMessages[index]
    if (message.role === "user") return { id: message.id, text: textOf(message) }
  }
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const item = view.items[index]
    if (item.kind === "completed-turn") {
      const question = item.userMessages.at(-1)
      if (question) return { id: question.id, text: question.text ?? "" }
    } else if (item.kind === "active-turn") {
      const question = item.messages.findLast((message) => message.role === "user")
      if (question) return { id: question.id, text: textOf(question as unknown as UIMessage) }
    }
  }
  return null
}
