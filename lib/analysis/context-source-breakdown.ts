/**
 * Estimate how the *visible transcript* divides across injection sources, for
 * the context hover card's "context by source" panel. This is the estimate-path
 * companion to the SDK-authoritative `SdkBreakdown` (which reports the true
 * system-prompt / tools / memory occupancy): when the live SDK usage isn't
 * available we can still break the conversation itself down by what produced
 * each chunk.
 *
 * Token figures are char/4 estimates (the same rough heuristic the composer
 * uses when the SDK reports nothing) — directional, not billing-accurate. Pure.
 */

import type { UIMessage } from "ai"

export type ContextSourceId =
  | "userMessages"
  | "assistantMessages"
  | "mentionedFiles"
  | "toolOutputs"
  | "thinking"
  | "taskCoordination"

/** Tools that are team/task coordination rather than real work. */
const COORDINATION_TOOLS = new Set(["SendMessage", "TaskCreate", "TaskUpdate", "TeamCreate"])

export interface ContextSourceRow {
  id: ContextSourceId
  tokens: number
}

export interface ContextSourceBreakdown {
  rows: ContextSourceRow[]
  totalTokens: number
}

type AnyPart = {
  type?: string
  text?: string
  /** Set on `dynamic-tool` parts, whose `type` does not carry the name. */
  toolName?: string
  input?: unknown
  /** A tool's result: a string, or any structured value it returned. */
  output?: unknown
  errorText?: string
}

/** Rough token estimate from a character count (≈ 4 chars / token). */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function partsOf(message: UIMessage): AnyPart[] {
  return (message.parts ?? []) as unknown as AnyPart[]
}

/** The tool a part records: a static `tool-<name>` part or a `dynamic-tool` part. */
function toolNameOf(part: AnyPart): string | null {
  if (part.type === "dynamic-tool") return typeof part.toolName === "string" ? part.toolName : ""
  if (!part.type || !part.type.startsWith("tool-")) return null
  return part.type.slice("tool-".length)
}

/**
 * Characters one media block stands for: one image's ≈1,600 tokens. Providers
 * bill an image by its pixels, not by its base64, and counting the base64 put
 * a screenshot at hundreds of thousands of "tokens".
 */
const MEDIA_BLOCK_CHARS = 1_600 * 4

/**
 * A block a tool result hands the model as media rather than as text: an MCP
 * image, audio or blob resource block, or an AI SDK image or file part. A
 * base64 string anywhere else (a JSON field) does reach the model as text.
 */
function isMediaBlock(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case "image":
      return typeof value.data === "string" || value.image != null
    case "audio":
      return typeof value.data === "string"
    case "file":
      return value.data != null
    case "resource": {
      const resource = value.resource as Record<string, unknown> | null | undefined
      return typeof resource?.blob === "string"
    }
    default:
      return false
  }
}

/**
 * Characters a value occupies as the model receives it: strings as-is, the
 * rest as JSON, each media block it holds at {@link MEDIA_BLOCK_CHARS}.
 */
function serializedChars(value: unknown): number {
  if (value == null) return 0
  if (typeof value === "string") return value.length
  let mediaBlocks = 0
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (item && typeof item === "object" && isMediaBlock(item as Record<string, unknown>)) {
        mediaBlocks++
        return null
      }
      return item
    })
    return (json?.length ?? 0) + mediaBlocks * MEDIA_BLOCK_CHARS
  } catch {
    return 0
  }
}

/**
 * Break the transcript into per-source token estimates. `claude-md` /
 * system-prompt is intentionally absent — it isn't visible from the message
 * log (the SDK breakdown covers it on the authoritative path).
 */
export function buildContextSourceBreakdown(messages: UIMessage[]): ContextSourceBreakdown {
  let userMessages = 0
  let assistantMessages = 0
  let mentionedFiles = 0
  let toolOutputs = 0
  let thinking = 0
  let taskCoordination = 0

  for (const message of messages) {
    for (const part of partsOf(message)) {
      if (part.type === "text" && typeof part.text === "string") {
        if (message.role === "user") {
          userMessages += part.text.length
          // @-mentioned paths inflate context with file contents the SDK injects;
          // approximate their weight from the mention tokens in the message.
          for (const m of part.text.match(/@\S+/g) ?? []) mentionedFiles += m.length
        } else if (message.role === "assistant") {
          // The model's own replies are resent every turn like any other history.
          assistantMessages += part.text.length
        }
        continue
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        thinking += part.text.length
        continue
      }
      const tool = toolNameOf(part)
      if (!tool) continue
      const inputChars = serializedChars(part.input)
      const outputChars = serializedChars(part.output) + serializedChars(part.errorText)
      if (COORDINATION_TOOLS.has(tool)) {
        taskCoordination += inputChars + outputChars
      } else {
        toolOutputs += inputChars + outputChars
      }
    }
  }

  const raw: Record<ContextSourceId, number> = {
    userMessages: estTokens(userMessages),
    assistantMessages: estTokens(assistantMessages),
    mentionedFiles: estTokens(mentionedFiles),
    toolOutputs: estTokens(toolOutputs),
    thinking: estTokens(thinking),
    taskCoordination: estTokens(taskCoordination),
  }

  const rows = (Object.keys(raw) as ContextSourceId[])
    .map((id) => ({ id, tokens: raw[id] }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)

  return { rows, totalTokens: rows.reduce((acc, r) => acc + r.tokens, 0) }
}
