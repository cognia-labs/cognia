/** Private disclosure cards and Host replay. Presentation is separate from sink authority. */
import type { PersonalSinkContext } from "@/lib/execution/personal-sink"
import {
  recordPersonalSinkReceipt,
  readRunPersonalTaint,
  explicitHostPersonalSinkContext,
} from "@/lib/execution/personal-sink"
import {
  declaredRecipientsCoverDisclosure,
  personalDisclosureHash,
  personalDisclosureMessageHash,
  personalDisclosureContext,
  requestMatchesPersonalDisclosureTarget,
  type PendingPersonalDisclosure,
  type PersonalDisclosureTarget,
} from "@/lib/execution/personal-disclosure"
import { getDb } from "@/lib/db/schema"
import { stableJson } from "@/lib/account-sync/data/stable-json"
import type { PrincipalRefV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import type { StoredMessage } from "@cognia/agent-config-types"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import type { OutboundRequest } from "@/types/connectors"
import type {
  ConnectorCallbackBindingRow,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { recordCallbackBinding, buildActionId } from "./adapters/_shared/a2ui-mapper"
import { buildA2UISegment } from "./a2ui-bridge/a2ui-to-segments"
import { resolveScheduledNoticeI18n } from "./scheduled-notice-i18n"
import { authorizeConnectorCallback, actorScopeSatisfied } from "./callback-authorization"
import { parseConversationKey } from "@/types/connectors/event"
import { normalizeToolId } from "@/lib/policy/risk/outbound-tools"

const DISCLOSURE_TTL = 24 * 60 * 60 * 1000

/** Only literal connector messages can be replayed; never run the withheld tool. */
export async function offerPersonalToolDisclosure(
  context: PersonalSinkContext,
  toolName: string,
  input: unknown,
  requestId: string
): Promise<boolean> {
  if (
    !["connector_send", "connectors_send_message"].includes(normalizeToolId(toolName)) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return false
  const args = input as Record<string, unknown>
  if (
    Object.keys(args).some(
      (key) => !["adapterId", "conversationKey", "text", "segments"].includes(key)
    ) ||
    typeof args.conversationKey !== "string"
  )
    return false
  let segments: OutboundRequest["segments"]
  if (typeof args.text === "string" && args.segments === undefined)
    segments = [{ type: "text", text: args.text }]
  else if (
    Array.isArray(args.segments) &&
    args.text === undefined &&
    args.segments.length &&
    args.segments.every(
      (segment) =>
        segment &&
        typeof segment === "object" &&
        ((segment.type === "text" &&
          typeof segment.text === "string" &&
          Object.keys(segment).every((key) => ["type", "text"].includes(key))) ||
          (segment.type === "markdown" &&
            typeof segment.md === "string" &&
            Object.keys(segment).every((key) => ["type", "md"].includes(key))))
    )
  )
    segments = structuredClone(args.segments)
  else return false
  let key: ReturnType<typeof parseConversationKey>
  try {
    key = parseConversationKey(args.conversationKey)
  } catch {
    return false
  }
  if (args.adapterId !== undefined && args.adapterId !== key.adapterId) return false
  const { getBus } = await import("./bus")
  const adapter = getBus().getAdapter(key.adapterId)
  if (!adapter) return false
  const { resolveConnectorSinkAudience, narrowPersonalDelivery, sendPersonalDeliveryNotice } =
    await import("./personal-delivery")
  const audience = await resolveConnectorSinkAudience(
    key.adapterId,
    args.conversationKey,
    undefined,
    adapter
  )
  if (audience.kind !== "group") return false
  const taint = await readRunPersonalTaint(context)
  if (!taint.verified || !taint.marks.length) return false
  const { samePersonForHost } = await import("@/lib/execution/personal-visibility")
  const { readHostPersonContext } = await import("@/lib/execution/personal-sink")
  const host = await readHostPersonContext()
  const person = taint.marks[0].person
  if (!taint.marks.every((mark) => samePersonForHost(mark.person, person, host))) return false
  const request: OutboundRequest = {
    conversationRef: {
      platform: key.platform,
      adapterId: key.adapterId,
      channelId: key.remoteChatId,
      ...(key.threadId ? { threadId: key.threadId } : {}),
    },
    segments,
    metadata: { idempotencyKey: `personal-tool:${requestId}` },
  }
  const narrowed = await narrowPersonalDelivery(adapter, args.conversationKey, request, person)
  if (!narrowed) return false
  const prepared = await attachPersonalDisclosure(
    context,
    { adapterId: key.adapterId, conversationKey: args.conversationKey },
    request,
    narrowed,
    [person]
  )
  // A no-card result (e.g. missing session or bound-person lane) stays withheld.
  if (stableJson(prepared) === stableJson(narrowed)) return false
  const { enqueueGoverned } = await import("./delivery-gateway")
  await enqueueGoverned({
    adapterId: key.adapterId,
    ...prepared,
    source: "ai-run",
    authorization: { kind: "origin-reply", inboundConversationKey: prepared.conversationKey },
    personalContext: context,
  })
  await sendPersonalDeliveryNotice(adapter, args.conversationKey, request, true)
  return true
}
async function labels() {
  const { readAppSettings } = await import("@/lib/policy/action-review/plan-context")
  const settings = await readAppSettings().catch(() => undefined)
  return resolveScheduledNoticeI18n((settings as { language?: string } | undefined)?.language)
}

export async function attachPersonalDisclosure(
  context: PersonalSinkContext,
  originalTarget: PersonalDisclosureTarget,
  originalRequest: OutboundRequest,
  narrowed: { conversationKey: string; request: OutboundRequest },
  persons: PrincipalRefV1[]
): Promise<typeof narrowed> {
  // Mutable external media and edit operations never receive a replay card.
  if (
    originalRequest.editTargetMessageId ||
    originalRequest.segments.some((segment) =>
      ["file", "image", "video", "audio", "voice"].includes(segment.type)
    )
  )
    return narrowed
  const db = getDb()
  const taint = await readRunPersonalTaint(context)
  if (!taint.verified || !taint.marks.length || !persons.length) return narrowed
  persons = [...new Map(taint.marks.map((mark) => [stableJson(mark.person), mark.person])).values()]
  if (!requestMatchesPersonalDisclosureTarget(originalRequest, originalTarget)) return narrowed
  const contexts = [context],
    seen = new Set<PersonalSinkContext>(),
    sessions = new Set<string>()
  let bound = taint.marks.some((mark) => mark.source === "bound-person")
  while (contexts.length) {
    const source = contexts.pop()!
    if (seen.has(source) || seen.size >= 32) return narrowed
    seen.add(source)
    if (source.personalSources) {
      contexts.push(...source.personalSources)
      continue
    }
    const run = source.executionRunId
      ? await db.executionRuns.get(source.executionRunId)
      : undefined
    bound ||= run?.actingIdentity?.lane === "bound-person"
    const id = source.sessionId ?? run?.sessionId
    if (id && (await db.sessions.get(id))) sessions.add(id)
  }
  if (sessions.size !== 1) return narrowed
  const sessionId = [...sessions][0]
  const lane = bound ? "bound-person" : "delegated"
  if (!declaredRecipientsCoverDisclosure({ lane, target: originalTarget })) return narrowed
  const receiptId = await recordPersonalSinkReceipt(
    context,
    persons,
    "withheld",
    originalRequest,
    originalTarget
  )
  const contentHash = await personalDisclosureHash(originalRequest)
  const textParts = originalRequest.segments.map((segment) => ({
    type: "text" as const,
    text:
      segment.type === "text"
        ? segment.text
        : segment.type === "markdown"
          ? segment.md
          : stableJson(segment),
  }))
  const candidateId = originalRequest.metadata.idempotencyKey.startsWith("airun:")
    ? originalRequest.metadata.idempotencyKey.slice(6)
    : undefined
  const candidate = candidateId ? await db.messages.get(candidateId) : undefined
  // A tool-bearing original is not disclosed wholesale. Persist the exact
  // delivered projection as a separate marked message in that same session.
  const exactCandidate =
    candidate?.sessionId === sessionId &&
    candidate.parts.every((part) => part.type === "text") &&
    stableJson(candidate.parts) === stableJson(textParts)
  const message: StoredMessage = exactCandidate
    ? candidate
    : {
        id: `personal-disclosure:${receiptId}`,
        sessionId,
        role: "assistant",
        parts: textParts,
        createdAt: Date.now(),
        metadata: { personalMarkVersion: 1, personalMarks: taint.marks },
      }
  const messageHash = await personalDisclosureMessageHash(message)
  const now = Date.now()
  const pending: PendingPersonalDisclosure = {
    request: structuredClone(originalRequest),
    contentHash,
    originalTarget: structuredClone(originalTarget),
    persons: structuredClone(persons),
    context: structuredClone(context),
    sessionId,
    messageId: message.id,
    messageHash,
    createdAt: now,
    expiresAt: now + DISCLOSURE_TTL,
    lane,
    privateEphemeral: !!narrowed.request.metadata.larkEphemeral,
  }
  await db.transaction("rw", db.actionReviewReceipts, db.messages, async () => {
    const row = await db.actionReviewReceipts.get(receiptId)
    if (!row?.personal?.contentHash || row.personal.contentHash !== contentHash)
      throw new Error("PERSONAL_DISCLOSURE_RECEIPT_MISMATCH")
    if (row.personalDisclosurePending) return
    if (!exactCandidate) await db.messages.add(message)
    await db.actionReviewReceipts.update(receiptId, { personalDisclosurePending: pending })
  })
  const stored = (await db.actionReviewReceipts.get(receiptId))?.personalDisclosurePending
  if (!stored || stored.closedAt !== undefined || stored.expiresAt <= Date.now()) return narrowed
  const surfaceId = `personal_disclosure:${receiptId}`
  const i18n = await labels()
  const actorScope = { mode: "marked-person" as const, persons }
  const components: Record<string, unknown> = {
    root: { component: "Column", children: ["share", "private"] },
  }
  for (const [componentId, action, text] of [
    ["share", "share", i18n.personalShare],
    ["private", "private", i18n.personalKeepPrivate],
  ]) {
    const payload = { receiptId, decision: action }
    components[componentId] = {
      component: "Button",
      text,
      action,
      bindingKind: "personal_disclosure",
      bindingPayload: payload,
      bindingActorScope: actorScope,
      bindingAllowedActions: [action],
      bindingExpiresAt: stored.expiresAt,
    }
    await recordCallbackBinding({
      adapterId: originalTarget.adapterId,
      actionId: buildActionId(surfaceId, componentId, action),
      surfaceId,
      componentId,
      conversationKey: narrowed.conversationKey,
      kind: "personal_disclosure",
      payload,
      actorScope,
      allowedActions: [action],
      expiresAt: stored.expiresAt,
    })
  }
  const surface: A2UISegmentContent = { rootId: "root", components, dataModel: {} }
  const request = structuredClone(narrowed.request)
  // Private delivery and the later exact original replay are distinct sends.
  if (!request.metadata.idempotencyKey.endsWith(":personal-private"))
    request.metadata.idempotencyKey += ":personal-private"
  if (request.metadata.larkEphemeral) {
    const { buildLarkA2UICard } = await import("./adapters/lark/card")
    const card = await buildLarkA2UICard({
      adapterId: originalTarget.adapterId,
      conversationKey: narrowed.conversationKey,
      surfaceId,
      surface,
    })
    const actions = JSON.parse(card.content) as { body: { elements: unknown[] } }
    const first = request.segments[0]
    if (first?.type !== "card" || first.card.kind !== "lark")
      throw new Error("PERSONAL_DISCLOSURE_EPHEMERAL_CARD_REQUIRED")
    const payload = first.card.payload as { body: { elements: unknown[] } }
    payload.body.elements.push(...actions.body.elements)
  } else request.segments.push(buildA2UISegment(surfaceId, surface))
  return { ...narrowed, request }
}

/** The binding, never event.payload, supplies the receipt and the chosen action. */
export async function handlePersonalDisclosureCallback(
  event: ConnectorCallbackEvent,
  binding: ConnectorCallbackBindingRow
): Promise<boolean> {
  const db = getDb()
  const current = await db.connectorCallbackBindings.get(binding.id)
  if (
    !current ||
    current.kind !== "personal_disclosure" ||
    current.actorScope?.mode !== "marked-person"
  )
    throw new Error("PERSONAL_DISCLOSURE_BINDING_MISSING")
  const auth = await authorizeConnectorCallback({
    event,
    binding: current,
    adapterRow: await db.adapterInstances.get(event.adapterId),
    resolvedConversationKey: event.conversationKey ?? null,
    kindClass: "personal_disclosure",
  })
  if (!auth.allowed) throw new Error(`PERSONAL_DISCLOSURE_${auth.reason}`)
  const receiptId = current.payload?.receiptId
  const decision = current.payload?.decision
  if (typeof receiptId !== "string" || !["share", "private"].includes(String(decision)))
    throw new Error("PERSONAL_DISCLOSURE_INVALID_ACTION")
  const row = await db.actionReviewReceipts.get(receiptId)
  const pending = row?.personalDisclosurePending
    ? structuredClone(row.personalDisclosurePending)
    : undefined
  if (
    !pending ||
    !row?.personal?.contentHash ||
    pending.closedAt !== undefined ||
    pending.expiresAt <= Date.now() ||
    pending.contentHash !== row.personal.contentHash ||
    (await personalDisclosureHash(pending.request)) !== row.personal.contentHash ||
    stableJson(pending.originalTarget) !== stableJson(row.personal.originalTarget) ||
    stableJson(pending.persons) !== stableJson(row.personal.persons) ||
    stableJson(current.actorScope.persons) !== stableJson(pending.persons) ||
    !requestMatchesPersonalDisclosureTarget(pending.request, pending.originalTarget) ||
    !declaredRecipientsCoverDisclosure({ lane: pending.lane, target: pending.originalTarget })
  )
    throw new Error("PERSONAL_DISCLOSURE_EXPIRED_OR_CHANGED")
  const actor = {
    kind: "platform" as const,
    platform: event.platform,
    adapterId: event.adapterId,
    remoteUserId: event.user.remoteUserId,
  }
  // Display labels carry no authority and never fall back to platform ids.
  pending.grantedName = event.user.displayName?.replace(/[\r\n<>]/g, " ").slice(0, 80) ?? ""
  if ([event.user.remoteUserId, event.user.id].includes(pending.grantedName))
    pending.grantedName = ""
  if (event.originatingMessageId && event.conversationKey)
    pending.callbackCard = {
      conversationKey: event.conversationKey,
      messageId: event.originatingMessageId,
    }
  const snapshot = stableJson(row)
  await db.transaction(
    "rw",
    db.actionReviewReceipts,
    db.connectorCallbackBindings,
    db.adapterInstances,
    async () => {
      const live = await db.actionReviewReceipts.get(receiptId)
      const liveBinding = await db.connectorCallbackBindings.get(current.id)
      if (
        !live ||
        stableJson(live) !== snapshot ||
        !liveBinding ||
        liveBinding.consumedAt !== undefined ||
        liveBinding.expiresAt! <= Date.now() ||
        stableJson(liveBinding) !== stableJson(current) ||
        live.personal?.disclosure
      )
        throw new Error("PERSONAL_DISCLOSURE_CONSUMED_OR_CHANGED")
      if (!(await actorScopeSatisfied(current.actorScope!, event, [], true)))
        throw new Error("PERSONAL_DISCLOSURE_ACTOR_CHANGED")
      const now = Date.now()
      await db.connectorCallbackBindings
        .where("adapterId")
        .equals(event.adapterId)
        .filter(
          (item) => item.surfaceId === current.surfaceId && item.kind === "personal_disclosure"
        )
        .modify({ consumedAt: now })
      if (decision === "private")
        await db.actionReviewReceipts.update(receiptId, {
          personalDisclosurePending: { ...pending, closedAt: now },
        })
      else
        await db.actionReviewReceipts.update(receiptId, {
          personalDisclosurePending: pending,
          personal: {
            ...live.personal!,
            disclosure: {
              grantedBy: actor,
              grantedAt: now,
              target: pending.originalTarget,
              contentHash: pending.contentHash,
              expiresAt: pending.expiresAt,
            },
          },
        })
    }
  )
  const { enqueueGoverned } = await import("./delivery-gateway")
  if (decision === "share") {
    const context = personalDisclosureContext(pending.context, receiptId, db)
    const sent = await enqueueGoverned({
      ...pending.originalTarget,
      request: pending.request,
      source: "ai-run",
      authorization: {
        kind: "origin-reply",
        inboundConversationKey: pending.originalTarget.conversationKey,
      },
      personalContext: context,
    })
    if (sent.personalDisclosureReceiptId !== receiptId)
      throw new Error("PERSONAL_DISCLOSURE_NOT_QUEUED")
    return true
  }
  const i18n = await labels()
  await closePersonalDisclosureCards(receiptId, pending, i18n.personalKeptPrivate)
  return true
}

/** A queued intent is not a delivered disclosure. The runner calls this after success. */
export async function finishPersonalDisclosureDelivery(job: OutboundJobRow): Promise<void> {
  if (!job.personalDisclosureReceiptId) return
  if ((await getDb().outboundQueue.get(job.id))?.status !== "sent") return
  const row = await getDb().actionReviewReceipts.get(job.personalDisclosureReceiptId)
  if (!row?.personalDisclosurePending || row.personal?.disclosure?.jobId !== job.id) return
  const i18n = await labels()
  await closePersonalDisclosureCards(
    row.id,
    row.personalDisclosurePending,
    i18n.personalSharedBy(row.personalDisclosurePending.grantedName ?? "")
  )
}

async function closePersonalDisclosureCards(
  receiptId: string,
  pending: PendingPersonalDisclosure,
  notice: string
): Promise<void> {
  const db = getDb()
  const { enqueueGoverned } = await import("./delivery-gateway")
  const previousNotice = await db.outboundQueue
    .where("idempotencyKey")
    .equals(`${pending.request.metadata.idempotencyKey}:personal-notice`)
    .first()
  await enqueueGoverned({
    ...pending.originalTarget,
    source: "manual",
    personalContext: explicitHostPersonalSinkContext("fixed-notice"),
    request: {
      conversationRef: pending.request.conversationRef,
      deliveryTarget: pending.request.deliveryTarget,
      ...(previousNotice?.platformMessageId
        ? { editTargetMessageId: previousNotice.platformMessageId }
        : {}),
      segments: [{ type: "text", text: notice }],
      metadata: { idempotencyKey: `${receiptId}:closed-notice` },
    },
  })
  if (pending.callbackCard) {
    const { conversationKey, messageId } = pending.callbackCard
    const key = parseConversationKey(conversationKey)
    if (pending.privateEphemeral) {
      const privateJob = await db.outboundQueue
        .where("idempotencyKey")
        .equals(`${pending.request.metadata.idempotencyKey}:personal-private`)
        .first()
      if (privateJob?.platformMessageId === messageId) {
        const { getBus } = await import("./bus")
        await getBus()
          .getAdapter(pending.originalTarget.adapterId)
          ?.deleteEphemeralCard?.(messageId)
      }
    } else
      await enqueueGoverned({
        adapterId: key.adapterId,
        conversationKey,
        source: "manual",
        personalContext: explicitHostPersonalSinkContext("fixed-notice"),
        request: {
          conversationRef: {
            platform: key.platform,
            adapterId: key.adapterId,
            channelId: key.remoteChatId,
          },
          editTargetMessageId: messageId,
          segments: [{ type: "text", text: notice }],
          metadata: { idempotencyKey: `${receiptId}:closed-private-card` },
        },
      }).catch(() => undefined)
  }
}
