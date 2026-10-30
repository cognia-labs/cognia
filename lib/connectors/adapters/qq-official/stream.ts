/** Native C2C stream lifecycle. The durable final send remains authoritative. */
import type { ConversationReference } from "@/types/connectors/event"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import type { StreamReplyRequest } from "@/types/connectors/adapter"
import type { QQStreamCheckpoint, InboundLedgerRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { hasNoLeakingPii } from "@cognia/redact"
import { ConnectorDeliveryNotStartedError } from "@/lib/connectors/delivery-receipts"
import {
  QQValidationError,
  encodeQQMessageId,
  registerQQPassiveReply,
  serializeOutboundParts,
  qqPassiveMsgSeq,
} from "./serialize"

export const QQ_STREAM_WINDOW_MS = 5 * 60_000
const MAX_TEXT_BYTES = 48 * 1024
const MAX_RECORDS = 1000
const RETAIN_MS = 24 * 60 * 60_000
const NAMESPACE = "qq-stream" as const

interface Scope {
  mode?: "reengagement"
  ref: ConversationReference
  sceneId: string
  streamKey: string
  msgId?: string
  eventId?: string
  receivedAt: number
}
interface Entry extends Scope {
  tail: Promise<unknown>
  pending?: Promise<void>
  latest?: string
  closing: boolean
  generation: number
  nextAt: number
}
export interface QQStreamResponse {
  status: number
  body: { id?: string; referenceIndex?: string; remaining?: number }
}
export class QQStreamReconciliationError extends Error {
  constructor(readonly messageId?: string) {
    super("QQ stream delivery is uncertain; reconcile before resending")
  }
}
class QQStreamEvidenceError extends Error {
  constructor(readonly messageId: string) {
    super("QQ stream was delivered; local delivery evidence needs repair")
  }
}

export function createQQStreamManager(options: {
  adapterId: string
  request: (
    path: string,
    payload: Record<string, unknown>,
    delivery?: OutboundRequest
  ) => Promise<QQStreamResponse>
  confirmed: (scope: { sceneId: string }, response: QQStreamResponse["body"]) => Promise<void>
  now?: () => number
  wait?: (ms: number) => Promise<void>
}) {
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  let generation = 0
  let stopped = false
  let rpcTail: Promise<unknown> = Promise.resolve()
  let nextRpcAt = 0
  const waits = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>()
  const pause =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const item = {
          timer: setTimeout(() => {
            waits.delete(item)
            resolve()
          }, ms),
          resolve,
        }
        waits.add(item)
      }))

  function scope(
    ref: ConversationReference,
    streamKey: string | undefined,
    sendOptions?: OutboundRequest["sendOptions"]
  ): Scope {
    const mode = sendOptions?.mode
    if (
      ref.platform !== "qq-official" ||
      ref.adapterId !== options.adapterId ||
      ref.scene !== "c2c" ||
      typeof ref.sceneId !== "string" ||
      !ref.sceneId ||
      ref.sceneId.length > 256 ||
      !streamKey ||
      streamKey.length > 512 ||
      /[\u0000-\u001f]/.test(streamKey) ||
      Boolean(ref.msgId) === Boolean(ref.eventId) ||
      (ref.msgId !== undefined && typeof ref.msgId !== "string") ||
      (ref.eventId !== undefined && typeof ref.eventId !== "string") ||
      typeof ref.receivedAt !== "number" ||
      !Number.isFinite(ref.receivedAt) ||
      (mode !== undefined && mode !== "reply" && mode !== "reengagement") ||
      (mode === "reengagement" && (!ref.msgId || Boolean(ref.eventId)))
    )
      throw new QQValidationError(
        "QQ C2C streaming requires a turn key and captured passive reply context"
      )
    return {
      ref: { ...ref },
      sceneId: ref.sceneId,
      streamKey,
      msgId: ref.msgId as string | undefined,
      eventId: ref.eventId as string | undefined,
      receivedAt: ref.receivedAt,
      ...(mode === "reengagement" ? { mode } : {}),
    }
  }
  function validWindow(s: Scope) {
    const age = now() - s.receivedAt
    if (
      s.mode === "reengagement"
        ? age < 0 || age >= 30 * 86400_000
        : age > QQ_STREAM_WINDOW_MS || s.receivedAt > now() + 60_000
    )
      throw new QQValidationError("QQ native stream reply window has expired")
  }
  function recordId(s: Scope) {
    return `${options.adapterId}:${NAMESPACE}:${JSON.stringify([s.sceneId, s.streamKey])}`
  }
  function budgetId(s: Scope) {
    return s.eventId ? `event:${s.eventId}` : s.msgId!
  }
  function budgetKey(s: Scope) {
    return `qq-stream:${s.mode ? JSON.stringify([s.sceneId, s.streamKey]) : s.streamKey}`
  }
  function active(e: Entry) {
    return !stopped && e.generation === generation
  }
  function entry(s: Scope): Entry {
    const key = recordId(s)
    const existing = entries.get(key)
    if (existing) {
      if (
        existing.msgId !== s.msgId ||
        existing.mode !== s.mode ||
        existing.eventId !== s.eventId ||
        existing.receivedAt !== s.receivedAt
      )
        throw new QQValidationError("QQ stream key belongs to another captured reply")
      return existing
    }
    if (stopped || entries.size >= 128)
      throw new QQValidationError("QQ native stream is unavailable")
    const created: Entry = { ...s, tail: Promise.resolve(), closing: false, generation, nextAt: 0 }
    entries.set(key, created)
    return created
  }
  async function read(s: Scope): Promise<QQStreamCheckpoint | undefined> {
    const row = await getDb().inboundLedger.get(recordId(s))
    const state = row?.qqStream
    if (
      row &&
      (!state ||
        state.streamKey !== s.streamKey ||
        state.sceneId !== s.sceneId ||
        state.msgId !== s.msgId ||
        state.mode !== s.mode ||
        state.eventId !== s.eventId ||
        state.receivedAt !== s.receivedAt ||
        !Number.isSafeInteger(state.index) ||
        state.index < 0 ||
        typeof state.text !== "string" ||
        !["open", "sending", "uncertain", "rejected", "closed", "cancelled"].includes(state.phase))
    )
      throw new QQStreamReconciliationError(state?.messageId)
    if (state?.phase === "sending" || state?.phase === "uncertain")
      throw new QQStreamReconciliationError(state.messageId)
    return state
  }
  async function write(s: Scope, state: QQStreamCheckpoint) {
    const row: InboundLedgerRow = {
      id: recordId(s),
      adapterId: options.adapterId,
      namespace: NAMESPACE,
      platformMessageId: JSON.stringify([s.sceneId, s.streamKey]),
      receivedAt: now(),
      qqStream: state,
    }
    await getDb().inboundLedger.put(row)
  }
  async function replace(s: Scope, expected: QQStreamCheckpoint, next: QQStreamCheckpoint) {
    const db = getDb()
    await db.transaction("rw", db.inboundLedger, async () => {
      const current = (await db.inboundLedger.get(recordId(s)))?.qqStream
      if (JSON.stringify(current) !== JSON.stringify(expected))
        throw new QQStreamReconciliationError(current?.messageId)
      await write(s, next)
    })
  }
  async function initialize(s: Scope, opening = true): Promise<QQStreamCheckpoint> {
    const db = getDb()
    return db.transaction("rw", db.inboundLedger, async () => {
      const prior = await read(s)
      if (prior) {
        if (prior.index > 0 && !s.mode) registerQQPassiveReply(budgetId(s), budgetKey(s))
        return prior
      }
      const rows = await db.inboundLedger.where("namespace").equals(NAMESPACE).toArray()
      const expired = rows.filter(
        (row) =>
          now() - row.receivedAt > RETAIN_MS &&
          row.qqStream?.phase !== "sending" &&
          row.qqStream?.phase !== "uncertain" &&
          (row.qqStream?.mode !== "reengagement" ||
            now() - row.qqStream.receivedAt >= 30 * 86400_000)
      )
      if (expired.length) await db.inboundLedger.bulkDelete(expired.map((row) => row.id))
      if (rows.length - expired.length >= MAX_RECORDS)
        throw new QQValidationError("QQ stream checkpoint capacity reached")
      if (opening) validWindow(s)
      if (opening)
        serializeOutboundParts(
          {
            conversationRef: s.ref,
            segments: [{ type: "text", text: "stream" }],
            metadata: { idempotencyKey: budgetKey(s) },
            ...(s.mode ? { sendOptions: { mode: s.mode } } : {}),
          },
          false
        )
      const state: QQStreamCheckpoint = {
        streamKey: s.streamKey,
        sceneId: s.sceneId,
        msgId: s.msgId,
        eventId: s.eventId,
        receivedAt: s.receivedAt,
        ...(s.mode ? { mode: s.mode } : {}),
        phase: opening ? "open" : "closed",
        index: 0,
        text: "",
      }
      await write(s, state)
      return state
    })
  }
  function serialize<T>(e: Entry, operation: () => Promise<T>): Promise<T> {
    const work = e.tail.catch(() => undefined).then(operation)
    e.tail = work
    return work
  }
  async function frame(
    e: Entry,
    state: QQStreamCheckpoint,
    text: string,
    done: boolean,
    final?: { key: string; fingerprint: string },
    cancelled = false
  ): Promise<QQStreamCheckpoint> {
    if (!hasNoLeakingPii(text))
      throw new QQValidationError("QQ stream text was rejected by the PII gate")
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES)
      throw new QQValidationError("QQ stream snapshot exceeds the bounded text limit")
    if (!text.startsWith(state.text))
      throw new QQValidationError("QQ stream cannot rewrite a delivered prefix")
    const work = rpcTail
      .catch(() => undefined)
      .then(async () => {
        const delay = Math.max(e.nextAt, nextRpcAt) - now()
        if (delay > 0) await pause(delay)
        if (!active(e)) throw new QQValidationError("QQ stream stopped")
        validWindow(e)
        // Validate without consuming a slot, then persist intent before reserving it.
        const reservation: OutboundRequest = {
          conversationRef: e.ref,
          segments: [{ type: "text", text: "stream" }],
          metadata: { idempotencyKey: budgetKey(e) },
          ...(e.mode ? { sendOptions: { mode: e.mode } } : {}),
        }
        serializeOutboundParts(reservation, false)
        const sending: QQStreamCheckpoint = { ...state, phase: "sending" }
        await replace(e, state, sending)
        try {
          serializeOutboundParts(reservation)
        } catch (error) {
          await replace(e, sending, state)
          throw error
        }
        nextRpcAt = now() + 25
        e.nextAt = now() + 500
        let response: QQStreamResponse
        try {
          response = await options.request(
            `/v2/users/${encodeURIComponent(e.sceneId)}/stream_messages`,
            {
              input_mode: "replace",
              input_state: done ? 10 : 1,
              index: state.index,
              content_type: "markdown",
              content_raw: text,
              ...(e.eventId ? { event_id: e.eventId } : { msg_id: e.msgId }),
              ...(e.mode ? { is_wakeup: true } : {}),
              ...(state.messageId ? { stream_msg_id: state.messageId } : {}),
              msg_seq: qqPassiveMsgSeq(budgetKey(e)),
            },
            ...(e.mode
              ? [
                  {
                    ...reservation,
                    segments: [{ type: "markdown" as const, md: text }],
                    metadata: { ...reservation.metadata, streamKey: e.streamKey },
                  },
                ]
              : [])
          )
        } catch (error) {
          const status = (error as { status?: number })?.status
          const knownRejection =
            error instanceof QQValidationError ||
            error instanceof ConnectorDeliveryNotStartedError ||
            (typeof status === "number" &&
              status >= 400 &&
              status < 500 &&
              status !== 408 &&
              (error as { reconciliationRequired?: boolean })?.reconciliationRequired !== true)
          await replace(e, sending, {
            ...state,
            ...(error instanceof QQStreamReconciliationError && error.messageId && !state.messageId
              ? { messageId: error.messageId }
              : {}),
            phase: knownRejection
              ? cancelled
                ? "cancelled"
                : state.messageId
                  ? "open"
                  : "rejected"
              : "uncertain",
          }).catch(() => undefined)
          if (!knownRejection) throw new QQStreamReconciliationError(state.messageId)
          throw error
        }
        if (
          !response.body.id ||
          response.status === 202 ||
          (state.messageId && response.body.id !== state.messageId)
        ) {
          await replace(e, sending, { ...state, phase: "uncertain" }).catch(() => undefined)
          throw new QQStreamReconciliationError(state.messageId)
        }
        const next: QQStreamCheckpoint = {
          ...state,
          phase: cancelled ? "cancelled" : done ? "closed" : "open",
          index: state.index + 1,
          text,
          messageId: response.body.id,
          referenceIndex: response.body.referenceIndex ?? state.referenceIndex,
          // remain_msg_len is response metadata, not a writable allowance.
          // In particular, a zero observation must not strand an accepted stream.
          remaining: response.body.remaining ?? state.remaining,
          ...(final
            ? {
                finalKey: final.key,
                finalFingerprint: final.fingerprint,
                finalMessageId: encodeQQMessageId("c2c", e.sceneId, response.body.id),
              }
            : {}),
        }
        try {
          await replace(e, sending, next)
        } catch {
          throw new QQStreamReconciliationError(response.body.id)
        }
        try {
          await options.confirmed(e, response.body)
        } catch {
          throw new QQStreamEvidenceError(response.body.id)
        }
        return next
      })
    rpcTail = work
    return work
  }
  function schedule(e: Entry): Promise<void> {
    if (e.pending) return e.pending
    const pending = serialize(e, async () => {
      if (!active(e) || e.closing || e.latest === undefined) return
      const state = await initialize(e)
      if (state.phase !== "open" || state.finalizing) {
        e.closing = true
        e.latest = undefined
        if (entries.get(recordId(e)) === e) entries.delete(recordId(e))
        return
      }
      // Take the newest snapshot after pacing, not the first queued token.
      const delay = e.nextAt - now()
      if (delay > 0) await pause(delay)
      if (!active(e) || e.closing || e.latest === undefined) return
      const text = e.latest
      e.latest = undefined
      if (text === state.text || !text.startsWith(state.text)) return
      await frame(e, state, text, false)
    })
    e.pending = pending
    void pending
      .catch(() => {
        e.latest = undefined
        if (!e.closing) entries.delete(recordId(e))
      })
      .finally(() => {
        if (e.pending === pending) e.pending = undefined
        if (active(e) && !e.closing && e.latest !== undefined)
          void schedule(e).catch(() => undefined)
      })
      .catch(() => undefined)
    return pending
  }
  async function preview(req: StreamReplyRequest): Promise<void> {
    if (req.text.includes("<qqbot-at-everyone"))
      throw new QQValidationError("QQ broadcast mentions require a structured mention segment")
    if (req.conversationRef.scene !== "c2c" || !req.text.trim()) return
    if (!hasNoLeakingPii(req.text))
      throw new QQValidationError("QQ stream text was rejected by the PII gate")
    const e = entry(scope(req.conversationRef, req.streamKey, req.sendOptions))
    if (!active(e) || e.closing) return
    validWindow(e)
    e.latest = req.text
    await schedule(e)
  }
  function resultError(error: unknown, sceneId: string): OutboundResult {
    if (error instanceof QQStreamReconciliationError)
      return {
        ok: false,
        ...(error.messageId
          ? { platformMessageId: encodeQQMessageId("c2c", sceneId, error.messageId) }
          : {}),
        error: { code: "reconciliation_required", message: error.message, retryable: false },
      }
    return {
      ok: false,
      ...(error instanceof QQStreamEvidenceError
        ? { platformMessageId: encodeQQMessageId("c2c", sceneId, error.messageId) }
        : {}),
      error: {
        code:
          error instanceof QQValidationError ||
          (error instanceof ConnectorDeliveryNotStartedError && !error.retryable)
            ? "validation"
            : "temporary_unavailable",
        message:
          error instanceof QQValidationError ? error.message : "QQ stream could not be completed",
        retryable:
          !(error instanceof QQValidationError) &&
          !(error instanceof ConnectorDeliveryNotStartedError && !error.retryable),
      },
    }
  }
  async function finish(
    req: OutboundRequest,
    normalSend: (req: OutboundRequest) => Promise<OutboundResult>
  ): Promise<OutboundResult> {
    let e: Entry
    try {
      e = entry(scope(req.conversationRef, req.metadata.streamKey, req.sendOptions))
    } catch (error) {
      return resultError(error, String(req.conversationRef.sceneId ?? ""))
    }
    e.closing = true
    e.latest = undefined
    return serialize(e, async () => {
      try {
        let state = await read(e)
        if (state?.index && !e.mode) registerQQPassiveReply(budgetId(e), budgetKey(e))
        const body = req.segments
          .filter((s) => s.type === "text" || s.type === "markdown")
          .map((s) => (s.type === "text" ? s.text : s.type === "markdown" ? s.md : ""))
          .join("\n")
        if (!hasNoLeakingPii(body))
          throw new QQValidationError("QQ stream final text was rejected by the PII gate")
        const fingerprint = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({
              segments: req.segments,
              replyTo: req.replyTo,
              sendOptions: req.sendOptions,
            })
          )
        )
        const digest = [...new Uint8Array(fingerprint)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
        if (state?.finalKey) {
          if (state.finalKey !== req.metadata.idempotencyKey || state.finalFingerprint !== digest)
            throw new QQValidationError("QQ stream final request changed after completion")
          if (
            state.messageId &&
            state.finalMessageId === encodeQQMessageId("c2c", e.sceneId, state.messageId)
          ) {
            try {
              await options.confirmed(e, {
                id: state.messageId,
                referenceIndex: state.referenceIndex,
              })
            } catch {
              throw new QQStreamEvidenceError(state.messageId)
            }
          }
          return { ok: true, platformMessageId: state.finalMessageId }
        }
        if (state?.phase === "cancelled")
          throw new QQValidationError("QQ stream capture was cancelled")
        if (!state) state = await initialize(e, Boolean(e.mode))
        const finalizing = {
          ...state,
          ...(e.mode && state.phase === "rejected" ? { phase: "open" as const } : {}),
          finalizing: true,
        }
        await replace(e, state, finalizing)
        state = finalizing
        const native =
          (state.messageId || e.mode) &&
          state.phase === "open" &&
          !req.replyTo &&
          req.sendOptions?.imagePolicy !== "require-complete" &&
          (!req.sendOptions?.mode ||
            req.sendOptions.mode === "reply" ||
            req.sendOptions.mode === "reengagement") &&
          req.segments.every((s) => s.type === "text" || s.type === "markdown") &&
          body.trim() &&
          body.startsWith(state.text) &&
          new TextEncoder().encode(body).length <= MAX_TEXT_BYTES
        let current = state
        let result: OutboundResult
        let fallbackIntent: QQStreamCheckpoint | undefined
        if (native) {
          current = await frame(e, current, body, true, {
            key: req.metadata.idempotencyKey,
            fingerprint: digest,
          })
          result = {
            ok: true,
            platformMessageId: encodeQQMessageId("c2c", e.sceneId, current.messageId!),
          }
        } else {
          if (e.mode && current.messageId) {
            // This recall already exists. A different final must never open a second message.
            if (current.phase === "open") current = await frame(e, current, current.text, true)
            throw new QQStreamReconciliationError(current.messageId)
          }
          // Preflight the complete fallback before closing any known preview.
          serializeOutboundParts(req, false)
          if (current.messageId && current.phase === "open")
            current = await frame(e, current, current.text, true)
          // An interrupted ordinary fallback must not be resent blindly either.
          fallbackIntent = { ...current, phase: "sending" }
          await replace(e, current, fallbackIntent)
          try {
            result = await normalSend(req)
          } catch {
            throw new QQStreamReconciliationError(current.messageId)
          }
          if (!result.ok) {
            const provenRejection = [
              "validation",
              "platform_4xx",
              "auth_failed",
              "rate_limited",
            ].includes(result.error?.code ?? "")
            if (provenRejection) await replace(e, fallbackIntent, current)
            else {
              await replace(e, fallbackIntent, { ...current, phase: "uncertain" })
              throw new QQStreamReconciliationError(current.messageId)
            }
          }
          if (result.ok && state.messageId)
            result.downgrades = [
              ...(result.downgrades ?? []),
              { from: "markdown", to: "markdown", reason: "qq_stream_final_only_alternative" },
            ]
        }
        if (result.ok && !native) {
          try {
            await replace(e, fallbackIntent!, {
              ...current,
              phase: "closed",
              finalKey: req.metadata.idempotencyKey,
              finalFingerprint: digest,
              finalMessageId: result.platformMessageId,
            })
          } catch {
            throw new QQStreamReconciliationError(current.messageId)
          }
        }
        return result
      } catch (error) {
        return resultError(error, e.sceneId)
      } finally {
        if (entries.get(recordId(e)) === e) entries.delete(recordId(e))
      }
    })
  }
  async function cancel(req: {
    conversationRef: ConversationReference
    streamKey: string
    sendOptions?: OutboundRequest["sendOptions"]
  }): Promise<void> {
    const e = entry(scope(req.conversationRef, req.streamKey, req.sendOptions))
    e.closing = true
    e.latest = undefined
    try {
      await serialize(e, async () => {
        const prior = await initialize(e, false)
        if (prior?.finalKey || prior?.phase === "cancelled") return
        const state: QQStreamCheckpoint = {
          ...prior,
          finalizing: true,
          phase: "cancelled",
        }
        await replace(e, prior, state)
        if (prior.messageId && prior.phase === "open")
          await frame(e, state, state.text, true, undefined, true)
      })
    } finally {
      if (entries.get(recordId(e)) === e) entries.delete(recordId(e))
    }
  }
  return {
    preview,
    finish,
    cancel,
    start: () => {
      stopped = false
    },
    stop: () => {
      stopped = true
      generation++
      entries.clear()
      for (const item of waits) {
        clearTimeout(item.timer)
        item.resolve()
      }
      waits.clear()
    },
  }
}
