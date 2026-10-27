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
    readonly reconciliationRequired = false
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
} {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const body = value as Record<string, unknown>
    return {
      id: typeof body.id === "string" ? body.id : undefined,
      file_info: typeof body.file_info === "string" ? body.file_info : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      code:
        typeof body.err_code === "number"
          ? body.err_code
          : typeof body.code === "number"
            ? body.code
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

  function handleInteraction(selfId: string, dispatch: QQDispatch, active: () => boolean): void {
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
    if (dispatch.t === "INTERACTION_CREATE") {
      handleInteraction(selfId, dispatch, active)
      return
    }
    const event = parseQQDispatch(opts.id, selfId, dispatch)
    if (!event) return
    if (event.kind === "delete" || event.kind === "edit") {
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
    abortController = new AbortController()
    const signal = abortController.signal
    const active = () =>
      !signal.aborted && abortController?.signal === signal && !ctx.signal?.aborted
    healthState = "running"
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
      intents: DEFAULT_QQ_INTENTS | (opts.receiveGuildMessages ? 1 << 9 : 0),
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
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    binary?: QQBinarySource & { fileType: number }
  ): Promise<{
    status: number
    body: ReturnType<typeof parseQQBody>
  }> {
    const doCall = async (token: string): Promise<TauriHttpResponse> => {
      if (binary) {
        let raw: string
        try {
          raw = await connectorsMediaUpload({
            uploadUrl: `${apiBase}${path}`,
            headers: qqAuthHeaders(token),
            sourceUrl: binary.sourceUrl,
            qq: { fileType: binary.fileType, fileName: binary.fileName },
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
        headers: qqAuthHeaders(token),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    }
    let token = await opts.accessToken()
    let resp = await doCall(token)
    let parsed = parseQQBody(resp.body)
    if (resp.status === 401 || resp.status === 403 || parsed.code === 11243) {
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
        pending
      )
    }
    return { status: resp.status, body: parsed }
  }

  async function send(req: OutboundRequest): Promise<OutboundResult> {
    let calls: ReturnType<typeof serializeOutboundParts>
    let keyboards: PreparedQQKeyboards
    try {
      try {
        keyboards = await prepareQQKeyboards(req)
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
        const { body, status } = await qqRequest("POST", call.path, payload)
        if (!body.id || status === 202) {
          throw new QQApiError(
            `QQ send delivery is unconfirmed (status ${status}); reconcile before resending${body.traceId ? ` [trace ${body.traceId}]` : ""}`,
            status,
            body.code,
            true
          )
        }
        delivered += 1
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
      if (err instanceof QQValidationError)
        return { ok: false, error: { code: "validation", message: err.message, retryable: false } }
      if (err instanceof QQApiError) {
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
