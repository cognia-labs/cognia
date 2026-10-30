/** Durable idempotency and quota reservations for sends without a passive id. */
import { getDb } from "@/lib/db/schema"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
export interface ConnectorDeliveryQuota {
  key: string
  start: number
  end: number
  maximum: number
  cost: number
}
/** A caller knows admission failed before any provider message request. */
export class ConnectorDeliveryNotStartedError extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}
export interface ConnectorDeliveryReceipt {
  fingerprint: string
  phase: "sending" | "uncertain" | "sent" | "rejected"
  quotas: ConnectorDeliveryQuota[]
  expiresAt: number
  platformMessageId?: string
  pendingReceipt?: { id: string }
  reconciled?: true
  /** Continuations mutate one provider message; the original quota stays charged. */
  stream?: { key: string; nextIndex: number; retainUntil: number }
}
const uncertain = (messageId?: string, pendingReceipt?: { id: string }): OutboundResult => ({
  ok: false,
  ...(messageId ? { platformMessageId: messageId } : {}),
  ...(pendingReceipt ? { pendingReceipt } : {}),
  error: {
    code: "reconciliation_required",
    message: "Delivery is uncertain; reconcile the platform outcome before resending",
    retryable: false,
  },
})

export async function deliverWithReceipt(
  adapterId: string,
  request: OutboundRequest,
  quotas: ConnectorDeliveryQuota[],
  send: (assertQuotaActive: () => void) => Promise<OutboundResult>,
  options?: {
    stream: { key: string; index: number; previousMessageId?: string; retainUntil: number }
  }
): Promise<OutboundResult> {
  request = structuredClone(request)
  quotas = structuredClone(quotas)
  const stream = options?.stream ? structuredClone(options.stream) : undefined
  const table = getDb().inboundLedger
  const key = `${adapterId}:connector-delivery:${request.metadata.idempotencyKey}`
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      conversationRef: request.conversationRef,
      ...(stream
        ? { streamKey: stream.key, retainUntil: stream.retainUntil }
        : { segments: request.segments, replyTo: request.replyTo }),
      sendOptions: request.sendOptions,
    })
  )
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  let receipt: ConnectorDeliveryReceipt = {
    fingerprint,
    phase: "sending",
    quotas,
    expiresAt: Math.max(
      Date.now() + 86400_000,
      stream?.retainUntil ?? 0,
      ...quotas.map((q) => q.end)
    ),
    ...(stream
      ? { stream: { key: stream.key, nextIndex: stream.index, retainUntil: stream.retainUntil } }
      : {}),
  }
  const write = (value: ConnectorDeliveryReceipt) =>
    table.put({
      id: key,
      adapterId,
      namespace: "connector-delivery",
      platformMessageId: request.metadata.idempotencyKey,
      receivedAt: Date.now(),
      deliveryReceipt: value,
    })
  let priorResult: OutboundResult | undefined
  let continuedMessageId: string | undefined
  try {
    await getDb().transaction("rw", table, async () => {
      if (
        stream &&
        (!stream.key ||
          stream.key.length > 512 ||
          !Number.isSafeInteger(stream.index) ||
          stream.index < 0 ||
          !Number.isFinite(stream.retainUntil) ||
          stream.retainUntil <= Date.now())
      )
        throw new TypeError("Invalid stream delivery reservation")
      const prior = (await table.get(key))?.deliveryReceipt
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new TypeError("Delivery changed after reservation")
        if (prior.phase === "sent") {
          if (stream) {
            if (
              prior.stream?.key !== stream.key ||
              prior.stream.nextIndex !== stream.index ||
              !prior.platformMessageId ||
              prior.platformMessageId !== stream.previousMessageId
            )
              throw new TypeError("Stream continuation does not match acknowledged delivery")
            continuedMessageId = prior.platformMessageId
            receipt = { ...prior, phase: "sending" }
            await write(receipt)
          } else priorResult = { ok: true, platformMessageId: prior.platformMessageId }
          return
        }
        if (prior.phase === "rejected" && prior.reconciled) {
          priorResult = {
            ok: false,
            error: {
              code: "provider_rejected",
              message: "Provider rejected the accepted message",
              retryable: false,
            },
          }
          return
        }
        if (prior.phase !== "rejected") {
          priorResult = uncertain(prior.platformMessageId, prior.pendingReceipt)
          return
        }
      }
      if (stream && (stream.index !== 0 || stream.previousMessageId !== undefined))
        throw new TypeError("Stream delivery must begin at index zero")
      const rows = await table.where("namespace").equals("connector-delivery").toArray()
      const expired = rows.filter(
        (row) =>
          row.deliveryReceipt &&
          row.deliveryReceipt.expiresAt <= Date.now() &&
          (row.deliveryReceipt.phase === "sent" || row.deliveryReceipt.phase === "rejected")
      )
      if (expired.length) await table.bulkDelete(expired.map((row) => row.id))
      if (rows.length - expired.length >= 10_000 && !prior)
        throw new TypeError("Delivery receipt capacity reached")
      for (const q of quotas) {
        if (
          !Number.isSafeInteger(q.cost) ||
          q.cost < 1 ||
          q.maximum < q.cost ||
          q.start > Date.now() ||
          q.end <= Date.now()
        )
          throw new TypeError("Invalid delivery quota")
        const used = rows
          .filter(
            (row) =>
              row.adapterId === adapterId &&
              row.id !== key &&
              row.deliveryReceipt?.phase !== "rejected"
          )
          .reduce(
            (sum, row) =>
              sum +
              (row.deliveryReceipt?.quotas
                .filter((old) => old.key === q.key && old.start === q.start && old.end === q.end)
                .reduce((cost, old) => cost + old.cost, 0) ?? 0),
            0
          )
        if (used + q.cost > q.maximum) throw new TypeError("Connector delivery quota exhausted")
      }
      await write(receipt)
    })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof TypeError ? "validation" : "temporary_unavailable",
        message:
          error instanceof TypeError ? error.message : "Delivery reservation storage unavailable",
        retryable: !(error instanceof TypeError),
      },
    }
  }
  if (priorResult) return priorResult
  const writeOutcome = (value: ConnectorDeliveryReceipt) =>
    getDb().transaction("rw", table, async () => {
      const current = (await table.get(key))?.deliveryReceipt
      // An early provider callback can settle while send() is still returning.
      if (current?.reconciled) return
      await write(value)
    })
  let result: OutboundResult
  let notStarted = false
  const assertQuotaActive = () => {
    if (
      !continuedMessageId &&
      receipt.quotas.some((q) => q.start > Date.now() || q.end <= Date.now())
    )
      throw new ConnectorDeliveryNotStartedError(
        "Delivery reservation expired before provider request"
      )
  }
  try {
    assertQuotaActive()
    result = await send(assertQuotaActive)
  } catch (error) {
    if (error instanceof ConnectorDeliveryNotStartedError) {
      notStarted = true
      result = {
        ok: false,
        error: {
          code: error.retryable ? "temporary_unavailable" : "validation",
          message: error.message,
          retryable: error.retryable,
        },
      }
    } else {
      await writeOutcome({ ...receipt, phase: "uncertain" }).catch(() => undefined)
      return uncertain(continuedMessageId)
    }
  }
  const knownRejection =
    !result.ok &&
    (notStarted ||
      ["validation", "platform_4xx", "auth_failed", "rate_limited"].includes(
        result.error?.code ?? ""
      ))
  const invalidStreamAck = Boolean(
    stream &&
    result.ok &&
    (!result.platformMessageId ||
      (continuedMessageId && result.platformMessageId !== continuedMessageId))
  )
  const phase = invalidStreamAck
    ? "uncertain"
    : result.ok
      ? "sent"
      : knownRejection
        ? continuedMessageId
          ? "sent"
          : "rejected"
        : "uncertain"
  try {
    await writeOutcome({
      ...receipt,
      phase,
      platformMessageId: invalidStreamAck
        ? continuedMessageId
        : (result.platformMessageId ?? continuedMessageId),
      ...(stream && result.ok && !invalidStreamAck
        ? {
            stream: {
              key: stream.key,
              nextIndex: stream.index + 1,
              retainUntil: stream.retainUntil,
            },
          }
        : {}),
      ...(result.pendingReceipt ? { pendingReceipt: result.pendingReceipt } : {}),
    })
  } catch {
    return uncertain(result.platformMessageId)
  }
  return phase === "uncertain"
    ? uncertain(
        invalidStreamAck ? continuedMessageId : (result.platformMessageId ?? continuedMessageId),
        result.pendingReceipt
      )
    : result
}
