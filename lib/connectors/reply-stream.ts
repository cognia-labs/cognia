/** Per-capture ownership for QQ previews; final delivery stays in the outbound queue. */
import type { PlatformAdapter, StreamReplyRequest } from "@/types/connectors/adapter"
import type { ConversationReference } from "@/types/connectors/event"
import { hasNoLeakingPii } from "@cognia/redact"
import { DIGITAL_TWIN_DISCLOSURE, twinShareProvenance } from "@/lib/twin/outbound-disclosure"
import type { MessageSegment } from "@/types/connectors/segment"
import type { PersonalSinkContext } from "@/lib/execution/personal-sink"
import { checkConnectorPersonalSink, personalDeliveryNotice } from "./personal-delivery"

/** A fixed leading disclosure preserves QQ's immutable delivered prefix. */
export function discloseReplyStreamText(text: string, twinId?: string): string {
  return twinId && !text.includes(DIGITAL_TWIN_DISCLOSURE)
    ? `${DIGITAL_TWIN_DISCLOSURE}\n\n${text}`
    : text
}

export function discloseReplyStreamSegments(segments: MessageSegment[], twinId: string) {
  const result = segments.map((segment) => ({ ...segment }))
  const first = result.find((segment) => segment.type === "text" || segment.type === "markdown")
  if (first?.type === "text") first.text = discloseReplyStreamText(first.text, twinId)
  else if (first?.type === "markdown") first.md = discloseReplyStreamText(first.md, twinId)
  else result.unshift({ type: "text", text: DIGITAL_TWIN_DISCLOSURE })
  return { segments: result, provenance: twinShareProvenance(twinId) }
}

export function createReplyStream(input: {
  adapter?: PlatformAdapter
  conversationRef: ConversationReference
  streamKey: string
  enabled: boolean
  signal?: AbortSignal
  sendOptions?: StreamReplyRequest["sendOptions"]
  conversationKey?: string
  personalContext: PersonalSinkContext
  /** Test seam; production always checks the live Host run on each frame. */
  checkPersonal?: typeof checkConnectorPersonalSink
}) {
  const { adapter, conversationRef, streamKey, signal } = input
  const intent = {
    ...(input.sendOptions ? { sendOptions: structuredClone(input.sendOptions) } : {}),
    ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
  }
  if (
    !input.enabled ||
    adapter?.meta.type !== "qq-official" ||
    conversationRef.scene !== "c2c" ||
    !adapter.streamReply
  )
    return undefined
  let accepting = true
  let started = false
  let handedOff = false
  let cancellation: Promise<void> | undefined
  let inFlight: Promise<void> | undefined
  let latest: { text: string; final: boolean } | undefined
  let lastOffered: string | undefined
  let lastSentText = ""
  let personalStopped = false
  const cancel = (): Promise<void> => {
    accepting = false
    latest = undefined
    signal?.removeEventListener("abort", aborted)
    if (handedOff) return inFlight ?? Promise.resolve()
    cancellation ??= (inFlight ?? Promise.resolve())
      .then(() =>
        started && !handedOff
          ? adapter.cancelStreamReply?.({ conversationRef, streamKey, ...intent })
          : undefined
      )
      .catch(() => undefined)
    return cancellation
  }
  const drain = (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      while (latest && !personalStopped && !signal?.aborted) {
        const frame = latest
        latest = undefined
        const decision = await (input.checkPersonal ?? checkConnectorPersonalSink)(
          input.personalContext,
          adapter.id,
          input.conversationKey,
          frame.text,
          { adapter }
        )
        if (signal?.aborted) return
        if (decision.outcome !== "allow") {
          personalStopped = true
          accepting = false
          const notice = await personalDeliveryNotice(false)
          await adapter.streamReply!({
            conversationRef,
            streamKey,
            text: lastSentText ? `${lastSentText}\n\n${notice}` : notice,
            ...intent,
          })
          await adapter.cancelStreamReply?.({ conversationRef, streamKey, ...intent })
          handedOff = true
          signal?.removeEventListener("abort", aborted)
          return
        }
        // A final refresh always checks live taint, without replaying identical preview bytes.
        if (!frame.final || frame.text !== lastSentText) {
          started = true
          await adapter.streamReply!({ conversationRef, streamKey, text: frame.text, ...intent })
          lastSentText = frame.text
        }
      }
    })()
      .catch(() => {
        personalStopped = true
        accepting = false
      })
      .finally(() => {
        inFlight = undefined
        // A capture/partial can arrive after the loop exits but before this
        // promise settles. Include that latest frame in the returned drain.
        if (latest && !personalStopped && !signal?.aborted) return drain()
      })
    return inFlight
  }
  const aborted = () => {
    void cancel()
  }
  signal?.addEventListener("abort", aborted, { once: true })
  return {
    streamKey,
    onPartial: (text: string): Promise<void> => {
      if (!accepting || signal?.aborted || !hasNoLeakingPii(text)) return Promise.resolve()
      lastOffered = text
      latest = { text, final: false }
      return drain()
    },
    captured: () => {
      accepting = false
      if (!personalStopped && lastOffered !== undefined)
        latest = { text: latest?.text ?? lastOffered, final: true }
      return drain()
    },
    handoff: () => {
      accepting = false
      handedOff = true
      signal?.removeEventListener("abort", aborted)
    },
    cancel,
  }
}
