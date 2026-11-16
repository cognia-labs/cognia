/** Host-only audience resolution and recipient narrowing for ADR-0243. */
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { SinkAudienceV1 } from "@cognia/plugin-contract/types/execution/personal-sink"
import {
  checkPersonalSink,
  readHostPersonContext,
  readRunPersonalTaint,
  explicitHostPersonalSinkContext,
  type PersonalSinkContext,
} from "@/lib/execution/personal-sink"
import { samePersonForHost } from "@/lib/execution/personal-visibility"
import type { OutboundTarget } from "@/lib/policy/action-review/outbound-targets"
import type { OutboundRequest, PlatformAdapter } from "@/types/connectors"
import { buildConversationKey, parseConversationKey } from "@/types/connectors/event"
import { resolveScheduledNoticeI18n } from "./scheduled-notice-i18n"

async function runningAdapter(adapterId: string): Promise<PlatformAdapter | undefined> {
  const { getBus } = await import("./bus")
  return getBus().getAdapter(adapterId)
}

/** A conversation key alone proves no membership. Only the live adapter resolves its peer. */
export async function resolveConnectorSinkAudience(
  adapterId: string,
  conversationKey?: string,
  recipients?: readonly OutboundTarget[],
  adapter?: PlatformAdapter
): Promise<SinkAudienceV1> {
  adapter ??= await runningAdapter(adapterId)
  if (!adapter || !["lark", "slack"].includes(adapter.meta.type))
    return { kind: "unknown", label: `connector:${adapterId}` }
  if (recipients) {
    const prefix = `person:${adapterId}:`
    const people = recipients.flatMap((target): PrincipalRefV1[] =>
      target.kind === "person" &&
      target.channel === adapterId &&
      target.recipient.startsWith(prefix)
        ? [
            {
              kind: "platform",
              platform: adapter!.meta.type,
              adapterId,
              remoteUserId: target.recipient.slice(prefix.length),
            },
          ]
        : []
    )
    if (!people.length || people.length !== recipients.length)
      return { kind: "unknown", label: "connector recipients" }
    return people.length === 1
      ? { kind: "person", person: people[0] }
      : { kind: "group", members: people }
  }
  if (!conversationKey || !adapter.resolvePersonalAudience)
    return { kind: "unknown", label: "unresolved connector conversation" }
  try {
    const key = parseConversationKey(conversationKey)
    if (key.adapterId !== adapterId || key.platform !== adapter.meta.type)
      return { kind: "unknown", label: "mismatched connector conversation" }
    const resolved = await adapter.resolvePersonalAudience(conversationKey)
    if (adapter.meta.type === "slack" && resolved.kind === "person") {
      const host = await readHostPersonContext()
      if (!host.connectedOwners.some((owner) => samePersonForHost(owner, resolved.person, host)))
        return { kind: "unknown", label: "Slack IM peer is not a verified connected owner" }
    }
    return resolved
  } catch {
    return { kind: "unknown", label: "unverified connector conversation" }
  }
}

/** Fixed text never includes the protected payload, names, identifiers or snippets. */
export async function personalDeliveryNotice(narrowed: boolean): Promise<string> {
  const { readAppSettings } = await import("@/lib/policy/action-review/plan-context")
  const settings = await readAppSettings().catch(() => undefined)
  return resolveScheduledNoticeI18n(
    (settings as { language?: string } | undefined)?.language
  ).personalDelivery(narrowed)
}

/** Content-free observer delivery: failure must never cause protected content to be resent. */
export async function sendPersonalDeliveryNotice(
  adapter: PlatformAdapter | undefined,
  conversationKey: string,
  original: OutboundRequest,
  sentPrivately: boolean
): Promise<void> {
  if (!adapter) return
  const notice: OutboundRequest = {
    conversationRef: original.conversationRef,
    deliveryTarget: original.deliveryTarget,
    segments: [{ type: "text", text: await personalDeliveryNotice(sentPrivately) }],
    metadata: {
      idempotencyKey: original.metadata.idempotencyKey.endsWith(":personal-notice")
        ? original.metadata.idempotencyKey
        : `${original.metadata.idempotencyKey}:personal-notice`,
    },
  }
  const decision = await checkConnectorPersonalSink(
    explicitHostPersonalSinkContext("fixed-notice"),
    adapter.id,
    conversationKey,
    notice,
    { request: notice, adapter }
  )
  if (decision.outcome !== "allow") return
  const { enqueueGoverned } = await import("./delivery-gateway")
  await enqueueGoverned({
    adapterId: adapter.id,
    conversationKey,
    request: notice,
    source: "manual",
    personalContext: explicitHostPersonalSinkContext("fixed-notice"),
  })
}

/** A fresh request cannot retain reply/edit/thread routing to the original audience. */
export async function narrowPersonalDelivery(
  adapter: PlatformAdapter | undefined,
  conversationKey: string,
  request: OutboundRequest,
  person: PrincipalRefV1
): Promise<{ conversationKey: string; request: OutboundRequest } | undefined> {
  if (!adapter) return undefined
  const host = await readHostPersonContext()
  const reachable =
    person.kind === "platform" &&
    person.adapterId === adapter.id &&
    person.platform === adapter.meta.type
      ? person
      : host.connectedOwners.find(
          (owner) =>
            owner.kind === "platform" &&
            owner.adapterId === adapter.id &&
            samePersonForHost(owner, person, host)
        )
  if (reachable?.kind !== "platform") return undefined
  const metadata = { ...request.metadata }
  for (const key of [
    "pendingPlacement",
    "sourceMessageId",
    "streamKey",
    "larkEphemeral",
    "replyTo",
    "threadId",
    "editTargetMessageId",
  ])
    delete (metadata as Record<string, unknown>)[key]
  if (metadata.resultCard) {
    metadata.resultCard = { ...metadata.resultCard }
    delete metadata.resultCard.sourceMessageId
  }
  const key = parseConversationKey(conversationKey)
  const audience = await resolveConnectorSinkAudience(
    adapter.id,
    conversationKey,
    undefined,
    adapter
  )
  if (
    adapter.meta.type === "lark" &&
    audience.kind === "group" &&
    adapter.meta.capabilities.includes("send.ephemeral") &&
    /^ou_[A-Za-z0-9_-]+$/.test(reachable.remoteUserId)
  ) {
    // Ephemeral supports cards only. Preserve all content; attachments require a DM.
    const text = request.segments.map((segment) =>
      segment.type === "text" ? segment.text : segment.type === "markdown" ? segment.md : undefined
    )
    if (text.every((value) => value !== undefined)) {
      const ref = { platform: "lark" as const, adapterId: adapter.id, channelId: key.remoteChatId }
      return {
        conversationKey: buildConversationKey("lark", adapter.id, key.remoteChatId),
        request: {
          conversationRef: ref,
          segments: [
            {
              type: "card",
              card: {
                kind: "lark",
                payload: {
                  schema: "2.0",
                  body: { elements: [{ tag: "markdown", content: text.join("\n\n") }] },
                },
              },
            },
          ],
          metadata: {
            ...metadata,
            larkEphemeral: { recipientOpenId: reachable.remoteUserId },
          },
        },
      }
    }
  }
  // A direct message reaches the marked person of this adapter themself (their
  // own data in their own turn, ADR-0243 phase 4) or the Host-verified owner.
  if (
    reachable !== person &&
    !host.connectedOwners.some((owner) => samePersonForHost(owner, reachable, host))
  )
    return undefined
  if (adapter.meta.type === "lark") {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(reachable.remoteUserId)) return undefined
    const target = buildConversationKey("lark", adapter.id, reachable.remoteUserId)
    return {
      conversationKey: target,
      request: {
        conversationRef: {
          platform: "lark",
          adapterId: adapter.id,
          channelId: reachable.remoteUserId,
        },
        segments: request.segments,
        metadata: metadata,
      },
    }
  }
  if (adapter.meta.type === "slack" && adapter.personalDirectConversation) {
    const target = await adapter.personalDirectConversation(reachable.remoteUserId)
    if (!target) return undefined
    const chat = parseConversationKey(target)
    if (chat.platform !== "slack" || chat.adapterId !== adapter.id) return undefined
    return {
      conversationKey: target,
      request: {
        conversationRef: { platform: "slack", adapterId: adapter.id, channelId: chat.remoteChatId },
        segments: request.segments,
        metadata: metadata,
      },
    }
  }
  return undefined
}

export async function checkConnectorPersonalSink(
  context: PersonalSinkContext,
  adapterId: string,
  conversationKey: string | undefined,
  payload: unknown,
  options: {
    recipients?: readonly OutboundTarget[]
    request?: OutboundRequest
    canNarrow?: boolean
    adapter?: PlatformAdapter
  } = {}
) {
  const opaqueMedia = options.request?.segments?.some((segment) =>
    ["file", "image", "video", "audio", "voice"].includes(segment.type)
  )
  const checkedPayload = opaqueMedia ? undefined : payload
  const target = {
    adapterId,
    conversationKey,
    ...(options.recipients ? { recipients: options.recipients } : {}),
  }
  const taint = await readRunPersonalTaint(context)
  // No audience lookup may borrow a connected person's credentials for an
  // unverified run. Re-read at the central boundary so a concurrent new mark
  // still withholds/narrows before content can leave.
  if (!taint.verified || !taint.marks.length)
    return checkPersonalSink(
      context,
      { kind: "unknown", label: "connector audience not needed" },
      checkedPayload,
      target,
      { canNarrow: options.canNarrow, taint }
    )
  const adapter = options.adapter ?? (await runningAdapter(adapterId))
  const ephemeral = options.request?.metadata?.larkEphemeral
  const audience: SinkAudienceV1 =
    ephemeral && adapter?.meta.type === "lark"
      ? {
          kind: "person",
          person: {
            kind: "platform",
            platform: "lark",
            adapterId,
            remoteUserId: ephemeral.recipientOpenId,
          },
        }
      : await resolveConnectorSinkAudience(adapterId, conversationKey, options.recipients, adapter)
  // URL/path-backed media can change between planning and upload. A receipt
  // must not pretend a descriptor is the exact attachment bytes for disclosure.
  return checkPersonalSink(
    context,
    audience,
    checkedPayload,
    {
      adapterId,
      conversationKey,
      ...(options.recipients ? { recipients: options.recipients } : {}),
    },
    { canNarrow: options.canNarrow, taint }
  )
}
