// Per-tool-result capping applied during compaction (generic path).
//
// Implements `CompressionSettings.maxToolResultTokens` + `preserveToolCallMetadata`
// (types/system/compression.ts). Large tool outputs (bash/grep/read) that survive
// verbatim in the kept slices bloat the post-compaction window; this caps each
// tool-result body to ~`maxToolResultTokens` tokens (≈4 chars/token), keeping the
// tool name/status header when `preserveToolCallMetadata` is on.
//
// The rail keeps tool results as AI SDK `tool-result` parts in `role:"tool"`
// messages, with a typed `output` (what `builtinToModelOutput` and the AI SDK
// produce): `text` / `error-text` carry a string, `json` / `error-json` a
// value, `content` a list of text and media parts. A cap that only read
// string bodies let every one of these through untouched. Media parts are not
// text and are never cut. A cut keeps the recoverable-output reference the body
// states on its first line (a bash spill path), the way back to the rest.

import { headTruncate } from "../shared/text/truncate.ts"
import { keepRecoverableRefs } from "../shared/text/recoverable-ref.ts"
import type { ConversationMessage } from "./compaction.ts"

type Part = Record<string, unknown>

const APPROX_CHARS_PER_TOKEN = 4
const MARKER = "\n... (tool result truncated)"

/** Cap a string body; prepend a metadata header only when it was truncated. */
function capText(
  text: string,
  maxChars: number,
  header: string
): { text: string; truncated: boolean } {
  const { text: capped, truncated } = headTruncate(text, maxChars, { marker: MARKER })
  if (!truncated) return { text, truncated: false }
  const kept = keepRecoverableRefs(text, capped)
  return { text: header ? `${header}\n${kept}` : kept, truncated: true }
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

/** A typed tool output capped to `maxChars`, or the same object when it fits. */
function capOutput(output: unknown, maxChars: number, header: (isError: boolean) => string) {
  if (!output || typeof output !== "object") return output
  const typed = output as { type?: unknown; value?: unknown }
  switch (typed.type) {
    case "text":
    case "error-text": {
      if (typeof typed.value !== "string") return output
      const { text, truncated } = capText(
        typed.value,
        maxChars,
        header(typed.type === "error-text")
      )
      return truncated ? { ...typed, value: text } : output
    }
    case "json":
    case "error-json": {
      // A cut JSON value is no longer JSON; it becomes the matching text output.
      const isError = typed.type === "error-json"
      const { text, truncated } = capText(serialize(typed.value), maxChars, header(isError))
      return truncated ? { type: isError ? "error-text" : "text", value: text } : output
    }
    case "content": {
      if (!Array.isArray(typed.value)) return output
      let changed = false
      const value = (typed.value as (Part | null | undefined)[]).map((item) => {
        if (item?.type !== "text" || typeof item.text !== "string") return item
        const { text, truncated } = capText(item.text, maxChars, header(false))
        if (!truncated) return item
        changed = true
        return { ...item, text }
      })
      return changed ? { ...typed, value } : output
    }
    default:
      return output
  }
}

/** Cap one message's tool-result bodies, returning the same ref when unchanged. */
function capMessage<M extends ConversationMessage | null | undefined>(
  message: M,
  maxChars: number,
  preserveMeta: boolean
): M {
  if (!message || message.role !== "tool" || !Array.isArray(message.content)) return message
  let changed = false
  const content = (message.content as unknown[]).map((item) => {
    const part = item as Part | null | undefined
    if (part?.type !== "tool-result") return item
    const name = typeof part.toolName === "string" && part.toolName ? part.toolName : "tool"
    const header = (isError: boolean) =>
      preserveMeta ? `[tool: ${name} | status: ${isError ? "error" : "ok"}]` : ""
    const output = capOutput(part.output, maxChars, header)
    if (output === part.output) return item
    changed = true
    return { ...part, output }
  })
  return changed ? { ...message, content } : message
}

/**
 * Cap every tool-result body in the conversation. No-op when
 * `maxToolResultTokens` is unset / non-positive. Non-tool messages are untouched.
 */
export function capToolResults<M extends ConversationMessage | null | undefined>(
  conversation: readonly M[],
  {
    maxToolResultTokens,
    preserveToolCallMetadata = true,
  }: { maxToolResultTokens?: unknown; preserveToolCallMetadata?: boolean } = {}
): readonly M[] {
  if (typeof maxToolResultTokens !== "number" || maxToolResultTokens <= 0) return conversation
  const maxChars = maxToolResultTokens * APPROX_CHARS_PER_TOKEN
  return conversation.map((m) => capMessage(m, maxChars, preserveToolCallMetadata))
}
