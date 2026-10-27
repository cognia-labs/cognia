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
import { isPublicHttpUrl } from "../_shared/inbound-media"

export type QQScene = "group" | "c2c" | "channel" | "direct"

export interface QQAuthor {
  id?: string
  username?: string
  avatar?: string
  member_openid?: string
  user_openid?: string
}

export interface QQAttachmentData {
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
      segments.push({
        type: "voice",
        url,
        mimeType: contentType === "voice" ? undefined : contentType,
      })
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
    return !parsed.username && !parsed.password && isPublicHttpUrl(value) ? value : undefined
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
            url: segment.url,
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
