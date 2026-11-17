/**
 * Plain-text projection for Inbox search and for text handed to a model.
 *
 * Each part's text comes from its descriptor (`lib/chat/parts/descriptors.ts`),
 * so the Inbox reads A2UI surfaces through their plain-text mirror, Markdown
 * and code segments, and image segments (kept as `[image]` so the search
 * needle still hits a conversation whose only inbound was a screenshot) the
 * same way every other consumer does.
 *
 * The preview is concatenated, whitespace-collapsed and trimmed; callers cap
 * the length (default 240 chars in ConversationList).
 */

import { partPlainText, type PlainTextPurpose } from "@/lib/chat/parts/descriptors"

function projectParts(parts: unknown, purpose: PlainTextPurpose): string[] {
  if (!Array.isArray(parts)) return []
  return parts.map((part) => partPlainText(part, purpose)).filter(Boolean)
}

/** Inbox/search projection: collapse whitespace and trim; callers apply the length cap. */
export function extractPlainText(parts: unknown): string {
  return projectParts(parts, "preview").join(" ").replace(/\s+/g, " ").trim()
}

/** Model context preserves layout, omits reasoning, and names files without their payloads. */
export function extractContextText(parts: unknown): string {
  return projectParts(parts, "model-context").join("\n").replace(/\r\n/g, "\n").trimEnd()
}
