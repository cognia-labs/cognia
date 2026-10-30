/** Pure normalization for platform-provided voice conversions and ASR hints. */
import { evaluateFetchTarget } from "@cognia/network-guard"
import type { MessageSegment } from "@/types/connectors/segment"

export function normalizeInboundVoice(input: {
  url: string
  mimeType?: string
  convertedWavUrl?: unknown
  transcript?: unknown
}): Extract<MessageSegment, { type: "voice" }> {
  let converted: string | undefined
  if (typeof input.convertedWavUrl === "string") {
    try {
      const url = new URL(input.convertedWavUrl)
      if (evaluateFetchTarget(url.href).allowed && !url.username && !url.password)
        converted = url.href
    } catch {
      /* An invalid optional conversion leaves the original attachment intact. */
    }
  }
  const transcript =
    typeof input.transcript === "string" ? input.transcript.trim().slice(0, 16_384) : undefined
  return {
    type: "voice",
    url: converted ?? input.url,
    ...(converted
      ? { rawUrl: input.url, mimeType: "audio/wav" }
      : input.mimeType
        ? { mimeType: input.mimeType }
        : {}),
    ...(transcript ? { transcript } : {}),
  }
}
