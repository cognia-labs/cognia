import { normalizeInboundVoice } from "../_shared/voice"
/**
 * QQ Official Bot gateway dispatch → NormalizedInboundEvent.
 *
 * Four message scenes are surfaced:
 *   - GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE → group (group_openid).
 *   - C2C_MESSAGE_CREATE       → 1:1 private chat (user_openid).
 *   - AT_MESSAGE_CREATE / MESSAGE_CREATE → guild channel (channel_id).
 *   - DIRECT_MESSAGE_CREATE    → guild direct message (dms guild_id).
 *
 * Full-message events preserve actual mention metadata. Ingesting a message
 * does not authorize an automated reply; the bus applies conversation policy.
 *
 * The `conversationRef` carries a `scene` discriminator plus the id the
 * serializer needs to address the reply, and the inbound `msgId` so the reply
 * lands in the (free) passive-reply window.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import type { InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { evaluateFetchTarget } from "@cognia/network-guard"

export type QQScene = "group" | "c2c" | "channel" | "direct"

/** Shared wire identity used by inbound status/reactions and outbound receipts. */
export function encodeQQMessageId(scene: QQScene, sceneId: string, id: string): string {
  return `${scene}:${sceneId}:${id}`
}

export interface QQAuthor {
  id?: string
  username?: string
  avatar?: string
  member_openid?: string
  user_openid?: string
}

export interface QQAttachmentData {
  voice_wav_url?: string
  asr_refer_text?: string
  url?: string
  content_type?: string
  filename?: string
  size?: number
  width?: number
  height?: number
}

export interface QQARKData {
  prompt?: string
  ark_type?: string
  ark_name?: string
  fields?: Record<string, unknown>
}

export interface QQMsgElement {
  msg_idx?: string
  author?: QQAuthor
  message_type?: number
  content?: string
  attachments?: QQAttachmentData[]
  ark_data?: QQARKData
  msg_elements?: QQMsgElement[]
}

export interface QQMessageData extends QQMsgElement {
  /** Recall notifications wrap the original message and acting user. */
  message?: QQMessageData
  op_user?: QQAuthor
  id?: string
  content?: string
  timestamp?: string
  author?: QQAuthor
  group_openid?: string
  channel_id?: string
  guild_id?: string
  attachments?: QQAttachmentData[]
  mentions?: QQAuthor[]
  message_reference?: { message_id?: string }
  message_scene?: { source?: string; ext?: string[] }
}

export interface QQDispatch {
  id?: string
  t: string
  s?: number
  op: number
  d?: QQMessageData
}

const SCENE_BY_EVENT: Record<string, QQScene> = {
  GROUP_AT_MESSAGE_CREATE: "group",
  GROUP_MESSAGE_CREATE: "group",
  C2C_MESSAGE_CREATE: "c2c",
  AT_MESSAGE_CREATE: "channel",
  MESSAGE_CREATE: "channel",
  DIRECT_MESSAGE_CREATE: "direct",
}

const DELETE_SCENE_BY_EVENT: Record<string, QQScene> = {
  PUBLIC_MESSAGE_DELETE: "channel",
  MESSAGE_DELETE: "channel",
  DIRECT_MESSAGE_DELETE: "direct",
}
export const QQ_MESSAGE_EVENTS = [
  ...Object.keys(SCENE_BY_EVENT),
  ...Object.keys(DELETE_SCENE_BY_EVENT),
]

/** Strip a leading `<@!12345>` channel mention QQ prefixes to AT messages. */
export function stripChannelMention(content: string): string {
  return content.replace(/^\s*<@!?\d+>\s*/, "").trim()
}

function tsToMillis(ts: string | undefined): number {
  if (typeof ts !== "string" || !ts) return Date.now()
  const parsed = Date.parse(ts)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** Normalize legacy bare hosts and protocol-relative attachment URLs once. */
export function qqAttachmentSegments(attachments: unknown): MessageSegment[] {
  if (!Array.isArray(attachments)) return []
  const segments: MessageSegment[] = []
  for (const att of attachments) {
    if (!att || typeof att.url !== "string" || !att.url.trim()) continue
    const raw = att.url.trim()
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) continue
    let url: string
    try {
      const parsed = new URL(
        raw.startsWith("//") ? `https:${raw}` : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      )
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) continue
      url = parsed.href
    } catch {
      continue
    }
    const contentType = typeof att.content_type === "string" ? att.content_type.toLowerCase() : ""
    const name = typeof att.filename === "string" ? att.filename : undefined
    if (contentType.startsWith("image/")) {
      segments.push({
        type: "image",
        url,
        alt: name,
        mimeType: contentType,
        width: typeof att.width === "number" ? att.width : undefined,
        height: typeof att.height === "number" ? att.height : undefined,
      })
    } else if (contentType === "voice" || contentType.startsWith("audio/")) {
      segments.push(
        normalizeInboundVoice({
          url,
          mimeType: contentType === "voice" ? undefined : contentType,
          convertedWavUrl: att.voice_wav_url,
          transcript: att.asr_refer_text,
        })
      )
    } else if (contentType.startsWith("video/")) {
      segments.push({ type: "video", url, mimeType: contentType })
    } else {
      segments.push({
        type: "file",
        url,
        name: name || "attachment",
        mimeType: contentType || "application/octet-stream",
        sizeBytes: typeof att.size === "number" ? att.size : 0,
      })
    }
  }
  return segments
}

/** Indexes are opaque, including base64 padding; never split on every '='. */
export function qqReferenceIndex(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/\s|[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined
}

/** A quote-only index cannot masquerade as a real wire/mutation message ID. */
export function qqReferenceAlias(index: string): string {
  return `qq-ref:${encodeURIComponent(index)}`
}

function sceneIndexes(scene: QQMessageData["message_scene"]): { own?: string; parent?: string } {
  const values = new Map<string, string | undefined>()
  if (Array.isArray(scene?.ext))
    for (const entry of scene.ext.slice(0, 64)) {
      if (typeof entry !== "string") continue
      const separator = entry.indexOf("=")
      const key = entry.slice(0, separator)
      if (separator < 0 || (key !== "msg_idx" && key !== "ref_msg_idx")) continue
      const value = qqReferenceIndex(entry.slice(separator + 1))
      values.set(key, values.has(key) && values.get(key) !== value ? undefined : value)
    }
  return { own: values.get("msg_idx"), parent: values.get("ref_msg_idx") }
}

const ARK_TEXT_FIELDS = ["title", "desc", "source", "tag", "tags", "nickname", "address"] as const
const ARK_URL_FIELDS = ["jump_url", "preview", "source_logo", "tag_icon", "avatar"] as const

function safeQQUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined
  try {
    const parsed = new URL(value)
    return !parsed.username && !parsed.password && evaluateFetchTarget(value).allowed
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function qqContextText(segments: MessageSegment[]): string {
  return segments
    .map((segment) => segmentsToPlainText([segment]).trim())
    .filter(Boolean)
    .join("\n")
}

/** Bounded allowlist: unknown fields and scene auth_token never reach storage/UI. */
function safeQQData(data: QQMessageData): QQMessageData {
  const budget = { nodes: 128, chars: 65_536 }
  const text = (value: unknown, max = 4096): string | undefined => {
    if (typeof value !== "string") return undefined
    const result = value.slice(0, Math.min(max, budget.chars))
    budget.chars -= result.length
    return result || undefined
  }
  const author = (value: QQAuthor | undefined): QQAuthor | undefined =>
    value && typeof value === "object"
      ? {
          id: qqReferenceIndex(value.id),
          member_openid: qqReferenceIndex(value.member_openid),
          user_openid: qqReferenceIndex(value.user_openid),
          username: text(value.username, 256),
          avatar: safeQQUrl(value.avatar),
        }
      : undefined
  function element(value: QQMsgElement, depth: number): QQMsgElement | undefined {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      depth > 8 ||
      budget.nodes-- <= 0
    )
      return undefined
    const safe: QQMsgElement = {
      content: text(value.content, 32_768),
      msg_idx: qqReferenceIndex(value.msg_idx),
      author: author(value.author),
      message_type: Number.isInteger(value.message_type) ? value.message_type : undefined,
    }
    if (Array.isArray(value.attachments))
      safe.attachments = value.attachments.slice(0, 16).flatMap((attachment) => {
        const segment = qqAttachmentSegments([attachment])[0]
        if (!segment || !("url" in segment)) return []
        return [
          {
            url: segment.type === "voice" ? (segment.rawUrl ?? segment.url) : segment.url,
            ...(segment.type === "voice"
              ? {
                  voice_wav_url:
                    segment.mimeType === "audio/wav" && segment.rawUrl ? segment.url : undefined,
                  asr_refer_text: text(segment.transcript, 16_384),
                }
              : {}),
            content_type: text(attachment.content_type, 128),
            filename: text(attachment.filename, 256),
            ...Object.fromEntries(
              ["width", "height", "size"].flatMap((key) => {
                const number = attachment[key as keyof QQAttachmentData]
                return typeof number === "number" && Number.isFinite(number) && number >= 0
                  ? [[key, number]]
                  : []
              })
            ),
          },
        ]
      })
    const ark = value.ark_data
    if (ark && typeof ark === "object" && !Array.isArray(ark)) {
      const fields: Record<string, unknown> = {}
      if (ark.fields && typeof ark.fields === "object" && !Array.isArray(ark.fields)) {
        for (const key of ARK_TEXT_FIELDS) {
          const raw = ark.fields[key]
          const field = Array.isArray(raw)
            ? raw
                .slice(0, 16)
                .map((item) => text(item, 1024))
                .filter(Boolean)
                .join(", ")
            : text(raw, 4096)
          if (field) fields[key] = field
        }
        for (const key of ARK_URL_FIELDS) {
          const url = ark.fields[key]
          if (safeQQUrl(url)) fields[key] = url
        }
      }
      safe.ark_data = {
        prompt: text(ark.prompt),
        ark_type: text(ark.ark_type, 128),
        ark_name: text(ark.ark_name, 256),
        fields,
      }
    }
    if (Array.isArray(value.msg_elements))
      safe.msg_elements = value.msg_elements.slice(0, 128).flatMap((child) => {
        const normalized = element(child, depth + 1)
        return normalized ? [normalized] : []
      })
    return safe
  }
  const indexes = sceneIndexes(data.message_scene)
  return {
    ...element(data, 0),
    id: qqReferenceIndex(data.id),
    timestamp: text(data.timestamp, 128),
    group_openid: qqReferenceIndex(data.group_openid),
    channel_id: qqReferenceIndex(data.channel_id),
    guild_id: qqReferenceIndex(data.guild_id),
    mentions: Array.isArray(data.mentions)
      ? data.mentions.slice(0, 128).flatMap((item) => {
          const normalized = author(item)
          return normalized ? [normalized] : []
        })
      : undefined,
    message_reference: qqReferenceIndex(data.message_reference?.message_id)
      ? { message_id: data.message_reference!.message_id }
      : undefined,
    message_scene: data.message_scene
      ? {
          source: text(data.message_scene.source, 128),
          ext: [
            indexes.own ? `msg_idx=${indexes.own}` : "",
            indexes.parent ? `ref_msg_idx=${indexes.parent}` : "",
          ].filter(Boolean),
        }
      : undefined,
  }
}

/** One normalization owns both model text and the read-only inbound surface. */
export function qqMessageProjection(dispatch: QQDispatch) {
  const data = safeQQData(dispatch.d ?? {})
  const indexes = sceneIndexes(data.message_scene)
  const segments: MessageSegment[] = []
  const nodes: InboundA2UINode[] = []
  function render(
    value: QQMsgElement,
    historical: boolean,
    into: MessageSegment[],
    body: InboundA2UINode[],
    root = false
  ) {
    const fields = value.ark_data?.fields ?? {}
    const cardText = ARK_TEXT_FIELDS.flatMap((key) =>
      typeof fields[key] === "string" ? [fields[key] as string] : []
    )
    const cardTitle = (fields.title || fields.nickname || value.ark_data?.ark_name) as
      string | undefined
    const children: InboundA2UINode[] = cardText
      .filter((item) => item !== cardTitle)
      .map((item) => ({ kind: "text", text: item }))
    if (typeof fields.jump_url === "string")
      children.push({
        kind: "link",
        href: fields.jump_url,
        label: cardTitle || value.ark_data?.ark_type || "Link",
      })
    if (typeof fields.preview === "string")
      children.push({ kind: "image", url: fields.preview, alt: cardTitle })
    const hasCard = Boolean(
      value.ark_data && (cardTitle || children.length || value.ark_data.prompt)
    )
    const rawText = typeof value.content === "string" ? value.content.trim() : ""
    const content =
      root && dispatch.t === "AT_MESSAGE_CREATE" ? stripChannelMention(rawText) : rawText
    if (content && !(hasCard && /^\[卡片消息\]/.test(content))) {
      into.push({ type: "text", text: content })
      body.push({ kind: "text", text: content })
    }
    if (hasCard) {
      if (value.ark_data?.prompt && !cardText.includes(value.ark_data.prompt))
        children.unshift({ kind: "text", text: value.ark_data.prompt })
      body.push({ kind: "card", title: cardTitle, subtitle: value.ark_data?.ark_name, children })
      const summary = [
        value.ark_data?.ark_name || value.ark_data?.ark_type || "ARK",
        ...cardText,
        value.ark_data?.prompt && !cardText.includes(value.ark_data.prompt)
          ? value.ark_data.prompt
          : undefined,
        fields.jump_url,
      ]
        .filter(Boolean)
        .join("\n")
      into.push({ type: "text", text: `[card]\n${summary}` })
    }
    for (const segment of qqAttachmentSegments(value.attachments)) {
      // Chat records and quoted media are historical context, not new model inputs.
      into.push(
        historical && "url" in segment
          ? { type: "text", text: `[${segment.type}] ${segment.url}` }
          : segment
      )
      if (segment.type === "image" && !historical)
        body.push({ kind: "image", url: segment.url, alt: segment.alt })
      else if ("url" in segment)
        body.push({
          kind: "link",
          href: segment.url,
          label:
            segment.type === "file"
              ? segment.name === "attachment"
                ? "Attachment"
                : segment.name
              : segment.type === "voice"
                ? "Voice message"
                : segment.type === "image"
                  ? "Image"
                  : "Video",
        })
    }
    for (const child of value.msg_elements ?? []) {
      const childSegments: MessageSegment[] = [],
        childNodes: InboundA2UINode[] = []
      render(
        child,
        historical || value.message_type === 102 || value.message_type === 103,
        childSegments,
        childNodes
      )
      into.push(...childSegments)
      if (value.message_type === 102)
        body.push({ kind: "card", title: child.author?.username, children: childNodes })
      else body.push(...childNodes)
    }
  }
  const referenceId = indexes.parent
    ? qqReferenceAlias(indexes.parent)
    : data.message_reference?.message_id
  let snippet = ""
  if (referenceId || data.message_type === 103) {
    const quoted: MessageSegment[] = []
    const matches = data.msg_elements?.filter((element) => element.msg_idx === indexes.parent) ?? []
    for (const child of matches.length ? matches : (data.msg_elements ?? []))
      render(child, true, quoted, [])
    snippet = qqContextText(quoted).slice(0, 2048)
    if (referenceId) {
      segments.push({ type: "reply", messageId: referenceId, snippet })
      nodes.push({
        kind: "reply_context",
        replyToMessageId: referenceId,
        ...(snippet ? { preview: snippet } : {}),
      })
    } else if (snippet) {
      segments.push({ type: "text", text: `[quote]\n${snippet}` })
      nodes.push({ kind: "text", text: `[quote]\n${snippet}`, emphasis: "muted" })
    }
    render({ ...data, msg_elements: [] }, false, segments, nodes, true)
  } else render(data, false, segments, nodes, true)
  return {
    segments,
    nodes,
    indexes,
    replyTo: referenceId ? { messageId: referenceId, snippet } : undefined,
    raw: { op: dispatch.op, t: dispatch.t, s: dispatch.s, d: data } satisfies QQDispatch,
  }
}

export function parseQQDispatch(
  adapterId: string,
  selfId: string,
  dispatch: QQDispatch
): NormalizedInboundEvent | null {
  if (!dispatch || typeof dispatch !== "object") return null
  if (dispatch.t === "INTERACTION_CREATE")
    return parseQQSystemInteraction(adapterId, selfId, dispatch)
  if (QQ_AUDIT_EVENTS.includes(dispatch.t)) return parseQQAuditEvent(adapterId, selfId, dispatch)
  if (QQ_SYSTEM_EVENTS.includes(dispatch.t)) return parseQQSystemEvent(adapterId, selfId, dispatch)
  const deletion = DELETE_SCENE_BY_EVENT[dispatch.t]
  const scene = SCENE_BY_EVENT[dispatch.t] ?? deletion
  const d = deletion ? dispatch.d?.message : dispatch.d
  if (!scene || !d || typeof d.id !== "string" || !d.id) return null

  // Resolve the scene-specific addressing id + remote user id.
  let sceneId: string
  let remoteUserId: string
  let channelKind: "private" | "group"
  switch (scene) {
    case "group":
      if (typeof d.group_openid !== "string" || !d.group_openid) return null
      sceneId = d.group_openid
      remoteUserId = d.author?.member_openid ?? d.group_openid
      channelKind = "group"
      break
    case "c2c":
      remoteUserId = typeof d.author?.user_openid === "string" ? d.author.user_openid : ""
      if (!remoteUserId) return null
      sceneId = remoteUserId
      channelKind = "private"
      break
    case "channel":
      if (typeof d.channel_id !== "string" || !d.channel_id) return null
      sceneId = d.channel_id
      remoteUserId = d.author?.id ?? d.channel_id
      channelKind = "group"
      break
    case "direct":
      if (typeof d.guild_id !== "string" || !d.guild_id) return null
      sceneId = d.guild_id
      remoteUserId = d.author?.id ?? d.guild_id
      channelKind = "private"
      break
  }

  // Recall notifications distinguish the operator from the message author.
  const actor = deletion ? dispatch.d?.op_user : d.author
  if (deletion && typeof actor?.id === "string" && actor.id) remoteUserId = actor.id
  const conversationKey = buildConversationKey("qq-official", adapterId, sceneId)
  const sender: PlatformIdentity = {
    id: `qq:${sceneId}:${remoteUserId}`,
    platform: "qq-official",
    adapterId,
    remoteUserId,
    remoteIdType: scene === "channel" || scene === "direct" ? "channel_user" : `${scene}_openid`,
    displayName: typeof actor?.username === "string" ? actor.username : undefined,
    avatarUrl:
      (scene === "channel" || scene === "direct") && typeof actor?.avatar === "string"
        ? actor.avatar
        : undefined,
  }

  const rawText = typeof d.content === "string" ? d.content : ""
  const users = Array.isArray(d.mentions)
    ? d.mentions.flatMap((user) => {
        if (!user || typeof user !== "object") return []
        const id = scene === "group" ? (user.member_openid ?? user.id) : user.id
        return typeof id === "string" && id ? [id] : []
      })
    : []
  const selfMentioned =
    scene === "c2c" ||
    scene === "direct" ||
    dispatch.t === "GROUP_AT_MESSAGE_CREATE" ||
    dispatch.t === "AT_MESSAGE_CREATE" ||
    (Boolean(selfId) &&
      (users.includes(selfId) ||
        [...rawText.matchAll(/<@!?([^>]+)>/g)].some((match) => match[1] === selfId)))
  const projection = qqMessageProjection({ ...dispatch, d })
  const segments = projection.segments

  return {
    platform: "qq-official",
    adapterId,
    selfId,
    messageId: d.id,
    conversationRef: {
      platform: "qq-official",
      adapterId,
      scene,
      sceneId,
      msgId: d.id,
      ...(projection.indexes.own ? { qqMsgIndex: projection.indexes.own } : {}),
      ...(projection.indexes.parent ? { qqReplyIndex: projection.indexes.parent } : {}),
      // Local receipt time — the serializer compares this against the
      // scene's passive-reply window to decide whether msg_id is still
      // usable (see QQ_PASSIVE_WINDOW_MS in serialize.ts).
      receivedAt: Date.now(),
    },
    conversationKey,
    sender,
    channel: { id: conversationKey, kind: channelKind, platformChannelId: sceneId },
    segments: deletion ? [] : segments,
    replyTo: projection.replyTo,
    plainText: deletion ? "" : segmentsToPlainText(segments),
    mentions: { selfMentioned, users },
    timestamp: tsToMillis(d.timestamp),
    raw: projection.raw,
    kind: deletion ? "delete" : "create",
    ...(deletion ? { replacesMessageId: d.id } : {}),
  }
}

export const QQ_SYSTEM_EVENTS = [
  "FRIEND_ADD",
  "FRIEND_DEL",
  "C2C_MSG_RECEIVE",
  "C2C_MSG_REJECT",
  "GROUP_ADD_ROBOT",
  "GROUP_DEL_ROBOT",
  "GROUP_MSG_RECEIVE",
  "GROUP_MSG_REJECT",
  "GROUP_JOIN_REQUEST",
  "GROUP_MEMBER_ADD",
  "GROUP_MEMBER_REMOVE",
]
export const QQ_AUDIT_EVENTS = ["MESSAGE_AUDIT_PASS", "MESSAGE_AUDIT_REJECT"]

function qqRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function qqEventId(value: unknown, max = 512): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0020\u007f-\u009f]/.test(value)
    ? value
    : undefined
}

function parseQQSystemInteraction(
  adapterId: string,
  selfId: string,
  dispatch: QQDispatch
): NormalizedInboundEvent | null {
  const d = qqRecord(dispatch.d),
    data = qqRecord(d.data),
    resolved = qqRecord(data.resolved)
  const type = d.type ?? data.type,
    eventId = qqEventId(d.id)
  if (
    ![12, 13, 14, 15, 16, 18, 19, 20].includes(type as number) ||
    !eventId ||
    (d.type !== undefined && data.type !== undefined && d.type !== data.type)
  )
    return null
  const nativeScene =
    d.scene ??
    (d.chat_type === 1
      ? "group"
      : d.chat_type === 2
        ? "c2c"
        : d.chat_type === 0
          ? "guild"
          : undefined)
  const scene = nativeScene === "guild" ? "channel" : nativeScene
  if (scene !== "c2c" && scene !== "group" && scene !== "channel") return null
  const chatType = scene === "c2c" ? 2 : scene === "group" ? 1 : 0
  if (d.chat_type !== undefined && d.chat_type !== chatType) return null
  const sceneId = qqEventId(
    scene === "c2c" ? d.user_openid : scene === "group" ? d.group_openid : d.channel_id
  )
  const actor = qqEventId(
    scene === "c2c" ? d.user_openid : scene === "group" ? d.group_member_openid : resolved.user_id
  )
  const timestamp = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN
  if (
    !sceneId ||
    (!actor && type !== 20) ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60000
  )
    return null
  let interaction: NonNullable<NormalizedInboundEvent["interaction"]>
  let systemKind: NormalizedInboundEvent["systemKind"] = "interaction"
  const segments: MessageSegment[] = []
  if (type === 12) {
    const featureId = qqEventId(resolved.feature_id)
    if (scene !== "c2c" || !featureId) return null
    interaction = { kind: "menu", featureId }
  } else if (type === 13) {
    const messageId = qqEventId(resolved.message_id, 1024)
    if (
      !messageId ||
      !["LIKE", "UNLIKE"].includes(resolved.feedback_opt as string) ||
      (resolved.checked !== 0 && resolved.checked !== 1)
    )
      return null
    interaction = {
      kind: "feedback",
      messageId: encodeQQMessageId(scene, sceneId, messageId),
      vote: resolved.feedback_opt === "LIKE" ? "positive" : "negative",
      selected: resolved.checked === 1,
    }
    systemKind = interaction.selected ? "reaction_added" : "reaction_removed"
    segments.push({ type: "emoji", code: interaction.vote === "positive" ? "👍" : "👎" })
  } else if (type === 14) interaction = { kind: "session_reset" }
  else if (type === 15) {
    if (resolved.action !== "ENTER_STORY" && resolved.action !== "QUIT_STORY") return null
    interaction = { kind: "story", action: resolved.action === "ENTER_STORY" ? "enter" : "exit" }
  } else if (type === 16) {
    const action = qqEventId(resolved.action, 256)
    if (resolved.action !== undefined && !action) return null
    interaction = { kind: "model_change", ...(action ? { action } : {}) }
  } else {
    const auth = qqRecord(resolved.authorize_data)
    if ((type === 18 && scene !== "c2c") || (type === 19 && scene !== "group")) return null
    const expectedScope =
      scene === "c2c" ? "c2c_push" : scene === "group" ? "group_push" : undefined
    if (auth.scope !== undefined && auth.scope !== expectedScope) return null
    if (auth.opt_scene !== undefined && auth.opt_scene !== "setting" && auth.opt_scene !== "dialog")
      return null
    // The documented scope carries no explicit grant/revoke result. Never infer consent.
    interaction = {
      kind: "authorization",
      state: "unknown",
      ...(auth.scope ? { scope: "proactive" as const } : {}),
      ...(auth.opt_scene
        ? { source: auth.opt_scene === "setting" ? ("settings" as const) : ("dialog" as const) }
        : {}),
    }
  }
  const remoteUserId = (actor ?? selfId) || "qq-system"
  const safe = { type, interaction }
  return {
    platform: "qq-official",
    adapterId,
    selfId,
    originEventId: `interaction:${eventId}`,
    messageId: eventId,
    kind: "system",
    systemKind,
    interaction,
    canReplyToMessage: false,
    ...(type === 12 ? { passiveEvent: { id: eventId, expiresAt: timestamp + 300000 } } : {}),
    ...(interaction.kind === "feedback" ? { replacesMessageId: interaction.messageId } : {}),
    conversationKey: buildConversationKey("qq-official", adapterId, sceneId),
    conversationRef: {
      platform: "qq-official",
      adapterId,
      scene,
      sceneId,
      ...(type === 12 ? { eventId } : {}),
      receivedAt: timestamp,
    },
    sender: {
      id: `qq:${sceneId}:${remoteUserId}`,
      platform: "qq-official",
      adapterId,
      remoteUserId,
      ...(actor ? {} : { kind: "system" as const }),
    },
    channel: {
      id: sceneId,
      platformChannelId: sceneId,
      kind: scene === "c2c" ? "private" : scene === "group" ? "group" : "channel",
    },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp,
    channelData: { eventType: dispatch.t, interactionType: type },
    raw: { op: 0, t: dispatch.t, d: safe },
  }
}

function parseQQAuditEvent(
  adapterId: string,
  selfId: string,
  dispatch: QQDispatch
): NormalizedInboundEvent | null {
  const d = qqRecord(dispatch.d),
    receiptId = qqEventId(d.audit_id),
    sceneId = qqEventId(d.channel_id),
    guildId = qqEventId(d.guild_id)
  const delivered = dispatch.t === "MESSAGE_AUDIT_PASS",
    messageId = qqEventId(d.message_id, 1024)
  const timestamp = typeof d.audit_time === "string" ? Date.parse(d.audit_time) : NaN
  if (
    !receiptId ||
    !sceneId ||
    !guildId ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60000 ||
    (delivered && !messageId)
  )
    return null
  const deliveryStatus = {
    receiptId,
    status: delivered ? ("delivered" as const) : ("rejected" as const),
    ...(messageId ? { platformMessageId: encodeQQMessageId("channel", sceneId, messageId) } : {}),
  }
  const occurrence = qqEventId(dispatch.id) ?? `audit:${receiptId}:${deliveryStatus.status}`
  return {
    platform: "qq-official",
    adapterId,
    selfId,
    kind: "system",
    systemKind: "delivery_status",
    deliveryStatus,
    originEventId: occurrence,
    messageId: occurrence,
    canReplyToMessage: false,
    conversationKey: buildConversationKey("qq-official", adapterId, sceneId),
    conversationRef: {
      platform: "qq-official",
      adapterId,
      scene: "channel",
      sceneId,
      guildId,
      receivedAt: timestamp,
    },
    sender: {
      id: `qq:${selfId || adapterId}:system`,
      platform: "qq-official",
      adapterId,
      remoteUserId: selfId || adapterId,
      kind: "system",
    },
    channel: { id: sceneId, platformChannelId: sceneId, kind: "channel" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp,
    raw: { op: 0, t: dispatch.t, d: { deliveryStatus } },
  }
}
function parseQQSystemEvent(
  adapterId: string,
  selfId: string,
  dispatch: QQDispatch
): NormalizedInboundEvent | null {
  const raw = dispatch.d as unknown as Record<string, unknown> | undefined
  if (!raw || typeof raw !== "object") return null
  const group = dispatch.t.startsWith("GROUP_"),
    scene = group ? "group" : "c2c"
  const text = (value: unknown, max = 512) =>
    typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
      ? value
      : undefined
  const sceneId = text(group ? raw.group_openid : raw.openid)
  const actorId = text(raw.member_openid ?? raw.op_member_openid ?? raw.openid) ?? sceneId
  const eventId = text(dispatch.id),
    requestId = text(raw.join_request_id)
  if (!sceneId || !actorId) return null
  const timestamp =
    typeof raw.timestamp === "number"
      ? raw.timestamp * 1000
      : typeof raw.apply_at === "string"
        ? Date.parse(raw.apply_at)
        : NaN
  if (!Number.isFinite(timestamp)) return null
  const mayReply =
    ["FRIEND_ADD", "C2C_MSG_RECEIVE", "GROUP_ADD_ROBOT", "GROUP_MSG_RECEIVE"].includes(
      dispatch.t
    ) && Boolean(eventId)
  const occurrence =
    eventId ??
    (requestId
      ? `join:${requestId}:${raw.auto_approved ? "approved" : "pending"}`
      : `${dispatch.t}:${actorId}:${timestamp}`)
  const consent = /_MSG_RECEIVE$/.test(dispatch.t)
    ? true
    : /_MSG_REJECT$|FRIEND_DEL|GROUP_DEL_ROBOT/.test(dispatch.t)
      ? false
      : undefined
  const verify =
    raw.verify_info && typeof raw.verify_info === "object"
      ? (raw.verify_info as Record<string, unknown>)
      : {}
  // Attribution is carried as data only. Neither it nor a share short code
  // can supply a passive event id, message id, identity or proactive consent.
  const friendAdd = dispatch.t === "FRIEND_ADD"
  const referralSource =
    friendAdd && Number.isSafeInteger(raw.scene) && Number(raw.scene) >= 0
      ? String(raw.scene)
      : undefined
  const referralState =
    friendAdd &&
    typeof raw.scene_param === "string" &&
    raw.scene_param.length <= 128 &&
    [...raw.scene_param].length <= 32 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(raw.scene_param)
      ? raw.scene_param
      : undefined
  const referral =
    friendAdd && (referralSource !== undefined || referralState !== undefined)
      ? {
          ...(referralSource !== undefined ? { source: referralSource } : {}),
          ...(referralState !== undefined ? { state: referralState } : {}),
        }
      : undefined
  const shortCode = friendAdd ? text(raw.short_code) : undefined
  const safeData = {
    eventType: dispatch.t,
    ...(friendAdd
      ? {
          friendAdd: {
            ...(referralSource !== undefined ? { scene: Number(raw.scene) } : {}),
            ...(shortCode ? { shortCode } : {}),
          },
        }
      : {}),
    ...(referral ? { referral } : {}),
    ...(requestId
      ? {
          joinRequest: {
            id: requestId,
            memberId: actorId,
            autoApproved: Boolean(raw.auto_approved),
            riskTips: text(raw.risk_tips, 4096),
            verification: {
              method: text(verify.method),
              message: text(verify.verify_message, 4096),
              questions: Array.isArray(verify.review_qa_list)
                ? verify.review_qa_list.slice(0, 20).map((q) => ({
                    question: text(q?.question, 4096),
                    answer: text(q?.answer, 4096),
                  }))
                : [],
            },
          },
        }
      : {}),
  }
  return {
    platform: "qq-official",
    adapterId,
    selfId,
    messageId: occurrence,
    originEventId: occurrence,
    kind: "system",
    ...(referral ? { referral } : {}),
    systemKind: dispatch.t === "GROUP_JOIN_REQUEST" && !raw.auto_approved ? "request" : "lifecycle",
    canReplyToMessage: false,
    ...(mayReply ? { passiveEvent: { id: eventId!, expiresAt: timestamp + 300000 } } : {}),
    ...(consent !== undefined ? { deliveryPermissionChange: { proactive: consent } } : {}),
    conversationKey: buildConversationKey("qq-official", adapterId, sceneId),
    conversationRef: {
      platform: "qq-official",
      adapterId,
      scene,
      sceneId,
      ...(mayReply ? { eventId } : {}),
      receivedAt: timestamp,
    },
    sender: {
      id: `qq:${sceneId}:${actorId}`,
      platform: "qq-official",
      adapterId,
      remoteUserId: actorId,
      displayName: text(raw.username, 256),
    },
    channel: { id: sceneId, platformChannelId: sceneId, kind: group ? "group" : "private" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp,
    channelData: safeData,
    raw: { op: 0, t: dispatch.t, ...(eventId ? { id: eventId } : {}), d: safeData },
  }
}
