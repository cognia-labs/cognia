import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import {
  deliverWithReceipt,
  ConnectorDeliveryNotStartedError,
  type ConnectorDeliveryQuota,
} from "@/lib/connectors/delivery-receipts"
import { createQQManagement } from "./management"
import {
  collectConnectorAssetReferences,
  verifyConnectorAssetReferences,
  renewConnectorAssetReferences,
} from "@/lib/connectors/assets"
/**
 * QQ Official Bot adapter factory.
 *
 * Two inbound transports (QQ is deprecating the WebSocket gateway):
 *   - `gateway` (default): connects over the shared `connectors_ws_open`
 *     Tauri WS passthrough (no dedicated Rust transport — same approach as
 *     Discord).
 *   - `webhook`: DISPATCH envelopes arrive over the Rust-hosted HTTPS
 *     callback (`axum_app.rs::qq_official_webhook_handler` verifies the
 *     seeded-Ed25519 signature and answers the op-13 validation in-band).
 *
 * Both transports feed the shared dispatch pipeline: messages are parsed,
 * gated and emitted; verified button interactions use the callback bus.
 * Outbound always uses QQ REST with captured message/event reply authority.
 */

import { createQQStreamManager, QQStreamReconciliationError, type QQStreamResponse } from "./stream"
import { QQKeyboardValidationError } from "./keyboard"
import { getBus } from "@/lib/connectors/bus"
import {
  parseQQInteraction,
  resolveQQInteraction,
  qqInteractionAckId,
  qqInteractionResultCode,
} from "./interactions"
import type { ConnectorCallbackDecision } from "@/types/connectors/interaction"
import type {
  AdapterContext,
  AdapterSendOptions,
  AdapterHealth,
  AdapterHealthState,
  PlatformAdapter,
  TransportMode,
} from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import type { ReactionRef } from "@/types/connectors/adapter"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"
import { conversationBoundRoute } from "@/lib/connectors/adapters/_shared/message-route"
import {
  connectorsHttpRequest,
  connectorsMediaUpload,
  type TauriHttpResponse,
} from "@/lib/connectors/tauri/commands"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { recordDeliveredMessage } from "@/lib/connectors/delivered-messages"
import { buildConversationKey } from "@/types/connectors/event"
import { QQ_OFFICIAL_A2UI_CAPABILITY, QQ_OFFICIAL_CAPS } from "./capability"
import { QQ_API_BASE, clearQQTokenCacheByToken, getQQGatewayUrl, qqAuthHeaders } from "./auth"
import { parseQQDispatch, qqReferenceIndex, type QQDispatch, type QQScene } from "./parse"
import { findQQReference, recordQQReference } from "./references"
import {
  QQ_MAX_PASSIVE_REPLIES,
  QQ_PASSIVE_WINDOW_MS,
  QQValidationError,
  type QQBinarySource,
  decodeQQMessageId,
  encodeQQMessageId,
  qqPassiveMsgSeq,
  qqQuoteTarget,
  qqPassiveReplyCount,
  registerQQPassiveReply,
  serializeDelete,
  serializeOutboundParts,
  serializeReaction,
  serializeTyping,
} from "./serialize"
import {
  prepareQQKeyboards,
  recordQQKeyboardReceipts,
  type PreparedQQKeyboards,
} from "./a2ui-mapper"
import { DEFAULT_QQ_INTENTS, startQQGateway } from "./gateway-client"
import { startWebhookTransport } from "./transport-webhook"
import { enrichQQInboundMedia } from "./inbound-media"

export interface QQOfficialAdapterOptions {
  id: string
  displayName: string
  /** Resolves a fresh app access token (without the `QQBot ` prefix). */
  accessToken: () => Promise<string>
  /**
   * Evict the cached app access token for this row's credentials (injected
   * by `adapter-registry.buildQQOfficialAdapter`). Called from
   * `refreshCredentials()` and when the gateway reports OP 9
   * INVALID_SESSION, so the next resolve re-mints instead of re-using a
   * token the platform already rejected.
   */
  clearTokenCache?: () => void | Promise<void>
  /** REST + gateway base; defaults to the production host. */
  apiBase?: string
  /**
   * Active inbound transport for this row. `"gateway"` (default) dials the
   * WebSocket gateway; `"webhook"` receives DISPATCH envelopes via the
   * Rust-hosted callback endpoint (requires the connectors server + a public
   * tunnel URL pasted into the QQ console).
   */
  transportMode?: TransportMode
  /** Opt in only after the app has the private-guild GUILD_MESSAGES permission. */
  receiveGuildMessages?: boolean
  /** Subscribe only after the app has QQ's MESSAGE_AUDIT grant. */
  receiveMessageAudit?: boolean
  /** Resolve the current confirmed identity; startup probes can finish after start(). */
  selfId?: () => Promise<string>
}

const QQ_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["appId", "clientSecret"],
  properties: {
    appId: { type: "string", title: "App ID" },
    clientSecret: { type: "string", title: "Client Secret" },
    transport: {
      type: "string",
      title: "Transport",
      description:
        "gateway = WebSocket (deprecated by QQ); webhook = HTTPS callback via the local connectors server",
      enum: ["gateway", "webhook"],
      default: "gateway",
    },
    receiveGuildMessages: {
      type: "boolean",
      description: "Receive all private-guild channel messages; requires GUILD_MESSAGES permission",
      default: false,
    },
    receiveMessageAudit: {
      type: "boolean",
      description: "Subscribe to channel MESSAGE_AUDIT results after platform approval",
      default: false,
    },
  },
  additionalProperties: false,
}

/**
 * Platform code for "msg limit exceed" — QQ's rejection when a passive
 * msg_id has expired (group/channel/direct 5 min, C2C 60 min) or has hit
 * its per-scene reply cap. Non-retryable: the msg_id will never become valid again.
 */
const QQ_CODE_MSG_LIMIT_EXCEED = 22009
const QQ_PASSIVE_LIMIT_CODES = new Set([
  QQ_CODE_MSG_LIMIT_EXCEED,
  304027,
  304103,
  40034005,
  40034128,
])
const QQ_PENDING_AUDIT_CODES = new Set([304023, 304024])

class QQApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly platformCode?: number,
    readonly reconciliationRequired = false,
    readonly pendingReceiptId?: string
  ) {
    super(message)
    this.name = "QQApiError"
  }
}

/**
 * Last inbound message per conversation — what `setTyping` needs to address
 * a C2C typing indicator (a passive `msg_type: 6` reply). `buildConversationKey`
 * drops the scene, so the key alone cannot tell c2c from group; the entry
 * carries the scene, the addressing id, the inbound msg_id and its receipt
 * time (for the passive-window check). Bounded per adapter instance.
 */
interface QQLastInbound {
  scene: QQScene
  sceneId: string
  msgId: string
  receivedAt: number
}

const LAST_INBOUND_CAP = 500

/**
 * A typing indicator consumes one passive-reply slot of the inbound msg_id.
 * Only fire while strictly fewer than this many slots are used, so the real
 * reply (slot 4) always still fits after the indicator (slot ≤3).
 * UNVERIFIED: QQ does not document whether `input_notify` counts against the
 * C2C reply cap; treating it as consuming is the conservative reading.
 */
const TYPING_MAX_USED_SLOTS = QQ_MAX_PASSIVE_REPLIES.c2c - 1

/** Prefer the current err_code while retaining legacy code compatibility. */
function parseQQBody(raw: string): {
  id?: string
  message?: string
  code?: number
  file_info?: string
  traceId?: string
  referenceIndex?: string
  remaining?: number
  auditId?: string
  data?: Record<string, unknown>
} {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const body = value as Record<string, unknown>
    return {
      data: body,
      auditId: (() => {
        const data =
          body.data && typeof body.data === "object"
            ? (body.data as Record<string, unknown>)
            : undefined
        const audit =
          data?.message_audit && typeof data.message_audit === "object"
            ? (data.message_audit as Record<string, unknown>)
            : undefined
        const id = qqReferenceIndex(audit?.audit_id)
        return id && id.length <= 512 ? id : undefined
      })(),
      id: typeof body.id === "string" ? body.id : undefined,
      file_info: typeof body.file_info === "string" ? body.file_info : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      code:
        typeof body.err_code === "number"
          ? body.err_code
          : typeof body.code === "number"
            ? body.code
            : undefined,
      remaining:
        Number.isSafeInteger(body.remain_msg_len) && Number(body.remain_msg_len) >= 0
          ? Number(body.remain_msg_len)
          : undefined,
      traceId: typeof body.trace_id === "string" ? body.trace_id : undefined,
      referenceIndex:
        body.ext_info && typeof body.ext_info === "object" && !Array.isArray(body.ext_info)
          ? qqReferenceIndex((body.ext_info as Record<string, unknown>).ref_idx)
          : undefined,
    }
  } catch {
    return {}
  }
}

export function createQQOfficialAdapter(opts: QQOfficialAdapterOptions): PlatformAdapter {
  const apiBase = opts.apiBase ?? QQ_API_BASE
  let abortController: AbortController | null = null
  let healthState: AdapterHealthState = "starting"
  let healthReason: string | undefined
  let lastActivityAt: number | undefined
  let gatewaySelfId = ""
  const lastInbound = new Map<string, QQLastInbound>()
  const interactionTasks = new Map<string, Promise<void>>()
  const acknowledgedInteractions = new Set<string>()
  const interactionTimers = new Set<ReturnType<typeof setTimeout>>()

  function handleInteraction(
    ctx: AdapterContext,
    selfId: string,
    dispatch: QQDispatch,
    active: () => boolean
  ): void {
    const interactionId = qqInteractionAckId(dispatch)
    if (!interactionId || interactionTasks.has(interactionId)) return
    let terminal = false
    const task = (async () => {
      let responded = false
      const respond = (decision: ConnectorCallbackDecision) => {
        if (responded) return
        responded = true
        if (timer) {
          clearTimeout(timer)
          interactionTimers.delete(timer)
        }
        if (!active() || acknowledgedInteractions.has(interactionId)) return
        acknowledgedInteractions.add(interactionId)
        if (acknowledgedInteractions.size > 500)
          acknowledgedInteractions.delete(acknowledgedInteractions.values().next().value!)
        void qqRequest("PUT", `/interactions/${encodeURIComponent(interactionId)}`, {
          code: qqInteractionResultCode(decision),
        }).catch(() => {
          healthReason = "QQ interaction acknowledgement failed"
        })
      }
      const timer = setTimeout(() => respond({ status: "failed" }), 3_000)
      interactionTimers.add(timer)
      try {
        const system = parseQQDispatch(opts.id, selfId, dispatch)
        if (system?.interaction?.kind === "menu") {
          if (
            Date.now() - system.timestamp > 300000 ||
            !(await gateInboundEvent(opts.id, system)) ||
            !active()
          ) {
            terminal = true
            respond({ status: "denied", reason: "chat_policy" })
            return
          }
          await ctx.emit(system, { requireAcceptance: true })
          if (!active()) return
          terminal = true
          respond({ status: "accepted", kind: "generic" })
          return
        }
        const interaction = parseQQInteraction(dispatch)
        const callback = interaction
          ? await resolveQQInteraction(opts.id, selfId, interaction)
          : null
        if (!callback || !active()) {
          terminal = true
          respond({ status: "expired" })
          return
        }
        const allowed = await gateInboundEvent(opts.id, {
          platform: callback.platform,
          adapterId: opts.id,
          selfId,
          conversationRef: callback.deliveryTarget!.conversationRef,
          conversationKey: callback.conversationKey!,
          messageId: interactionId,
          sender: callback.user,
          channel: {
            id: callback.conversationKey!,
            kind: interaction!.scene === "group" ? "group" : "private",
            platformChannelId: interaction!.sceneId,
          },
          plainText: "",
          segments: [],
          mentions: { selfMentioned: true, users: [] },
          timestamp: callback.timestamp,
          raw: callback.raw,
          kind: "create",
          canReplyToMessage: false,
        })
        if (!allowed || !active()) {
          terminal = true
          respond({ status: "denied", reason: "chat_policy" })
          return
        }
        terminal =
          (await getBus().dispatchConnectorCallback(callback, { onDecision: respond })) ===
          "terminal"
        respond({ status: "failed" })
      } catch {
        respond({ status: "failed" })
      }
    })().finally(() => {
      if (!terminal) interactionTasks.delete(interactionId)
    })
    interactionTasks.set(interactionId, task)
    if (interactionTasks.size > 500) interactionTasks.delete(interactionTasks.keys().next().value!)
  }

  const streams = createQQStreamManager({
    adapterId: opts.id,
    request: async (path, payload, delivery) => {
      const references = collectConnectorAssetReferences(
        payload,
        /qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=+-]+/g
      )
      await verifyConnectorAssetReferences(opts.id, references)
      const preflight = async () => {
        try {
          return delivery ? await prepareExplicitDelivery(delivery) : undefined
        } catch (error) {
          if (error instanceof QQValidationError) throw error
          throw new ConnectorDeliveryNotStartedError(
            "QQ stream admission storage unavailable",
            true
          )
        }
      }
      if (delivery && payload.index === 0) await paceProactive()
      const wire = (beforePost?: () => Promise<void>) =>
        qqRequest("POST", path, payload, undefined, beforePost)
      let result: QQStreamResponse
      if (delivery) {
        const { quotas } = (await preflight())!
        let response: QQStreamResponse | undefined
        let wireError: unknown
        const outcome = await deliverWithReceipt(
          opts.id,
          delivery,
          quotas,
          async (assertQuotaActive) => {
            try {
              response = await wire(async () => {
                await preflight()
                assertQuotaActive()
              })
              return response.body.id && response.status !== 202
                ? {
                    ok: true,
                    platformMessageId: encodeQQMessageId(
                      "c2c",
                      String(delivery.conversationRef.sceneId),
                      response.body.id
                    ),
                  }
                : {
                    ok: false,
                    error: {
                      code: "reconciliation_required",
                      message: "QQ stream acknowledgement is uncertain",
                      retryable: false,
                    },
                  }
            } catch (error) {
              if (error instanceof ConnectorDeliveryNotStartedError) throw error
              wireError = error
              const status = (error as { status?: number })?.status
              return {
                ok: false,
                error: {
                  code:
                    error instanceof QQValidationError
                      ? "validation"
                      : error instanceof QQApiError && error.reconciliationRequired
                        ? "reconciliation_required"
                        : typeof status === "number" &&
                            status >= 400 &&
                            status < 500 &&
                            status !== 408
                          ? "platform_4xx"
                          : "network",
                  message: "QQ stream frame failed",
                  retryable: false,
                },
              }
            }
          },
          {
            stream: {
              key: delivery.metadata.streamKey!,
              index: Number(payload.index),
              ...(typeof payload.stream_msg_id === "string"
                ? {
                    previousMessageId: encodeQQMessageId(
                      "c2c",
                      String(delivery.conversationRef.sceneId),
                      payload.stream_msg_id
                    ),
                  }
                : {}),
              retainUntil: Number(delivery.conversationRef.receivedAt) + 30 * 86400_000,
            },
          }
        )
        if (wireError) throw wireError
        if (!outcome.ok) {
          if (outcome.error?.code === "validation")
            throw new QQValidationError(outcome.error.message)
          if (outcome.error?.code === "temporary_unavailable")
            throw new ConnectorDeliveryNotStartedError(outcome.error.message, true)
          throw new QQStreamReconciliationError(
            response?.body.id ??
              (typeof payload.stream_msg_id === "string" ? payload.stream_msg_id : undefined)
          )
        }
        result = response!
      } else result = await wire()
      if (result.body.id)
        await renewConnectorAssetReferences(opts.id, references, Date.now() + 90 * 86400_000).catch(
          () => undefined
        )
      return result
    },
    confirmed: async (scope, response) => {
      if (!response.id) return
      await recordDeliveredMessage(
        opts.id,
        buildConversationKey("qq-official", opts.id, scope.sceneId),
        encodeQQMessageId("c2c", scope.sceneId, response.id)
      )
      if (response.referenceIndex)
        await recordQQReference(
          { adapterId: opts.id, scene: "c2c", sceneId: scope.sceneId },
          response.id,
          response.referenceIndex
        ).catch(() => undefined)
    },
  })

  const management = createQQManagement({
    adapterId: opts.id,
    active: () => healthState === "running",
    signal: () => abortController?.signal,
    request: async (method, path, body) => (await qqRequest(method, path, body)).body.data ?? {},
    uploadAsset: async (input) =>
      (
        await qqRequest("POST", "/v2/media-images/prepare", undefined, {
          fileType: 1,
          fileName: input.name,
          contentType: input.mimeType,
          reusableAsset: true,
          sourceUrl: input.source.url ?? `data:${input.mimeType};base64,${input.source.dataBase64}`,
        })
      ).body.data ?? {},
  })

  /** Shared per-dispatch pipeline: parse → at-gate → bus emit. */
  async function handleDispatch(
    ctx: AdapterContext,
    selfId: string,
    dispatch: QQDispatch,
    active: () => boolean
  ): Promise<void> {
    if (!active()) return
    if (!selfId && opts.selfId) {
      try {
        selfId = await opts.selfId()
      } catch {
        // Missing identity must not lose history or invent a self mention.
      }
      if (!active()) return
    }
    if (dispatch.t === "INTERACTION_CREATE" && qqInteractionAckId(dispatch)) {
      handleInteraction(ctx, selfId, dispatch, active)
      return
    }
    const event = parseQQDispatch(opts.id, selfId, dispatch)
    if (!event) return
    if (event.kind === "delete" || event.kind === "edit" || event.deliveryStatus) {
      await ctx.emit(event)
      return
    }
    const ref = event.conversationRef as {
      scene?: QQScene
      sceneId?: string
      msgId?: string
      receivedAt?: number
      qqMsgIndex?: string
      qqReplyIndex?: string
    }
    if (ref.scene && ref.sceneId && ref.msgId) {
      rememberInbound(event.conversationKey, {
        scene: ref.scene,
        sceneId: ref.sceneId,
        msgId: ref.msgId,
        receivedAt: ref.receivedAt ?? Date.now(),
      })
      if (ref.scene === "group" || ref.scene === "c2c") {
        const scope = { adapterId: opts.id, scene: ref.scene, sceneId: ref.sceneId }
        if (ref.qqMsgIndex) {
          try {
            await recordQQReference(scope, event.messageId, ref.qqMsgIndex)
          } catch {
            // Preserve the event; unavailable quote aliases fail closed at send time.
          }
        }
        if (ref.qqReplyIndex && event.replyTo) {
          const parent = await findQQReference(scope, { referenceIndex: ref.qqReplyIndex })
          if (parent) {
            event.replyTo.messageId = parent.messageId
            for (const segment of event.segments)
              if (segment.type === "reply") segment.messageId = parent.messageId
          }
        }
      }
    }
    if (!(await gateInboundEvent(opts.id, event)) || !active()) return
    // Download what the parser could only reference, so a picture sent to the
    // bot reaches the model as an image rather than as the text
    // `[image: https://gchat.qpic.cn/…]`. After the gate: a message that is
    // going to be dropped costs no downloads.
    await enrichQQInboundMedia(event)
    if (!active()) return
    lastActivityAt = Date.now()
    await ctx.emit(event)
  }

  async function start(ctx: AdapterContext): Promise<void> {
    if (abortController) return
    streams.start()
    abortController = new AbortController()
    const signal = abortController.signal
    const active = () =>
      !signal.aborted && abortController?.signal === signal && !ctx.signal?.aborted
    healthState = opts.transportMode === "webhook" ? "running" : "starting"
    healthReason = undefined

    // Webhook mode: verified DISPATCH envelopes arrive from the Rust callback
    // endpoint (op 13 is answered in-band Rust-side and never seen here). The
    // generator ends only on abort, so — unlike the gateway — a stream end is
    // not an error condition.
    if (opts.transportMode === "webhook") {
      ;(async () => {
        try {
          for await (const dispatch of startWebhookTransport({ adapterId: opts.id, signal })) {
            if (signal.aborted) break
            // Webhook mode has no READY event; use the confirmed identity
            // supplied by the registry when available.
            await handleDispatch(ctx, gatewaySelfId, dispatch, active)
          }
        } catch (err) {
          if (active()) {
            healthState = "degraded"
            healthReason = `QQ webhook loop error: ${err instanceof Error ? err.message : String(err)}`
          }
        }
      })()
      return
    }

    const gateway = startQQGateway({
      accessToken: opts.accessToken,
      gatewayUrl: async () => getQQGatewayUrl(await opts.accessToken(), apiBase),
      signal,
      onHealth: (health) => {
        if (!active()) return
        healthState = health.state
        healthReason = health.reason
      },
      intents:
        DEFAULT_QQ_INTENTS |
        (opts.receiveGuildMessages ? 1 << 9 : 0) |
        (opts.receiveMessageAudit ? 1 << 27 : 0),
      // OP 9 INVALID_SESSION: the platform rejected our IDENTIFY/RESUME —
      // evict the cached token so the reconnect re-mints instead of looping
      // on the same rejected credential.
      onAuthInvalid: () => opts.clearTokenCache?.(),
    })
    ;(async () => {
      try {
        for await (const dispatch of gateway.dispatches) {
          if (signal.aborted) break
          gatewaySelfId = gateway.selfId
          await handleDispatch(ctx, gatewaySelfId, dispatch, active)
        }
        if (active()) {
          healthState = "down"
          healthReason = "QQ gateway dispatch stream ended unexpectedly"
        }
      } catch (err) {
        if (active()) {
          healthState = "degraded"
          healthReason = `QQ gateway loop error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    })()
  }

  async function stop(): Promise<void> {
    streams.stop()
    interactionTimers.forEach(clearTimeout)
    interactionTimers.clear()
    interactionTasks.clear()
    acknowledgedInteractions.clear()
    abortController?.abort()
    abortController = null
    healthState = "down"
    healthReason = undefined
  }

  function health(): AdapterHealth {
    return { state: healthState, reason: healthReason, lastActivityAt }
  }

  function rememberInbound(conversationKey: string, ref: QQLastInbound): void {
    lastInbound.delete(conversationKey)
    lastInbound.set(conversationKey, ref)
    while (lastInbound.size > LAST_INBOUND_CAP) {
      const oldest = lastInbound.keys().next().value
      if (oldest === undefined) break
      lastInbound.delete(oldest)
    }
  }

  /**
   * One authenticated REST round-trip. Retries exactly once on 401/403 with
   * a re-minted token (the cached app token, ~2h TTL, may be stale after a
   * console-side secret rotation — without the retry every call stays
   * bricked for hours). Also recognizes current business errors carried
   * by HTTP-success responses and legacy `code` envelopes.
   */
  async function qqRequest(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    binary?: QQBinarySource & { fileType: number; reusableAsset?: boolean; contentType?: string },
    beforePost?: () => Promise<void>
  ): Promise<{
    status: number
    body: ReturnType<typeof parseQQBody>
  }> {
    const doCall = async (token: string): Promise<TauriHttpResponse> => {
      await beforePost?.()
      if (binary) {
        let raw: string
        try {
          raw = await connectorsMediaUpload({
            uploadUrl: `${apiBase}${path}`,
            headers: qqAuthHeaders(token),
            sourceUrl: binary.sourceUrl,
            qq: {
              fileType: binary.fileType,
              fileName: binary.fileName,
              ...(binary.reusableAsset ? { reusableAsset: true } : {}),
            },
            ...(binary.contentType ? { contentType: binary.contentType } : {}),
            responseMode: "http",
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.startsWith("QQ upload validation:")) throw new QQValidationError(message)
          throw error
        }
        let response: unknown
        try {
          response = JSON.parse(raw)
        } catch {
          throw new QQApiError("QQ native upload returned an invalid response", 502)
        }
        if (
          !response ||
          typeof response !== "object" ||
          !("status" in response) ||
          !Number.isInteger(response.status) ||
          !("body" in response) ||
          typeof response.body !== "string" ||
          !("headers" in response) ||
          !response.headers ||
          typeof response.headers !== "object" ||
          Array.isArray(response.headers) ||
          Object.values(response.headers).some((value) => typeof value !== "string")
        )
          throw new QQApiError("QQ native upload returned an invalid response", 502)
        return response as TauriHttpResponse
      }
      return connectorsHttpRequest({
        url: `${apiBase}${path}`,
        method,
        ...(path.endsWith("/stream_messages") ? { timeoutMs: 10_000 } : {}),
        headers: qqAuthHeaders(token),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    }
    let token = await opts.accessToken()
    let resp = await doCall(token)
    let parsed = parseQQBody(resp.body)
    const ambiguousBusiness =
      (parsed.code !== undefined && QQ_PENDING_AUDIT_CODES.has(parsed.code)) ||
      parsed.code === 40054005 ||
      resp.status === 202
    if (
      !ambiguousBusiness &&
      (resp.status === 401 || resp.status === 403 || parsed.code === 11243)
    ) {
      clearQQTokenCacheByToken(token)
      await opts.clearTokenCache?.()
      token = await opts.accessToken()
      resp = await doCall(token)
      parsed = parseQQBody(resp.body)
    }
    const pending =
      resp.status === 202 || (parsed.code !== undefined && QQ_PENDING_AUDIT_CODES.has(parsed.code))
    const traceId =
      Object.entries(resp.headers).find(([key]) => key.toLowerCase() === "x-tps-trace-id")?.[1] ??
      parsed.traceId
    parsed.traceId = traceId
    if (
      resp.status < 200 ||
      resp.status >= 300 ||
      pending ||
      (parsed.code !== undefined && parsed.code !== 0)
    ) {
      const detail = `${parsed.message ?? (binary ? "Native upload rejected" : resp.body.slice(0, 200))}${
        parsed.code !== undefined ? ` (code ${parsed.code})` : ""
      }${traceId ? ` [trace ${traceId}]` : ""}`
      throw new QQApiError(
        `QQ ${method} ${path} failed: ${detail}`,
        resp.status,
        parsed.code,
        pending || parsed.code === 40054005,
        pending ? parsed.auditId : undefined
      )
    }
    return { status: resp.status, body: parsed }
  }

  let nextProactiveAt = 0
  let proactiveTail: Promise<void> = Promise.resolve()
  async function paceProactive() {
    const signal = abortController?.signal
    if (!signal || signal.aborted) throw new QQValidationError("QQ adapter stopped")
    const work = proactiveTail
      .catch(() => undefined)
      .then(async () => {
        const delay = nextProactiveAt - Date.now()
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (signal.aborted || signal !== abortController?.signal)
          throw new QQValidationError("QQ adapter stopped")
        nextProactiveAt = Date.now() + 2100
      })
    proactiveTail = work
    return work
  }

  async function send(req: OutboundRequest, options?: AdapterSendOptions): Promise<OutboundResult> {
    try {
      await verifyConnectorAssetReferences(
        opts.id,
        collectConnectorAssetReferences(
          req.segments,
          /qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=+-]+/g
        )
      )
    } catch {
      return {
        ok: false,
        error: {
          code: "validation",
          message: "QQ reusable image is unknown or expired for this adapter",
          retryable: false,
        },
      }
    }
    const explicitPush = req.sendOptions?.mode && req.sendOptions.mode !== "reply"
    const mentionsAll = req.segments.some(
      (segment) => segment.type === "mention" && segment.audience === "all"
    )
    if (
      req.sendOptions?.mode === "reengagement" &&
      req.conversationRef.scene === "c2c" &&
      (req.metadata.streamKey ||
        (!req.replyTo &&
          req.sendOptions.imagePolicy !== "require-complete" &&
          req.segments.length > 0 &&
          req.segments.every((segment) => segment.type === "text" || segment.type === "markdown")))
    )
      return streams.finish(
        {
          ...req,
          metadata: {
            ...req.metadata,
            streamKey: req.metadata.streamKey ?? `send:${req.metadata.idempotencyKey}`,
          },
        },
        (request) => sendExplicit(request, options)
      )
    if (explicitPush || mentionsAll) return sendExplicit(req, options)
    if (req.metadata.streamKey && req.conversationRef.scene === "c2c")
      return streams.finish(req, (request) => sendNormal(request, undefined, options))
    return sendNormal(req, undefined, options)
  }

  async function prepareExplicitDelivery(req: OutboundRequest) {
    const explicitPush = req.sendOptions?.mode && req.sendOptions.mode !== "reply"
    const mentionsAll = req.segments.some(
      (segment) => segment.type === "mention" && segment.audience === "all"
    )
    const ref = req.conversationRef
    if ((ref.scene !== "c2c" && ref.scene !== "group") || typeof ref.sceneId !== "string")
      throw new QQValidationError("QQ explicit delivery requires a captured group/C2C destination")
    const prepared = await prepareQQKeyboards(req)
    const preview = serializeOutboundParts(prepared.request, false)
    const cost = preview.length
    const now = Date.now(),
      minute = Math.floor(now / 60_000) * 60_000
    const day = Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000
    const target = `${ref.scene}:${ref.sceneId}`
    const quotas: ConnectorDeliveryQuota[] = []
    if (ref.scene === "group") {
      const state =
        (await qqRequest("GET", `/v2/groups/${encodeURIComponent(ref.sceneId)}/bot_state`)).body
          .data ?? {}
      if (explicitPush && state.allow_proactive_msg !== true)
        throw new QQValidationError("QQ group has not enabled proactive messages")
      if (mentionsAll && !["admin", "owner"].includes(String(state.member_role)))
        throw new QQValidationError("QQ broadcast mention requires group administrator role")
    } else if (mentionsAll) throw new QQValidationError("QQ broadcast mention requires a group")
    if (explicitPush && ref.scene === "c2c") {
      const permission = (
        await getConnectorConversationState(
          buildConversationKey("qq-official", opts.id, ref.sceneId)
        )
      )?.deliveryPermissions
      if (
        permission?.proactive === false ||
        (req.sendOptions?.mode === "proactive" && permission?.proactive !== true)
      )
        throw new QQValidationError("QQ C2C proactive delivery requires a recorded user opt-in")
    }
    if (explicitPush) {
      quotas.push(
        { key: "proactive:bot", start: minute, end: minute + 60_000, maximum: 30, cost },
        {
          key: `proactive:${target}:minute`,
          start: minute,
          end: minute + 60_000,
          maximum: 20,
          cost,
        },
        {
          key: `proactive:${target}:day`,
          start: day,
          end: day + 86400_000,
          maximum: 1000,
          cost,
        }
      )
      if (req.sendOptions?.mode === "reengagement") {
        if (
          ref.scene !== "c2c" ||
          !ref.msgId ||
          typeof ref.receivedAt !== "number" ||
          ref.receivedAt > now
        )
          throw new QQValidationError("QQ reengagement requires a captured user message")
        const age = (now - ref.receivedAt) / 86400_000
        const range =
          age < 1 ? [0, 1] : age < 3 ? [1, 3] : age < 7 ? [3, 7] : age < 30 ? [7, 30] : undefined
        if (!range) throw new QQValidationError("QQ reengagement window expired")
        quotas.push({
          key: `reengagement:${target}`,
          start: ref.receivedAt + range[0] * 86400_000,
          end: ref.receivedAt + range[1] * 86400_000,
          maximum: 1,
          cost,
        })
      }
    }
    if (mentionsAll)
      quotas.push({
        key: `mention-all:${target}`,
        start: day,
        end: day + 86400_000,
        maximum: 1,
        cost: preview.filter((call) => JSON.stringify(call.payload).includes("<qqbot-at-everyone"))
          .length,
      })
    return { prepared, quotas }
  }

  async function sendExplicit(
    req: OutboundRequest,
    options?: AdapterSendOptions
  ): Promise<OutboundResult> {
    try {
      const { prepared, quotas } = await prepareExplicitDelivery(req)
      return deliverWithReceipt(opts.id, req, quotas, (assertQuotaActive) =>
        sendNormal(prepared.request, prepared, options, async () => {
          await prepareExplicitDelivery(req)
          assertQuotaActive()
        })
      )
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof QQValidationError ? "validation" : "temporary_unavailable",
          message:
            error instanceof QQValidationError
              ? error.message
              : "QQ explicit delivery preflight failed",
          retryable: !(error instanceof QQValidationError),
        },
      }
    }
  }

  async function sendNormal(
    req: OutboundRequest,
    prepared?: PreparedQQKeyboards,
    options?: AdapterSendOptions,
    beforePost?: () => Promise<void>
  ): Promise<OutboundResult> {
    const mediaRefs = collectConnectorAssetReferences(
      req.segments,
      /qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=+-]+/g
    )
    try {
      await verifyConnectorAssetReferences(opts.id, mediaRefs)
    } catch {
      return {
        ok: false,
        error: {
          code: "validation",
          message:
            "QQ reusable image is unknown or expired for this adapter; query its inventory first",
          retryable: false,
        },
      }
    }
    let calls: ReturnType<typeof serializeOutboundParts>
    let keyboards: PreparedQQKeyboards
    try {
      try {
        keyboards = prepared ?? (await prepareQQKeyboards(req))
        req = keyboards.request
      } catch (error) {
        if (error instanceof QQKeyboardValidationError) throw new QQValidationError(error.message)
        return {
          ok: false,
          error: {
            code: "temporary_unavailable",
            message: "QQ keyboard binding storage is temporarily unavailable",
            retryable: true,
          },
        }
      }
      const ref = req.conversationRef as {
        scene?: QQScene
        sceneId?: string
        msgId?: string
        qqMsgIndex?: string
      }
      if ((ref.scene === "group" || ref.scene === "c2c") && ref.sceneId) {
        const target = qqQuoteTarget(req)
        let index: string | undefined
        if (target) {
          const scope = { adapterId: opts.id, scene: ref.scene, sceneId: ref.sceneId }
          if (target.startsWith("qq-ref:")) {
            let alias: string | undefined
            try {
              alias = qqReferenceIndex(decodeURIComponent(target.slice(7)))
            } catch {
              /* Invalid alias fails validation below. */
            }
            // Unknown quoted parents are display context only; do not invent placement.
            if (alias)
              index = (await findQQReference(scope, { referenceIndex: alias }))?.referenceIndex
          } else {
            const decoded = decodeQQMessageId(target)
            if (decoded && (decoded.scene !== ref.scene || decoded.sceneId !== ref.sceneId))
              throw new QQValidationError("QQ quote target belongs to a different conversation")
            const messageId = decoded?.id ?? target
            index = messageId === ref.msgId ? qqReferenceIndex(ref.qqMsgIndex) : undefined
            index ??= (await findQQReference(scope, { messageId }))?.referenceIndex
          }
          if (!index && req.replyTo)
            throw new QQValidationError(
              "QQ native reply requires a known quote index in this conversation"
            )
        }
        // Only the scoped lookup/current captured event may authorize this quote.
        req = { ...req, conversationRef: { ...req.conversationRef, qqQuoteIndex: index } }
      }
      calls = serializeOutboundParts(req, false)
    } catch (err) {
      if (!(err instanceof QQValidationError)) throw err
      return { ok: false, error: { code: "validation", message: err.message, retryable: false } }
    }
    const ref = req.conversationRef as { scene?: QQScene; sceneId?: string }
    let delivered = 0
    let platformMessageId: string | undefined
    try {
      // Upload all resources before sending any part; uploads never consume
      // a passive reply slot or proactively deliver a message.
      const uploaded = new Map<number, string>()
      for (const [index, call] of calls.entries()) {
        if (!call.upload) continue
        const { body } = await qqRequest(
          "POST",
          call.upload.path,
          call.upload.payload,
          call.upload.binary
            ? { ...call.upload.binary, fileType: call.upload.payload.file_type }
            : undefined
        )
        if (typeof body.file_info !== "string" || !body.file_info)
          throw new QQApiError("QQ media upload returned no file_info", 502)
        uploaded.set(index, body.file_info)
      }
      // Recheck capacity/expiry after uploads, then reserve all parts atomically.
      calls = serializeOutboundParts(req)
      for (const [index, call] of calls.entries()) {
        const fileInfo = uploaded.get(index)
        const payload = fileInfo
          ? { ...call.payload, media: { file_info: fileInfo } }
          : call.payload
        if (req.sendOptions?.mode && req.sendOptions.mode !== "reply") await paceProactive()
        const { body, status } = await qqRequest("POST", call.path, payload, undefined, beforePost)
        if (!body.id || status === 202) {
          throw new QQApiError(
            `QQ send delivery is unconfirmed (status ${status}); reconcile before resending${body.traceId ? ` [trace ${body.traceId}]` : ""}`,
            status,
            body.code,
            true
          )
        }
        delivered += 1
        await renewConnectorAssetReferences(
          opts.id,
          collectConnectorAssetReferences(payload, /qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=+-]+/g),
          Date.now() + 90 * 86400_000
        ).catch(() => undefined)
        platformMessageId =
          body.id && ref.scene && ref.sceneId
            ? encodeQQMessageId(ref.scene, ref.sceneId, body.id)
            : body.id
        await recordQQKeyboardReceipts(keyboards.bindings, call.payload.keyboard, body.id)
        if (ref.scene && ref.sceneId) {
          // Record each confirmed part, including parts before a later failure.
          await recordDeliveredMessage(
            opts.id,
            buildConversationKey("qq-official", opts.id, ref.sceneId),
            platformMessageId!
          )
          if ((ref.scene === "group" || ref.scene === "c2c") && body.referenceIndex) {
            try {
              await recordQQReference(
                { adapterId: opts.id, scene: ref.scene, sceneId: ref.sceneId },
                body.id,
                body.referenceIndex
              )
            } catch {
              // Delivery already happened. Missing alias must not trigger a resend.
            }
          }
        }
        lastActivityAt = Date.now()
      }
      if (healthState === "running") healthReason = undefined
      const downgrades = calls.flatMap((call) => call.downgrades ?? [])
      return { ok: true, platformMessageId, ...(downgrades.length ? { downgrades } : {}) }
    } catch (err) {
      if (delivered > 0)
        return {
          ok: false,
          platformMessageId,
          error: {
            code: "reconciliation_required",
            retryable: false,
            message: `QQ delivered ${delivered}/${calls.length} parts before failure; retrying the whole message could duplicate delivery. ${err instanceof Error ? err.message : String(err)}`,
          },
        }
      if (err instanceof QQValidationError || err instanceof ConnectorDeliveryNotStartedError)
        return { ok: false, error: { code: "validation", message: err.message, retryable: false } }
      if (err instanceof QQApiError) {
        if (err.pendingReceiptId && calls.length === 1 && ref.scene === "channel") {
          const pendingReceipt = { id: err.pendingReceiptId }
          // Retain the known correlation even if the host's first write fails;
          // the runner retries local registration without another provider POST.
          try {
            await options?.onPendingReceipt?.(pendingReceipt)
          } catch {
            /* caller persists result.pendingReceipt */
          }
          return {
            ok: false,
            pendingReceipt,
            error: {
              code: "delivery_pending",
              message: "QQ accepted the channel message for audit",
              retryable: false,
            },
          }
        }
        if (err.reconciliationRequired || err.platformCode === 40054005)
          return {
            ok: false,
            error: { code: "reconciliation_required", message: err.message, retryable: false },
          }
        if (
          err.platformCode !== undefined &&
          QQ_PASSIVE_LIMIT_CODES.has(err.platformCode) &&
          calls.some((call) => "msg_id" in call.payload)
        ) {
          // Distinct, non-retryable: the passive reply window elapsed (group
          // 5 min / C2C 60 min) or the 5-reply cap was hit — this msg_id can
          // never be replied to again.
          return {
            ok: false,
            error: {
              code: "platform_4xx",
              message: `QQ passive reply rejected: the reply window for msg_id has closed (group 5 min / C2C 60 min, group max 5 / C2C max 4 replies). ${err.message}`,
              retryable: false,
            },
          }
        }
        const code =
          err.status === 429 || err.platformCode === 40034100
            ? "rate_limited"
            : err.status === 401 || err.status === 403 || err.platformCode === 11243
              ? "auth_failed"
              : err.status >= 500
                ? "platform_5xx"
                : "platform_4xx"
        if (code === "auth_failed") healthReason = "auth_failed"
        return {
          ok: false,
          error: {
            code,
            message: err.message,
            retryable: code !== "platform_4xx" && code !== "auth_failed",
          },
        }
      }
      return {
        ok: false,
        error: {
          code: "platform_5xx",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      }
    }
  }

  /**
   * Recall (撤回) a message this bot sent. `messageId` must be the composite
   * `${scene}:${sceneId}:${id}` that `send()` returned — a bare id cannot be
   * routed to a scene endpoint and is rejected loudly rather than guessed.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const decoded = decodeQQMessageId(messageId)
    if (!decoded) {
      throw new Error(
        `QQ delete: expected a composite "scene:sceneId:id" message id, got "${messageId}"`
      )
    }
    const call = serializeDelete(decoded)
    await qqRequest(call.method, call.path)
    lastActivityAt = Date.now()
  }

  /**
   * Typing indicator — C2C only (group / channel / direct have no typing
   * API). It is itself a passive reply, so it needs a cached inbound msg_id
   * that is still inside the 60-minute C2C window and has < 4 passive slots
   * used. Anything else is a silent no-op: the bus treats typing as
   * best-effort and a throw would only surface as noise.
   */
  async function setTyping(conversationKey: string, on: boolean): Promise<void> {
    if (!on) return
    const last = lastInbound.get(conversationKey)
    if (!last || last.scene !== "c2c") return
    if (Date.now() - last.receivedAt > QQ_PASSIVE_WINDOW_MS.c2c) return
    if (qqPassiveReplyCount(last.msgId) >= TYPING_MAX_USED_SLOTS) return
    // Each indicator gets its own passive slot + a seq that cannot collide
    // with the reply's idempotency-derived seq (distinct key namespace).
    const key = `typing:${last.msgId}:${qqPassiveReplyCount(last.msgId) + 1}`
    registerQQPassiveReply(last.msgId, key)
    const call = serializeTyping(last.sceneId, last.msgId, qqPassiveMsgSeq(key))
    await qqRequest(call.method, call.path, call.payload)
    lastActivityAt = Date.now()
  }

  /**
   * Reactions exist only in the guild `channel` scene. `emojiType` is
   * `"<type>:<id>"` (QQ addresses emoji by type + id). Group / C2C / direct
   * ids throw `unsupported` so the bus surfaces it instead of a 404.
   */
  function requireChannelScene(messageId: string, op: string): { channelId: string; id: string } {
    const decoded = decodeQQMessageId(messageId)
    if (!decoded) {
      throw new Error(
        `QQ ${op}: expected a composite "scene:sceneId:id" message id, got "${messageId}"`
      )
    }
    if (decoded.scene !== "channel") {
      throw new Error(
        `QQ ${op}: unsupported — reactions only exist in the channel scene (got ${decoded.scene})`
      )
    }
    return { channelId: decoded.sceneId, id: decoded.id }
  }

  async function addReaction(messageId: string, emojiType: string): Promise<ReactionRef> {
    const { channelId, id } = requireChannelScene(messageId, "addReaction")
    const call = serializeReaction(channelId, id, emojiType, "add")
    await qqRequest(call.method, call.path)
    lastActivityAt = Date.now()
    // QQ has no reaction handle; the emoji type doubles as the removal id.
    return { reactionId: emojiType }
  }

  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const { channelId, id } = requireChannelScene(messageId, "removeReaction")
    const call = serializeReaction(channelId, id, reactionId, "remove")
    await qqRequest(call.method, call.path)
    lastActivityAt = Date.now()
  }

  async function refreshCredentials(): Promise<void> {
    // The access token is resolved fresh on each gateway connect / REST call;
    // refreshing means evicting the cached mint so the next resolve re-mints.
    await opts.clearTokenCache?.()
  }

  return {
    get meta() {
      return {
        type: "qq-official" as const,
        displayName: opts.displayName,
        version: "0.1.0",
        capabilities: QQ_OFFICIAL_CAPS,
        transportModes: ["gateway", "webhook"] as const,
        configSchema: QQ_CONFIG_SCHEMA,
      }
    },
    id: opts.id,
    start,
    stop,
    health,
    send,
    voiceFormats: (ref) =>
      ref.scene === "group"
        ? ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/silk"]
        : ref.scene === "c2c"
          ? ["audio/silk"]
          : [],
    management,
    streamReply: async (req) => {
      await verifyConnectorAssetReferences(
        opts.id,
        collectConnectorAssetReferences(req.text, /qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=+-]+/g)
      )
      await streams.preview(req)
    },
    cancelStreamReply: streams.cancel,
    // Every delivery goes to the reference's chat: a reply's message id never
    // moves it, and there is no edit (ADR-0239).
    messageRoute: conversationBoundRoute,
    delete: deleteMessage,
    setTyping,
    addReaction,
    removeReaction,
    refreshCredentials,
    runtimeCapabilities: builtInConnectorRuntimeCapabilities("qq-official"),
    a2uiCapability: () => QQ_OFFICIAL_A2UI_CAPABILITY,
  }
}
