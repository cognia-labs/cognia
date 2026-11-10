import type { PersonalSinkContext } from "./personal-sink"
import type { enqueueGoverned, ConnectorDeliveryGateway } from "@/lib/connectors/delivery-gateway"
import type { notify } from "@/lib/notifications/runtime"

// Compile-only negative contracts: adding an optional/default context breaks these.
function typeContracts(
  enqueue: typeof enqueueGoverned,
  immediate: ConnectorDeliveryGateway["sendNow"],
  notification: typeof notify
) {
  // @ts-expect-error A sink may not infer provenance from an empty object.
  const absent: PersonalSinkContext = {}
  // @ts-expect-error Every queued delivery must supply Host provenance.
  enqueue({
    adapterId: "a",
    conversationKey: "lark:a:c",
    source: "ai-run",
    request: {
      conversationRef: { platform: "lark", adapterId: "a", channelId: "c" },
      segments: [],
      metadata: { idempotencyKey: "context-contract" },
    },
    authorization: { kind: "system-notice", inboundConversationKey: "lark:a:c" },
  })
  // @ts-expect-error Host options are required independently of producer fields.
  notification({ source: "system", level: "info", title: "fixed" })
  // @ts-expect-error Immediate delivery cannot omit provenance either.
  immediate({
    adapterId: "a",
    conversationKey: "lark:a:c",
    source: "ai-run",
    authorization: { kind: "system-notice", inboundConversationKey: "lark:a:c" },
    auditKind: "delivery.legacy_direct",
  })
  return absent
}
it("retains the compile-only required-context contract", () => {
  expect(typeof typeContracts).toBe("function")
})
