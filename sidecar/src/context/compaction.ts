// Conversation compaction for the non-Anthropic (AI SDK) path.
//
// The Anthropic Agent SDK auto-compacts the conversation when the context
// window fills; the AI SDK path (`runtimes/ai-sdk/index.ts`) keeps a flat `conversation`
// array that grows unbounded across turns and eventually overflows the model.
// This module gives that path parity: detect the threshold from the last
// turn's real input-token count, summarize the older messages, and splice the
// summary in ahead of the recent turns.
//
// The sidecar can NOT import `lib/` (build boundary), so the threshold and the
// context-window table are mirrored from `lib/usage/context-usage.ts` — keep them in
// sync. The table only needs the families the AI SDK path actually drives
// (OpenAI / Google / Mistral / Cohere / local OpenAI-compatible engines); the
// Anthropic families are included for completeness since a custom provider can
// declare the anthropic protocol.

/**
 * A conversation message as the ai-sdk rail keeps it: an AI SDK `ModelMessage`
 * (or a looser record from an older session), with `content` a string or a
 * part array.
 */
import type { ConversationMessage } from "../shared/wire/conversation.ts"
import { pairSafeSplitBefore } from "./tool-message-pairing.ts"
import { imagePixelSize } from "../shared/media/image-size.ts"
export type { ConversationMessage } from "../shared/wire/conversation.ts"

/** A content part as it may appear in `ConversationMessage.content`. */
export type ContentPart = Record<string, unknown>

/** Mirrors `lib/usage/context-usage.ts:AUTO_COMPACT_FRACTION`. */
export const AUTO_COMPACT_FRACTION = 0.835

/**
 * Safe default window for an unknown / unrecognised model id (conservative).
 * Mirrors `lib/usage/context-usage.ts:DEFAULT_CONTEXT_WINDOW`; exported so the parity
 * test (`lib/usage/context-usage.compaction-parity.test.ts`) can assert agreement.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

// First match wins; mirrors the ordering in `lib/usage/context-usage.ts`.
const MODEL_CONTEXT_WINDOWS: readonly (readonly [RegExp, number])[] = [
  [/\[1m\]/i, 1_000_000],
  [/[-._]1m(\b|$)/i, 1_000_000],
  [/claude-opus-4-(6|7|8)/i, 1_000_000],
  [/claude-sonnet-4-(6|7|8)/i, 1_000_000],
  // Matches family-first (`claude-sonnet-4-5`) and version-first 3.x
  // (`claude-3-5-sonnet`, `claude-3-opus`); 1M-tier patterns above win first.
  [/claude(-[\d.]+)*-(opus|sonnet|haiku)/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/gpt-4\.1/i, 1_000_000],
  [/(^|[^a-z])o[134]([^a-z]|$)/i, 200_000],
  [/gemini-(1\.5|2\.5|3)/i, 1_000_000],
  // DeepSeek V3 / V3.1 (deepseek-chat, deepseek-reasoner) expose a 128k window.
  [/deepseek/i, 128_000],
]

/** Context-window size for a model id (mirrors the renderer's table). */
export function getContextWindow(modelId: string | null | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return window
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Tokens an image of unknown size is estimated to cost. Providers bill an
 * image by its pixel size, not by its base64 length: Anthropic charges w·h/750
 * capped at ≈1,600 (a 1092×1092 image, the largest it sends unscaled) and
 * OpenAI's high-detail tiles stay below that. Counting the base64 string would
 * put a 1 MB screenshot at ~330k tokens; counting nothing put it at 0.
 */
export const IMAGE_TOKENS = 1_600

/**
 * Tokens of one image: w·h/750 up to {@link IMAGE_TOKENS} when its header
 * states its size (the optical estimator's default formula), else the cap.
 */
function imageTokens(data: unknown): number {
  const inline =
    data && typeof data === "object" && (data as { type?: unknown }).type === "data"
      ? (data as { data?: unknown }).data
      : data
  const size = typeof inline === "string" ? imagePixelSize(inline) : null
  return size
    ? Math.max(1, Math.min(IMAGE_TOKENS, Math.round((size.width * size.height) / 750)))
    : IMAGE_TOKENS
}

/** The char heuristic every text estimate here uses. */
const CHARS_PER_TOKEN = 4

/** A full (`image/png`) or bare top-level (`image`) image media type. */
export function isImageMediaType(mediaType: unknown): boolean {
  return typeof mediaType === "string" && (mediaType === "image" || mediaType.startsWith("image/"))
}

function serializedLength(value: unknown): number {
  if (value == null) return 0
  if (typeof value === "string") return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Decoded bytes per token of an audio or video file. Gemini, the provider that
 * takes native video, bills audio at 32 tokens a second and video at ≈263; at
 * the bitrates an attachment has (≈128 kbps audio, ≈1 Mbps video) both come
 * to ≈1 token per 500 bytes. Reading the bytes as characters put a 6 MB clip
 * at 1.5M tokens, past every window, and the pre-send check refused the turn.
 */
const AV_BYTES_PER_TOKEN = 500

/**
 * Decoded bytes per token of any other file (a PDF a tool returned). Providers
 * bill a document by its pages (Anthropic ≈1,500–3,000 tokens a page, Gemini
 * 258), and a page weighs from a few KB of text to hundreds of KB of scan;
 * 32 bytes a token puts a 75 KB page near 2,300 tokens. One file is at least
 * one page, priced as one image.
 */
const DOCUMENT_BYTES_PER_TOKEN = 32

/**
 * Tokens of one media part. An image costs {@link imageTokens}; inline text
 * counts as text; inline audio and video count by duration-equivalent bytes,
 * other inline files by page-equivalent bytes. A URL or provider reference
 * cannot be sized here and counts as one image.
 */
function mediaTokens(mediaType: unknown, data: unknown): number {
  if (isImageMediaType(mediaType)) return imageTokens(data)
  const tagged = data && typeof data === "object" ? (data as { type?: unknown }) : null
  if (tagged?.type === "text") {
    const text = (data as { text?: unknown }).text
    return Math.ceil((typeof text === "string" ? text.length : 0) / CHARS_PER_TOKEN)
  }
  const inline = tagged?.type === "data" ? (data as { data?: unknown }).data : data
  let bytes = 0
  if (typeof inline === "string") {
    if (/^https?:/i.test(inline)) return IMAGE_TOKENS
    const base64 = inline.startsWith("data:") ? inline.slice(inline.indexOf(",") + 1) : inline
    bytes = Math.floor((base64.length * 3) / 4)
  } else if (inline instanceof Uint8Array || inline instanceof ArrayBuffer) {
    bytes = inline.byteLength
  }
  if (typeof mediaType === "string" && /^(audio|video)\//.test(mediaType))
    return Math.max(1, Math.ceil(bytes / AV_BYTES_PER_TOKEN))
  return Math.max(IMAGE_TOKENS, Math.ceil(bytes / DOCUMENT_BYTES_PER_TOKEN))
}

/** Running size of a message list: text characters plus media tokens. */
interface Tally {
  chars: number
  mediaTokens: number
}

/**
 * Size a tool result's `output` by its AI SDK shape. A `content` output can
 * hold images, which count as media rather than as their base64 text.
 */
function tallyToolOutput(output: unknown, tally: Tally): void {
  if (!output || typeof output !== "object") {
    tally.chars += serializedLength(output)
    return
  }
  const typed = output as { type?: unknown; value?: unknown; reason?: unknown }
  switch (typed.type) {
    case "text":
    case "error-text":
    case "json":
    case "error-json":
      tally.chars += serializedLength(typed.value)
      return
    case "execution-denied":
      tally.chars += serializedLength(typed.reason)
      return
    case "content":
      if (Array.isArray(typed.value)) for (const part of typed.value) tallyPart(part, tally)
      return
    default:
      tally.chars += serializedLength(output)
  }
}

/**
 * Size one content part as the provider will receive it. A tool call is its
 * name plus its whole `input`: a long `write` or `edit` carries the file in its
 * arguments, and leaving them out once let a candidate holding 400,000 argument
 * characters pass every fit check as 35 tokens. An unknown part counts whole.
 */
function tallyPart(part: unknown, tally: Tally): void {
  if (typeof part === "string") {
    tally.chars += part.length
    return
  }
  if (!part || typeof part !== "object") return
  const p = part as ContentPart
  switch (p.type) {
    case "text":
    case "reasoning":
      tally.chars += typeof p.text === "string" ? p.text.length : 0
      return
    case "tool-call":
      tally.chars += serializedLength(p.toolName) + serializedLength(p.input)
      return
    case "tool-result":
      tally.chars += serializedLength(p.toolName)
      tallyToolOutput(p.output, tally)
      return
    case "image":
      tally.mediaTokens += mediaTokens(p.mediaType ?? "image", p.image)
      return
    case "file":
      tally.mediaTokens += mediaTokens(p.mediaType, p.data)
      return
    default:
      tally.chars += serializedLength(p)
  }
}

/**
 * Estimated input tokens of a message list: ≈4 characters per token for text,
 * tool-call arguments and tool results, plus a per-part cost for media. The
 * compaction trigger prefers the provider's real `usage.inputTokens`; this
 * estimate sizes everything usage cannot see yet — the retained tail, a
 * replacement candidate before it is published, the request about to be sent.
 */
export function estimateTokens(
  messages: readonly (ConversationMessage | null | undefined)[]
): number {
  const tally: Tally = { chars: 0, mediaTokens: 0 }
  for (const m of messages) {
    const content = m?.content
    if (typeof content === "string") tally.chars += content.length
    else if (Array.isArray(content)) for (const part of content) tallyPart(part, tally)
  }
  return Math.round(tally.chars / CHARS_PER_TOKEN) + tally.mediaTokens
}

/**
 * Should the next turn compact first?
 *
 * - `trigger === "manual"` → never auto-fires (manual compaction uses `force`).
 * - `trigger === "message-count"` → fires when `messageCount` reaches the
 *   configured `messageCountThreshold` (token-independent).
 * - otherwise (token-threshold / default) → fires when the last turn's real
 *   input token count crossed the auto-compact fraction of the model's window.
 *
 * `contextWindow` is the AUTHORITATIVE window the renderer resolved from the
 * provider catalog (`resolveSendOptions` → `SendOptions.compaction.contextWindow`).
 * Prefer it over {@link getContextWindow}'s regex table: that table is a
 * conservative mirror that drifts (e.g. it floors every `deepseek*` id at 128k,
 * so a real 1M deepseek-v4 would auto-compact at ~107k instead of ~835k). The
 * regex window is only the fallback for callers that don't thread the resolved
 * value (older sessions, the parity test).
 */
export function shouldCompact({
  lastInputTokens,
  modelId,
  contextWindow,
  fraction = AUTO_COMPACT_FRACTION,
  trigger,
  messageCount,
  messageCountThreshold,
}: {
  lastInputTokens?: unknown
  modelId?: string | null
  contextWindow?: unknown
  fraction?: number
  trigger?: unknown
  messageCount?: unknown
  messageCountThreshold?: unknown
}): boolean {
  if (trigger === "manual") return false
  if (trigger === "message-count") {
    if (typeof messageCount !== "number" || typeof messageCountThreshold !== "number") return false
    return messageCountThreshold > 0 && messageCount >= messageCountThreshold
  }
  if (typeof lastInputTokens !== "number" || lastInputTokens <= 0) return false
  const window =
    typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : getContextWindow(modelId)
  return lastInputTokens >= window * fraction
}

// --- Frozen-summary markers ------------------------------------------------
// A compaction summary is spliced as a `role:"user"` message whose text opens
// with a sentinel tag carrying a monotonically-increasing version. Marking it
// lets `planCompaction` PROTECT prior summaries (keep them in the head instead
// of feeding them back into `middle`), which is what stops the lossy
// "summary-of-summary" recursion and keeps the prompt-cache prefix stable.

/** Sentinel prefix every spliced summary message opens with. */
export const SUMMARY_OPEN_TAG = "<conversation-summary"

/** Leading text of a summary/optical message (the sentinel-bearing header),
 * whether content is a plain string or a `[text, …image]` array (the optical
 * strategy renders the archive as image parts after the header). */
function leadingText(m: ConversationMessage | null | undefined): string | null {
  if (!m || m.role !== "user") return null
  if (typeof m.content === "string") return m.content
  if (Array.isArray(m.content)) {
    const first = (m.content as (ContentPart | null | undefined)[]).find(
      (p) => p && p.type === "text" && typeof p.text === "string"
    )
    return first ? (first.text as string) : null
  }
  return null
}

/** True when `m` is a previously-spliced compaction summary OR optical archive.
 * Both are protected as frozen so prior archives are carried forward verbatim
 * instead of being fed back into `middle` (and, for optical, silently lost — an
 * image part yields no text to re-summarize). */
export function isSummaryMessage(m: ConversationMessage | null | undefined): boolean {
  const head = leadingText(m)
  return head != null && head.startsWith(SUMMARY_OPEN_TAG)
}

/** Version parsed from a summary/optical message's `v="N"` header (0 absent). */
export function summaryVersion(m: ConversationMessage | null | undefined): number {
  if (!isSummaryMessage(m)) return 0
  const match = leadingText(m)!.match(/^<conversation-summary\s+v="(\d+)"/)
  return match ? Number(match[1]) : 0
}

/** Render one versioned, prefix-cache-stable summary message. */
export function makeSummaryMessage(summary: string, version: number): ConversationMessage {
  const v = Number.isFinite(version) && version > 0 ? version : 1
  return {
    role: "user",
    content: `${SUMMARY_OPEN_TAG} v="${v}">\nSummary of earlier conversation (compacted to save context):\n${summary}\n</conversation-summary>`,
  }
}

/**
 * Render one versioned optical-archive message: a sentinel-bearing text header
 * followed by the rendered image parts. Recognized as frozen by
 * {@link isSummaryMessage}, so it is carried forward verbatim across turns.
 */
export function makeOpticalMessage(
  imageParts: readonly OpticalImagePart[],
  info: { messageCount?: number; frameCount?: number } | null | undefined,
  version: number
): ConversationMessage {
  const v = Number.isFinite(version) && version > 0 ? version : 1
  const frames = imageParts.length
  const msgs = info?.messageCount
  const header =
    `${SUMMARY_OPEN_TAG} v="${v}" optical="1">\n` +
    `Earlier conversation${typeof msgs === "number" ? ` (${msgs} messages)` : ""} was compacted to ` +
    `save context: it is rendered as ${frames} optical frame image${frames === 1 ? "" : "s"} below. ` +
    `Read the image${frames === 1 ? "" : "s"} as verbatim conversation history and treat it as authoritative.\n` +
    `</conversation-summary>`
  return { role: "user", content: [{ type: "text", text: header }, ...imageParts] }
}

/** An image a compaction keeps, as a user-message file part, and where it came from. */
export interface RetainedImage {
  part: { type: "file"; mediaType: string; data: unknown; filename?: string }
  /** Shown to the model ahead of the image: who supplied it. */
  origin: string
}

/**
 * First text of the user message a non-Anthropic rail adds after a tool turn
 * to show the model the images its tools returned (most providers have no
 * image slot in a tool result). Its images came from tools, not the user.
 */
export const TOOL_IMAGES_LEAD_TEXT = "Image(s) returned by the tool call(s) above:"

/** Is this the user message that re-shows tool images ({@link TOOL_IMAGES_LEAD_TEXT})? */
function isToolImagesMessage(m: ConversationMessage): boolean {
  if (m.role !== "user" || !Array.isArray(m.content)) return false
  const first = m.content[0] as ContentPart | undefined
  return first?.type === "text" && first.text === TOOL_IMAGES_LEAD_TEXT
}

/** Is this frozen message the media-retention message {@link makeRetainedMediaMessage} writes? */
export function isRetainedMediaMessage(m: ConversationMessage): boolean {
  return isSummaryMessage(m) && /^<conversation-summary\s+v="\d+"\s+media="1"/.test(leadingText(m)!)
}

/**
 * Every image `messages` carry, in order: user image and image-file parts, and
 * images inside a tool result's `content` output (the Anthropic rail keeps
 * them there; other rails re-project them into a user message that says so,
 * and those keep a tool origin). An optical archive's frames are rendered
 * history, not evidence, and are skipped; a previous retention message yields
 * its images again with their origins.
 */
export function collectImages(messages: readonly ConversationMessage[]): RetainedImage[] {
  const out: RetainedImage[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    const parts = message.content as (ContentPart | null | undefined)[]
    if (isSummaryMessage(message) && !isRetainedMediaMessage(message)) continue
    if (isRetainedMediaMessage(message)) {
      parts.forEach((part, i) => {
        if (part?.type !== "file" || !isImageMediaType(part.mediaType)) return
        const label = parts[i - 1]
        const origin =
          label?.type === "text" && typeof label.text === "string"
            ? label.text.replace(/^\[|\]$/g, "")
            : "image"
        out.push({ part: part as RetainedImage["part"], origin })
      })
      continue
    }
    const from = isToolImagesMessage(message)
      ? "image returned by a tool call"
      : `image from a ${message.role} message`
    for (const part of parts) {
      if (!part) continue
      if (part.type === "image" && part.image != null) {
        out.push({
          part: {
            type: "file",
            mediaType: typeof part.mediaType === "string" ? part.mediaType : "image",
            data: part.image,
          },
          origin: from,
        })
      } else if (part.type === "file" && isImageMediaType(part.mediaType) && part.data != null) {
        out.push({
          part: {
            type: "file",
            mediaType: part.mediaType as string,
            data: part.data,
            ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
          },
          origin: `${from}${typeof part.filename === "string" ? ` (${part.filename})` : ""}`,
        })
      } else if (part.type === "tool-result") {
        const output = part.output as { type?: unknown; value?: unknown } | undefined
        if (output?.type !== "content" || !Array.isArray(output.value)) continue
        for (const item of output.value as (ContentPart | null | undefined)[]) {
          const data = item?.data as { type?: unknown } | undefined
          if (
            item?.type !== "file" ||
            !isImageMediaType(item.mediaType) ||
            (data?.type !== "data" && data?.type !== "url")
          )
            continue
          out.push({
            part: { type: "file", mediaType: item.mediaType as string, data: item.data },
            origin: `image returned by ${typeof part.toolName === "string" ? part.toolName : "a tool"}`,
          })
        }
      }
    }
  }
  return out
}

/**
 * The newest images that fit `maxImages` and `maxTokens`, in their original
 * order. Older ones are the first to go: the recent turns are what the agent
 * is still acting on.
 */
export function selectRetainedImages(
  images: readonly RetainedImage[],
  { maxImages, maxTokens }: { maxImages: number; maxTokens: number }
): RetainedImage[] {
  let tokens = 0
  let from = images.length
  while (from > 0 && images.length - from < maxImages) {
    const image = images[from - 1]!
    const cost = estimateTokens([
      { role: "user", content: [{ type: "text", text: `[${image.origin}]` }, image.part] },
    ])
    if (tokens + cost > maxTokens) break
    tokens += cost
    from--
  }
  return images.slice(from)
}

/**
 * Render the images a compaction keeps as one frozen message: a
 * sentinel-bearing header, then each image after a line naming its origin.
 * {@link isSummaryMessage} recognizes it, so later compactions carry it
 * forward verbatim, and a regeneration re-reads its images through
 * {@link collectImages} instead of losing them.
 */
export function makeRetainedMediaMessage(
  images: readonly RetainedImage[],
  version: number,
  droppedCount = 0
): ConversationMessage {
  const v = Number.isFinite(version) && version > 0 ? version : 1
  const dropped =
    droppedCount > 0
      ? ` ${droppedCount} older image${droppedCount === 1 ? " was" : "s were"} not kept; if one matters, open its source again (re-run the tool that returned it, or ask the user to share it again).`
      : ""
  const header =
    `${SUMMARY_OPEN_TAG} v="${v}" media="1">\n` +
    `Images from the compacted conversation, kept verbatim so their visual evidence stays available. ` +
    `Each follows a line naming where it came from.${dropped}\n</conversation-summary>`
  return {
    role: "user",
    content: [
      { type: "text", text: header },
      ...images.flatMap(({ part, origin }) => [{ type: "text", text: `[${origin}]` }, part]),
    ],
  }
}

/** One rendered optical frame, as an AI SDK image part. */
export interface OpticalImagePart {
  type: "image"
  image: string
  mediaType?: string
}

/** How `planCompaction` splits a conversation. */
export interface CompactionPlan {
  systemHead: ConversationMessage[]
  frozen: ConversationMessage[]
  middle: ConversationMessage[]
  tail: ConversationMessage[]
}

/**
 * Split the conversation into:
 *  - `systemHead` — the leading `role:"system"` block (never summarized),
 *  - `frozen` — the contiguous prior summary messages right after it (PROTECTED;
 *    carried forward verbatim, never re-summarized),
 *  - `middle` — the genuinely-new user/assistant messages to summarize,
 *  - `tail` — the most-recent `keepRecentMessages` kept verbatim, extended
 *    back so it never starts inside a tool call ↔ result pair.
 * Returns null when there is nothing new enough to be worth summarizing.
 */
export function planCompaction({
  conversation,
  keepRecentMessages,
  keepRecentTokens,
}: {
  conversation: readonly ConversationMessage[]
  keepRecentMessages?: number
  keepRecentTokens?: number
}): CompactionPlan | null {
  let i = 0
  while (i < conversation.length && conversation[i]!.role === "system") i++
  const systemHead = conversation.slice(0, i)
  let j = i
  while (j < conversation.length && isSummaryMessage(conversation[j])) j++
  const frozen = conversation.slice(i, j)
  const rest = conversation.slice(j)
  let keep = Math.max(0, keepRecentMessages ?? 6)
  if (keepRecentTokens !== undefined && keepRecentTokens >= 0) {
    keep = 0
    let tokens = 0
    while (keep < rest.length && tokens < keepRecentTokens) {
      tokens += Math.max(1, estimateTokens([rest[rest.length - 1 - keep]]))
      keep++
    }
  }
  if (rest.length <= keep) return null
  // Never cut between a tool call and its result: the tail starts early enough
  // to keep each pair whole, or the saved history would carry an orphan.
  const split = pairSafeSplitBefore(rest, rest.length - keep)
  const middle = rest.slice(0, split)
  const tail = rest.slice(split)
  if (middle.length === 0) return null
  return { systemHead, frozen, middle, tail }
}
