import type { AiStreamEvent, EventBlock } from "./events-types.ts"
import { hasRichContentBlock } from "../../tools/adapters/ai-sdk-output.ts"

/**
 * Shape a tool-result payload for the renderer's `tool_result` content block.
 *
 * Rich MCP results keep their content array for the renderer's image, audio
 * and resource extractors. Text-only results retain their existing encoding.
 *
 */
export function shapeToolResultContent(payload: unknown) {
  if (hasRichContentBlock(payload)) {
    return (payload as { content: unknown[] }).content
  }
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload)
  } catch {
    // Circular tool output must not abort the dispatcher's stream loop.
    return String(payload)
  }
}

/**
 * Map an AI SDK `finishReason` to an Anthropic-style `stop_reason`.
 *
 * Only the two reasons that ACP surfaces distinctly are mapped: `length` →
 * `max_tokens` (the model hit its output cap) and `content-filter` → `refusal`
 * (the provider blocked the completion). Every other reason (`stop`,
 * `tool-calls`, `error`, `other`, `unknown`, missing) returns `null`, which
 * downstream consumers treat as a plain `end_turn`.
 *
 */
export function finishReasonToStopReason(finishReason: unknown) {
  switch (finishReason) {
    case "length":
      return "max_tokens"
    case "content-filter":
      return "refusal"
    default:
      return null
  }
}

export function isMergeableMetadataObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp)
  )
}

export function mergeMessageMetadata(base: unknown, overrides: unknown): unknown {
  if (overrides == null) return base
  if (!isMergeableMetadataObject(base) || !isMergeableMetadataObject(overrides)) return overrides

  const result = { ...base }
  for (const key of Object.keys(overrides)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue

    const overrideValue = overrides[key]
    if (overrideValue === undefined) continue

    const baseValue = base[key]
    result[key] =
      isMergeableMetadataObject(baseValue) && isMergeableMetadataObject(overrideValue)
        ? mergeMessageMetadata(baseValue, overrideValue)
        : overrideValue
  }
  return result
}

/**
 * Convert an AI SDK source stream part into an Anthropic-shaped citation.
 * Handles v6 `source-url`/`source-document` and the older
 * `source` + `sourceType` form. Returns null when there's nothing citable.
 */
export function sourceToCitation(event: AiStreamEvent) {
  const isUrl =
    event.type === "source-url" || (event.type === "source" && event.sourceType === "url")
  const isDoc =
    event.type === "source-document" || (event.type === "source" && event.sourceType === "document")
  const title =
    typeof event.title === "string" && event.title
      ? event.title
      : typeof event.filename === "string" && event.filename
        ? event.filename
        : undefined
  if (isUrl || (!isDoc && typeof event.url === "string")) {
    const url = typeof event.url === "string" ? event.url : undefined
    if (!url && !title) return null
    return { type: "url_citation", url, title: title ?? url }
  }
  if (isDoc) {
    if (!title) return null
    return { type: "document", document_title: title, title }
  }
  return null
}

export function generatedFileToBlock(event: AiStreamEvent) {
  const file = event?.file && typeof event.file === "object" ? event.file : null
  const hostedUrl = typeof event?.url === "string" && event.url ? event.url : undefined
  const hostedMediaType =
    typeof event?.mediaType === "string" && event.mediaType ? event.mediaType : undefined
  if (hostedUrl && hostedMediaType) {
    return { type: "file", url: hostedUrl, media_type: hostedMediaType }
  }
  const base64 =
    file && typeof file.base64 === "string"
      ? file.base64
      : typeof event?.data === "string"
        ? event.data
        : undefined
  const mediaType =
    file && typeof file.mediaType === "string"
      ? file.mediaType
      : typeof event?.mediaType === "string"
        ? event.mediaType
        : undefined
  if (!base64 || !mediaType) return null
  const block: EventBlock = {
    type: "file",
    source: { type: "base64", media_type: mediaType, data: base64 },
  }
  if (typeof event.filename === "string" && event.filename) {
    block.filename = event.filename
  }
  return block
}

export function getToolCallId(event: AiStreamEvent) {
  return typeof event?.toolCallId === "string"
    ? event.toolCallId
    : typeof event?.id === "string"
      ? event.id
      : typeof event?.toolCall?.toolCallId === "string"
        ? event.toolCall.toolCallId
        : undefined
}

export function getToolInput(event: AiStreamEvent, fallback: unknown = {}) {
  return event?.args ?? event?.input ?? event?.toolCall?.args ?? event?.toolCall?.input ?? fallback
}

export function getToolMetadata(event: AiStreamEvent) {
  const metadata: Record<string, unknown> = {}
  const toolCall = event?.toolCall
  const providerExecuted =
    typeof event?.providerExecuted === "boolean"
      ? event.providerExecuted
      : typeof toolCall?.providerExecuted === "boolean"
        ? toolCall.providerExecuted
        : undefined
  if (typeof providerExecuted === "boolean") metadata.providerExecuted = providerExecuted
  const providerMetadata =
    event?.providerMetadata && typeof event.providerMetadata === "object"
      ? event.providerMetadata
      : toolCall?.providerMetadata && typeof toolCall.providerMetadata === "object"
        ? toolCall.providerMetadata
        : undefined
  if (providerMetadata) {
    metadata.providerMetadata = providerMetadata
  }
  const toolMetadata =
    event?.toolMetadata && typeof event.toolMetadata === "object"
      ? event.toolMetadata
      : toolCall?.toolMetadata && typeof toolCall.toolMetadata === "object"
        ? toolCall.toolMetadata
        : undefined
  if (toolMetadata) {
    metadata.toolMetadata = toolMetadata
  }
  const dynamic =
    typeof event?.dynamic === "boolean"
      ? event.dynamic
      : typeof toolCall?.dynamic === "boolean"
        ? toolCall.dynamic
        : undefined
  if (typeof dynamic === "boolean") metadata.dynamic = dynamic
  const title = typeof event?.title === "string" ? event.title : toolCall?.title
  if (typeof title === "string") metadata.title = title
  const invalid =
    typeof event?.invalid === "boolean"
      ? event.invalid
      : typeof toolCall?.invalid === "boolean"
        ? toolCall.invalid
        : undefined
  if (typeof invalid === "boolean") metadata.invalid = invalid
  if (Object.prototype.hasOwnProperty.call(event ?? {}, "error") && event.error !== undefined) {
    metadata.error = event.error
  } else if (
    Object.prototype.hasOwnProperty.call(toolCall ?? {}, "error") &&
    toolCall!.error !== undefined
  ) {
    metadata.error = toolCall!.error
  }
  return metadata
}

export function getProviderMetadata(event: AiStreamEvent) {
  return event?.providerMetadata && typeof event.providerMetadata === "object"
    ? event.providerMetadata
    : undefined
}

export function tryParseToolInput(text: string): unknown {
  if (typeof text !== "string" || !text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
