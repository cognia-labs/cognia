/** Shared send-intent checks, independent of any platform wire protocol. */
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { OutboundRequest, OutboundResult } from "@/types/connectors/outbound"

export function validateOutboundFeatures(
  adapter: PlatformAdapter,
  req: OutboundRequest
): OutboundResult | undefined {
  const options = req.sendOptions
  if (
    options &&
    (Object.keys(options).some((key) => !["mode", "imagePolicy"].includes(key)) ||
      (options.mode !== undefined &&
        !["reply", "proactive", "reengagement"].includes(options.mode)) ||
      (options.imagePolicy !== undefined &&
        !["best-effort", "require-complete"].includes(options.imagePolicy)))
  )
    return {
      ok: false,
      error: { code: "validation", message: "Invalid connector send options", retryable: false },
    }
  const caps = adapter.meta.capabilities
  const supported =
    (!options?.mode ||
      options.mode === "reply" ||
      caps.includes(options.mode === "proactive" ? "send.proactive" : "send.reengagement")) &&
    (options?.imagePolicy !== "require-complete" || caps.includes("send.image.verify")) &&
    (!req.segments.some((segment) => segment.type === "mention" && segment.audience) ||
      caps.includes("send.mention.all")) &&
    (!req.segments.some(
      (segment) =>
        segment.type === "a2ui" &&
        Object.values(segment.content.components).some(
          (node) =>
            node && typeof node === "object" && ("confirmation" in node || "exclusiveGroup" in node)
        )
    ) ||
      caps.includes("send.button.policy"))
  if (!supported)
    return {
      ok: false,
      error: {
        code: "unsupported_segment",
        message:
          "Adapter does not support the requested delivery, image or broadcast-mention policy",
        retryable: false,
      },
    }
}
