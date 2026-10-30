/** Per-capture ownership for QQ previews; final delivery stays in the outbound queue. */
import type { PlatformAdapter, StreamReplyRequest } from "@/types/connectors/adapter"
import type { ConversationReference } from "@/types/connectors/event"
import { hasNoLeakingPii } from "@cognia/redact"
import { DIGITAL_TWIN_DISCLOSURE, twinShareProvenance } from "@/lib/twin/outbound-disclosure"
import type { MessageSegment } from "@/types/connectors/segment"

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
  const cancel = (): Promise<void> => {
    accepting = false
    signal?.removeEventListener("abort", aborted)
    if (handedOff || !started) return Promise.resolve()
    cancellation ??= Promise.resolve(
      adapter.cancelStreamReply?.({
        conversationRef,
        streamKey,
        ...(intent.sendOptions ? { sendOptions: intent.sendOptions } : {}),
      })
    ).catch(() => undefined)
    return cancellation
  }
  const aborted = () => {
    void cancel()
  }
  signal?.addEventListener("abort", aborted, { once: true })
  return {
    streamKey,
    onPartial: (text: string) => {
      if (!accepting || signal?.aborted || !hasNoLeakingPii(text)) return
      started = true
      void adapter.streamReply!({ conversationRef, streamKey, text, ...intent }).catch(
        () => undefined
      )
    },
    captured: () => {
      accepting = false
    },
    handoff: () => {
      accepting = false
      handedOff = true
      signal?.removeEventListener("abort", aborted)
    },
    cancel,
  }
}
