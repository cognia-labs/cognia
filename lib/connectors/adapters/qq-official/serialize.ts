/**
 * OutboundRequest → QQ Official Bot REST call.
 *
 * QQ addresses each scene with a different endpoint:
 *   - group   → POST /v2/groups/{group_openid}/messages
 *   - c2c     → POST /v2/users/{user_openid}/messages
 *   - channel → POST /channels/{channel_id}/messages
 *   - direct  → POST /dms/{guild_id}/messages
 *
 * Passing `msg_id` makes the send a (free) passive reply inside the reply
 * window. Group/C2C use the captured inbound `msgId` or interaction `eventId`;
 * a visible quote uses a separate index in `message_reference`.
 *
 * Passive-reply constraints enforced here (per the v2 send docs):
 *   - `msg_seq` pairs with `msg_id` on group/C2C sends; it defaults to 1 when
 *     omitted and the same msg_id+msg_seq combo is rejected as a duplicate,
 *     so every distinct reply to the same inbound message needs its own seq.
 *   - Each msg_id accepts at most 4 C2C or 5 group passive replies.
 *   - msg_id expires: group / channel / direct after 5 minutes, C2C after
 *     60 minutes. An expired msg_id fails the whole send.
 *
 * Platform idempotency (ADR-0009): `msg_seq` is DERIVED from the outbound
 * job's `idempotencyKey` (`1 + fnv1a(key) % 65535`), not from a per-send
 * counter. A retry of the same job therefore re-sends the same
 * `msg_id + msg_seq` pair and the platform rejects it as a duplicate instead
 * of delivering twice. QQ stays `reconciliation_required` because the
 * rejection is an error, not the original message id (UNVERIFIED: the exact
 * error code QQ returns for a duplicate pair). The per-msg_id bookkeeping
 * that remains only tracks how many DISTINCT replies (idempotency keys) a
 * msg_id has consumed, to honour its scene's reply cap.
 */

import { validateQQKeyboard } from "./keyboard"
import type { OutboundRequest, SegmentDowngrade } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { fnv1a32 } from "../_shared/fnv1a"
import { isPublicHttpUrl } from "../_shared/inbound-media"
import { escapeMarkdown } from "../_shared/inbound-markdown"
import { qqReferenceIndex, type QQScene } from "./parse"

export interface QQSendCall {
  downgrades?: SegmentDowngrade[]
  path: string
  payload: Record<string, unknown>
  upload?: {
    path: string
    payload: { file_type: number; url?: string; file_name?: string; srv_send_msg: false }
    binary?: QQBinarySource
  }
}

export interface QQBinarySource {
  sourceUrl: string
  fileName: string
}
export const QQ_MAX_UPLOAD_BYTES = 200_000_000

function qqBinarySource(
  resource: Extract<MessageSegment, { type: "image" | "file" | "video" | "voice" }>
): { url?: string; binary?: QQBinarySource; fileName: string } {
  const fileName =
    resource.type === "file"
      ? resource.name.trim().split(/[\\/]/).at(-1)!
      : resource.type === "image"
        ? "image.png"
        : resource.type === "video"
          ? "video.mp4"
          : "voice.silk"
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(fileName)
  )
    throw new QQValidationError("QQ upload requires a valid file name")
  if (
    resource.type === "file" &&
    (!Number.isSafeInteger(resource.sizeBytes) ||
      resource.sizeBytes < 0 ||
      resource.sizeBytes > QQ_MAX_UPLOAD_BYTES)
  )
    throw new QQValidationError(
      "QQ file exceeds the 200000000-byte upload limit or has an invalid size"
    )
  let source = resource.url
  if ("dataBase64" in resource && resource.dataBase64 !== undefined) {
    const mime =
      resource.mimeType || (resource.type === "image" ? "image/png" : "application/octet-stream")
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime))
      throw new QQValidationError("QQ inline media has an invalid MIME type")
    source = `data:${mime};base64,${resource.dataBase64}`
  }
  if (source.startsWith("data:")) {
    const separator = source.indexOf(",")
    const encoded = source.slice(separator + 1)
    if (
      separator < 0 ||
      separator > 4096 ||
      !source.slice(0, separator).endsWith(";base64") ||
      !encoded.length ||
      encoded.length > Math.ceil(QQ_MAX_UPLOAD_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      throw new QQValidationError("QQ inline media requires bounded valid base64 data")
    return { fileName, binary: { sourceUrl: source, fileName } }
  }
  // Public connector segments (including plugin hooks) are not filesystem
  // grants. User-selected files arrive as bytes through the composer intake.
  try {
    const url = new URL(source)
    if (url.username || url.password || !isPublicHttpUrl(url.href))
      throw new Error("invalid public URL")
    return { url: source, fileName }
  } catch {
    throw new QQValidationError(
      "QQ media requires a public HTTP(S) URL or explicit inline bytes; local path strings are not authorized"
    )
  }
}

export class QQValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QQValidationError"
  }
}

/**
 * Passive-reply validity window per scene (docs: 群聊/文字子频道/频道私信
 * 5 分钟, 单聊 60 分钟).
 */
export const QQ_PASSIVE_WINDOW_MS: Record<QQScene, number> = {
  group: 5 * 60_000,
  c2c: 60 * 60_000,
  channel: 5 * 60_000,
  direct: 5 * 60_000,
}

/** Scene-specific reply limits; guild endpoints do not use this counter. */
export const QQ_MAX_PASSIVE_REPLIES = { group: 5, c2c: 4 } as const

/** Bound on the per-msg_id reply-key map — old inbound msg_ids age out anyway. */
const MSG_SEQ_MAP_CAP = 300

/** `msg_seq` is a positive integer; keep it inside a 16-bit range. */
const MSG_SEQ_MODULUS = 65535

/**
 * Deterministic passive `msg_seq` for one outbound job. Same idempotencyKey
 * → same seq on every retry (the platform then rejects the duplicate pair
 * rather than delivering twice). Two distinct keys colliding on the same seq
 * for the same msg_id has probability 1/65535 per pair — the send would be
 * rejected as a duplicate and dead-lettered as `platform_4xx`, visible in
 * the audit; acceptable versus a silent double delivery.
 */
export function qqPassiveMsgSeq(idempotencyKey: string): number {
  return 1 + (fnv1a32(idempotencyKey) % MSG_SEQ_MODULUS)
}

/**
 * Per-msg_id set of distinct reply keys (insertion-ordered for eviction).
 * Module-level so consecutive `send()` calls correlated to the same inbound
 * message are counted against its scene's reply cap, while a RETRY of the same
 * job (same key) does not consume a second slot. Bounded: the oldest msg_id
 * is evicted past `MSG_SEQ_MAP_CAP` (an evicted msg_id is by then far
 * outside its passive window, so a reset count is harmless).
 */
const passiveKeysByMsgId = new Map<string, Set<string>>()

/**
 * Register `key` as a passive reply to `msgId` and return how many distinct
 * replies that msg_id has now consumed (including this one). Idempotent for
 * a repeated key.
 */
export function registerQQPassiveReply(msgId: string, key: string): number {
  const keys = passiveKeysByMsgId.get(msgId) ?? new Set<string>()
  keys.add(key)
  // Re-insert to refresh recency in the insertion-ordered eviction queue.
  passiveKeysByMsgId.delete(msgId)
  passiveKeysByMsgId.set(msgId, keys)
  while (passiveKeysByMsgId.size > MSG_SEQ_MAP_CAP) {
    const oldest = passiveKeysByMsgId.keys().next().value
    if (oldest === undefined) break
    passiveKeysByMsgId.delete(oldest)
  }
  return keys.size
}

/** How many distinct passive replies `msgId` has consumed so far (0 when unknown). */
export function qqPassiveReplyCount(msgId: string): number {
  return passiveKeysByMsgId.get(msgId)?.size ?? 0
}

/** One native quote per logical message, also covering explicit reply segments. */
export function qqQuoteTarget(req: OutboundRequest): string | undefined {
  const targets = new Set(
    [
      req.replyTo?.messageId,
      ...req.segments.flatMap((segment) => (segment.type === "reply" ? [segment.messageId] : [])),
    ].filter((id): id is string => typeof id === "string" && Boolean(id))
  )
  if (targets.size > 1) throw new QQValidationError("QQ message has conflicting quote targets")
  return targets.values().next().value
}

/** Test-only: reset the module-level msg_seq state. */
export function __resetQQMsgSeqForTesting(): void {
  passiveKeysByMsgId.clear()
}

/** Flatten segments into the plain text QQ `msg_type: 0` accepts. */
export function buildQQContent(
  segments: MessageSegment[],
  downgrades: SegmentDowngrade[] = []
): string {
  const parts: string[] = []
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        parts.push(seg.text)
        break
      case "markdown":
        parts.push(seg.md)
        break
      case "code":
        parts.push(seg.code)
        break
      case "image":
      case "video":
      case "voice":
      case "file":
        parts.push(`[${seg.type}] ${seg.url}`)
        break
      case "a2ui":
        parts.push(seg.plainTextMirror || "[interactive message]")
        break
      case "emoji":
        parts.push(seg.code)
        break
      case "mention":
        parts.push(`@${seg.displayName ?? seg.userId}`)
        downgrades.push({ from: "mention", to: "text", reason: "qq_mention_text_alternative" })
        break
      case "reply":
        parts.push(`> ${seg.snippet}`)
        downgrades.push({ from: "reply", to: "text", reason: "qq_reply_text_alternative" })
        break
      case "poll":
        parts.push(`${seg.question}\n${seg.options.map((option) => `- ${option}`).join("\n")}`)
        downgrades.push({ from: "poll", to: "text", reason: "qq_poll_text_alternative" })
        break
      case "location":
        parts.push(`[location ${seg.lat},${seg.lon}${seg.name ? ` ${seg.name}` : ""}]`)
        downgrades.push({ from: "location", to: "text", reason: "qq_location_text_alternative" })
        break
      case "card":
        throw new QQValidationError(
          "QQ opaque cards require a supported reviewed template; no generic card payload can be sent"
        )
      default:
        break
    }
  }
  return parts.join("\n")
}

/**
 * Passive `msg_id` + `msg_seq` fields for group/C2C payloads.
 *
 * This adapter currently supports passive sends only. Exhausted context
 * must fail explicitly rather than authorizing a different proactive send.
 */
function passiveReplyFields(
  scene: "group" | "c2c",
  msgId: string | undefined,
  idempotencyKey: string,
  reserve: boolean,
  eventId?: string
): Record<string, unknown> {
  if (!msgId) return {}
  // A request without an idempotency key (should not happen — the runner
  // always stamps one) still needs a unique seq per send; fall back to a
  // synthetic key that is unique per registration.
  const key = idempotencyKey || `anon:${msgId}:${qqPassiveReplyCount(msgId) + 1}`
  const fields = {
    ...(eventId ? { event_id: eventId } : { msg_id: msgId }),
    msg_seq: qqPassiveMsgSeq(key),
  }
  // A retry (same key) reproduces the same pair without consuming a slot.
  if (passiveKeysByMsgId.get(msgId)?.has(key)) return fields
  if (qqPassiveReplyCount(msgId) >= QQ_MAX_PASSIVE_REPLIES[scene])
    throw new QQValidationError(
      `QQ passive reply exceeds the ${QQ_MAX_PASSIVE_REPLIES[scene]}-reply limit; proactive push is unavailable`
    )
  if (reserve) registerQQPassiveReply(msgId, key)
  return fields
}

export function serializeOutbound(req: OutboundRequest, reserve = true): QQSendCall | null {
  const ref = req.conversationRef as {
    scene?: QQScene
    sceneId?: string
    msgId?: string
    eventId?: string
    receivedAt?: number
    qqMsgIndex?: string
    qqQuoteIndex?: string
  }
  const scene = ref.scene
  const sceneId = ref.sceneId
  if (!scene || !sceneId) return null
  const nativeQuoteScene = scene === "group" || scene === "c2c"
  const quoteTarget = nativeQuoteScene ? qqQuoteTarget(req) : undefined
  const quoteIndex = quoteTarget
    ? qqReferenceIndex(ref.qqQuoteIndex ?? (quoteTarget === ref.msgId ? ref.qqMsgIndex : undefined))
    : undefined
  const bodySegments =
    nativeQuoteScene && quoteIndex
      ? req.segments.filter((segment) => segment.type !== "reply")
      : req.segments

  const cards = nativeQuoteScene
    ? req.segments.filter((s) => s.type === "card" && s.card.kind === "qq-keyboard")
    : []
  if (cards.length > 1) throw new QQValidationError("QQ requires separate keyboard message parts")
  const nativeCard =
    cards[0]?.type === "card" ? (cards[0].card.payload as Record<string, unknown>) : undefined
  let keyboard: ReturnType<typeof validateQQKeyboard> | undefined
  if (nativeCard) {
    try {
      keyboard = validateQQKeyboard(nativeCard.keyboard, scene as "group" | "c2c")
    } catch (error) {
      throw new QQValidationError(error instanceof Error ? error.message : "Invalid QQ keyboard")
    }
    if (nativeCard.content !== undefined && typeof nativeCard.content !== "string")
      throw new QQValidationError("QQ keyboard content must be text")
    if (
      nativeCard.markdown !== undefined &&
      (!nativeCard.markdown ||
        typeof nativeCard.markdown !== "object" ||
        typeof (nativeCard.markdown as { content?: unknown }).content !== "string")
    )
      throw new QQValidationError("QQ keyboard Markdown must have content")
    if (nativeCard.content && nativeCard.markdown)
      throw new QQValidationError("QQ content and Markdown are exclusive")
  }
  const cardMarkdown = (nativeCard?.markdown as { content?: string } | undefined)?.content
  const media = req.segments.filter(
    (segment) =>
      segment.type === "image" ||
      segment.type === "voice" ||
      segment.type === "video" ||
      segment.type === "file"
  )
  if (media.length > 1) throw new QQValidationError("QQ requires one media resource per message")
  const resource = media[0]
  const useMarkdown =
    (scene === "group" || scene === "c2c") &&
    (req.segments.some((segment) => segment.type === "markdown") || cardMarkdown !== undefined)
  if (keyboard && resource)
    throw new QQValidationError("QQ keyboards and media require separate parts")
  if (useMarkdown && resource)
    throw new QQValidationError("QQ Markdown and media require separate message parts")
  let uploadSource: ReturnType<typeof qqBinarySource> | undefined
  if (resource) {
    if ((scene === "channel" || scene === "direct") && resource.type !== "image")
      throw new QQValidationError(`QQ ${scene} does not support ${resource.type} media`)
    uploadSource = qqBinarySource(resource)
    if ((scene === "channel" || scene === "direct") && uploadSource.binary)
      throw new QQValidationError("QQ guild images require a public HTTP(S) URL")
    if (
      resource.type === "voice" &&
      resource.mimeType &&
      !["audio/silk", "audio/x-silk"].includes(resource.mimeType)
    )
      throw new QQValidationError("QQ voice resources must use SILK encoding")
  }
  const downgrades: SegmentDowngrade[] = []
  if (nativeCard?.fallback)
    downgrades.push({ from: "a2ui", to: "text", reason: "qq_a2ui_widgets_text_alternative" })
  for (const segment of req.segments)
    if (segment.type === "a2ui")
      downgrades.push({
        from: "a2ui",
        to: "text",
        reason: nativeQuoteScene ? "qq_a2ui_text_alternative" : "qq_a2ui_scene_unsupported",
      })
  const content = nativeCard
    ? (cardMarkdown ?? (nativeCard.content as string) ?? " ")
    : useMarkdown
      ? bodySegments
          .map((segment) =>
            segment.type === "markdown"
              ? segment.md
              : escapeMarkdown(buildQQContent([segment], downgrades))
          )
          .join("\n")
      : buildQQContent(
          bodySegments.filter((segment) => segment !== resource),
          downgrades
        )
  if (useMarkdown && !content.trim()) throw new QQValidationError("QQ Markdown content is empty")
  if (!useMarkdown) {
    for (const segment of req.segments) {
      if (segment.type === "markdown")
        downgrades.push({
          from: "markdown",
          to: "text",
          reason: "qq_markdown_scene_unsupported",
        })
    }
  }
  const idempotencyKey = req.metadata?.idempotencyKey ?? ""
  if (ref.eventId && ref.msgId)
    throw new QQValidationError("QQ event_id and msg_id are mutually exclusive")
  if (ref.eventId && !nativeQuoteScene)
    throw new QQValidationError("QQ event replies require group/C2C")
  const msgId = nativeQuoteScene
    ? ref.eventId
      ? `event:${ref.eventId}`
      : ref.msgId
    : (req.replyTo?.messageId ?? ref.msgId)
  if (!msgId)
    throw new QQValidationError("QQ requires passive reply context; proactive push is unavailable")

  // Never remove an expired reply context: proactive push is unavailable.
  // A selected quote never renews or replaces the passive authorization.
  if (
    msgId &&
    (nativeQuoteScene || !req.replyTo?.messageId || req.replyTo.messageId === ref.msgId) &&
    typeof ref.receivedAt === "number" &&
    Date.now() - ref.receivedAt > QQ_PASSIVE_WINDOW_MS[scene]
  ) {
    throw new QQValidationError(
      "QQ passive reply window has expired; proactive push is unavailable"
    )
  }
  if (req.replyTo && nativeQuoteScene && !quoteIndex)
    throw new QQValidationError("QQ native reply requires a known quote index in this conversation")
  const quoteFields = quoteIndex ? { message_reference: { message_id: quoteIndex } } : {}

  switch (scene) {
    case "group":
      return {
        ...(downgrades.length ? { downgrades } : {}),
        path: `/v2/groups/${encodeURIComponent(sceneId)}/messages`,
        payload: {
          ...(useMarkdown
            ? { msg_type: 2, markdown: { content } }
            : { content: resource ? content || " " : content, msg_type: resource ? 7 : 0 }),
          ...passiveReplyFields(scene, msgId, idempotencyKey, reserve, ref.eventId),
          ...(keyboard ? { keyboard } : {}),
          ...quoteFields,
        },
        ...(resource
          ? {
              upload: {
                path: `/v2/groups/${encodeURIComponent(sceneId)}/files`,
                payload: {
                  file_type:
                    resource.type === "image"
                      ? 1
                      : resource.type === "video"
                        ? 2
                        : resource.type === "voice"
                          ? 3
                          : 4,
                  ...(uploadSource?.url ? { url: uploadSource.url } : {}),
                  ...(resource.type === "file" ? { file_name: uploadSource!.fileName } : {}),
                  srv_send_msg: false as const,
                },
                ...(uploadSource?.binary ? { binary: uploadSource.binary } : {}),
              },
            }
          : {}),
      }
    case "c2c":
      return {
        ...(downgrades.length ? { downgrades } : {}),
        path: `/v2/users/${encodeURIComponent(sceneId)}/messages`,
        payload: {
          ...(useMarkdown
            ? { msg_type: 2, markdown: { content } }
            : { content: resource ? content || " " : content, msg_type: resource ? 7 : 0 }),
          ...passiveReplyFields(scene, msgId, idempotencyKey, reserve, ref.eventId),
          ...(keyboard ? { keyboard } : {}),
          ...quoteFields,
        },
        ...(resource
          ? {
              upload: {
                path: `/v2/users/${encodeURIComponent(sceneId)}/files`,
                payload: {
                  file_type:
                    resource.type === "image"
                      ? 1
                      : resource.type === "video"
                        ? 2
                        : resource.type === "voice"
                          ? 3
                          : 4,
                  ...(uploadSource?.url ? { url: uploadSource.url } : {}),
                  ...(resource.type === "file" ? { file_name: uploadSource!.fileName } : {}),
                  srv_send_msg: false as const,
                },
                ...(uploadSource?.binary ? { binary: uploadSource.binary } : {}),
              },
            }
          : {}),
      }
    // The guild (channel/direct) v1 endpoints take msg_id only — no msg_seq.
    case "channel":
      return {
        ...(downgrades.length ? { downgrades } : {}),
        path: `/channels/${encodeURIComponent(sceneId)}/messages`,
        payload: {
          content,
          ...(resource ? { image: resource.url } : {}),
          ...(msgId ? { msg_id: msgId } : {}),
        },
      }
    case "direct":
      return {
        ...(downgrades.length ? { downgrades } : {}),
        path: `/dms/${encodeURIComponent(sceneId)}/messages`,
        payload: {
          content,
          ...(resource ? { image: resource.url } : {}),
          ...(msgId ? { msg_id: msgId } : {}),
        },
      }
  }
}

/** Preserve order across QQ's exclusive Markdown/media message types. */
export function serializeOutboundParts(req: OutboundRequest, reserve = true): QQSendCall[] {
  const parts: MessageSegment[][] = []
  let current: MessageSegment[] = []
  const scene = (req.conversationRef as { scene?: QQScene }).scene
  const nativeMarkdown = scene === "group" || scene === "c2c"
  if (nativeMarkdown) {
    const target = qqQuoteTarget(req)
    const index = qqReferenceIndex(
      req.conversationRef.qqQuoteIndex ??
        (target === req.conversationRef.msgId ? req.conversationRef.qqMsgIndex : undefined)
    )
    if (index)
      req = {
        ...req,
        ...(target ? { replyTo: { messageId: target } } : {}),
        segments: req.segments.filter((segment) => segment.type !== "reply"),
      }
  }
  for (const segment of req.segments) {
    if (nativeMarkdown && segment.type === "card" && segment.card.kind === "qq-keyboard") {
      if (current.length) parts.push(current)
      current = []
      parts.push([segment])
      continue
    }
    const media =
      segment.type === "image" ||
      segment.type === "voice" ||
      segment.type === "video" ||
      segment.type === "file"
    if (nativeMarkdown && media && current.some((part) => part.type === "markdown")) {
      parts.push(current)
      current = []
    }
    current.push(segment)
    if (media) {
      parts.push(current)
      current = []
    }
  }
  if (current.length) parts.push(current)
  if (!parts.length) throw new QQValidationError("QQ message is empty")
  const requests = parts.map((segments, index) => ({
    ...req,
    segments,
    metadata: {
      ...req.metadata,
      idempotencyKey:
        parts.length === 1
          ? req.metadata.idempotencyKey
          : `${req.metadata.idempotencyKey}:part:${index}`,
    },
  }))
  const preview = requests.map((part) => serializeOutbound(part, false))
  if (preview.some((call) => !call))
    throw new QQValidationError("QQ send: unaddressable conversationRef")
  const ref = req.conversationRef as { scene?: QQScene; msgId?: string; eventId?: string }
  const msgId = nativeMarkdown
    ? ref.eventId
      ? `event:${ref.eventId}`
      : ref.msgId
    : (req.replyTo?.messageId ?? ref.msgId)
  if (msgId && (ref.scene === "group" || ref.scene === "c2c")) {
    const newKeys = requests.filter(
      (part) => !passiveKeysByMsgId.get(msgId)?.has(part.metadata.idempotencyKey)
    ).length
    if (qqPassiveReplyCount(msgId) + newKeys > QQ_MAX_PASSIVE_REPLIES[ref.scene])
      throw new QQValidationError(
        `QQ multipart message exceeds the remaining ${QQ_MAX_PASSIVE_REPLIES[ref.scene]}-reply limit`
      )
  }
  return reserve ? requests.map((part) => serializeOutbound(part)!) : (preview as QQSendCall[])
}

// ---------------------------------------------------------------------------
// Platform message ids — `${scene}:${sceneId}:${id}`
// ---------------------------------------------------------------------------

/**
 * `send()` returns a composite platform message id because every QQ mutation
 * endpoint (delete / reaction) is scene-scoped: the bare `id` QQ returns is
 * useless without the scene and the addressing id it was posted under.
 */
export function encodeQQMessageId(scene: QQScene, sceneId: string, id: string): string {
  return `${scene}:${sceneId}:${id}`
}

export interface DecodedQQMessageId {
  scene: QQScene
  sceneId: string
  id: string
}

const QQ_SCENES: readonly QQScene[] = ["group", "c2c", "channel", "direct"]

/**
 * Decode a composite id produced by {@link encodeQQMessageId}. Returns null
 * for a bare id (pre-existing rows sent before the composite encoding, or a
 * caller passing QQ's raw id) — the caller must fail loudly, not guess.
 */
export function decodeQQMessageId(messageId: string): DecodedQQMessageId | null {
  const first = messageId.indexOf(":")
  if (first <= 0) return null
  const scene = messageId.slice(0, first)
  if (!QQ_SCENES.includes(scene as QQScene)) return null
  const rest = messageId.slice(first + 1)
  const second = rest.indexOf(":")
  if (second <= 0 || second === rest.length - 1) return null
  return { scene: scene as QQScene, sceneId: rest.slice(0, second), id: rest.slice(second + 1) }
}

export interface QQMutationCall {
  method: "POST" | "PUT" | "DELETE"
  path: string
  payload?: Record<string, unknown>
}

/**
 * Recall (撤回) an already-sent message. Per-scene endpoints:
 *   - group   → DELETE /v2/groups/{group_openid}/messages/{message_id}
 *   - c2c     → DELETE /v2/users/{openid}/messages/{message_id}
 *   - channel → DELETE /channels/{channel_id}/messages/{message_id}?hidetip=false
 *   - direct  → DELETE /dms/{guild_id}/messages/{message_id}?hidetip=false
 * The guild endpoints take `hidetip` (whether to hide the "message recalled"
 * tip); we keep the tip visible so the recall is not silent for the user.
 */
export function serializeDelete(decoded: DecodedQQMessageId): QQMutationCall {
  const sceneId = encodeURIComponent(decoded.sceneId)
  const id = encodeURIComponent(decoded.id)
  switch (decoded.scene) {
    case "group":
      return { method: "DELETE", path: `/v2/groups/${sceneId}/messages/${id}` }
    case "c2c":
      return { method: "DELETE", path: `/v2/users/${sceneId}/messages/${id}` }
    case "channel":
      return { method: "DELETE", path: `/channels/${sceneId}/messages/${id}?hidetip=false` }
    case "direct":
      return { method: "DELETE", path: `/dms/${sceneId}/messages/${id}?hidetip=false` }
  }
}

/**
 * Parse the adapter-level `emojiType` for QQ channel reactions. QQ addresses
 * an emoji by `{type}/{id}` (type 1 = system emoji, type 2 = emoji character
 * code point); the connector contract carries it as a single string
 * `"<type>:<id>"`. Throws on anything else.
 */
export function parseQQEmojiType(emojiType: string): { type: string; id: string } {
  const idx = emojiType.indexOf(":")
  if (idx <= 0 || idx === emojiType.length - 1) {
    throw new Error(`QQ reaction emojiType must be "<type>:<id>", got "${emojiType}"`)
  }
  return { type: emojiType.slice(0, idx), id: emojiType.slice(idx + 1) }
}

/**
 * Reactions exist ONLY in the guild `channel` scene:
 *   PUT    /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
 *   DELETE /channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}
 * Group / C2C / direct messages cannot be reacted to by a bot — the adapter
 * throws `unsupported` for those scenes before reaching this helper.
 */
export function serializeReaction(
  channelId: string,
  messageId: string,
  emojiType: string,
  action: "add" | "remove"
): QQMutationCall {
  const emoji = parseQQEmojiType(emojiType)
  return {
    method: action === "add" ? "PUT" : "DELETE",
    path: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji.type)}/${encodeURIComponent(emoji.id)}`,
  }
}

/** Seconds the "正在输入" bubble stays visible on the C2C client. */
export const QQ_TYPING_INPUT_SECONDS = 60

/**
 * Typing indicator ("输入状态") — C2C ONLY. It is a passive reply of
 * `msg_type: 6` (`input_notify`), so it needs a live inbound `msg_id` inside
 * the 60-minute C2C window and CONSUMES one of that msg_id's 5 passive-reply
 * slots. `msg_seq` is derived from a synthetic key so the indicator's pair
 * never collides with the actual reply's.
 */
export function serializeTyping(openid: string, msgId: string, msgSeq: number): QQMutationCall {
  return {
    method: "POST",
    path: `/v2/users/${encodeURIComponent(openid)}/messages`,
    payload: {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: QQ_TYPING_INPUT_SECONDS },
      msg_id: msgId,
      msg_seq: msgSeq,
    },
  }
}
