import { validateOutboundFeatures } from "./outbound-features"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
const req: OutboundRequest = {
  conversationRef: { platform: "matrix", adapterId: "a" },
  segments: [{ type: "text", text: "Hello" }],
  metadata: { idempotencyKey: "k" },
}
it("rejects explicit unsupported features instead of silently changing delivery semantics", () => {
  const adapter = { meta: { capabilities: [] } } as unknown as PlatformAdapter
  expect(validateOutboundFeatures(adapter, req)).toBeUndefined()
  for (const sendOptions of [
    { mode: "proactive" },
    { mode: "reengagement" },
    { imagePolicy: "require-complete" },
  ] as const)
    expect(validateOutboundFeatures(adapter, { ...req, sendOptions })).toMatchObject({
      ok: false,
      error: { retryable: false },
    })
  expect(
    validateOutboundFeatures(adapter, {
      ...req,
      segments: [{ type: "mention", userId: "*", audience: "all" }],
    })
  ).toMatchObject({ ok: false })
})
it("allows declared capabilities on a second adapter and rejects unknown options", () => {
  const adapter = {
    meta: { capabilities: ["send.proactive", "send.image.verify", "send.mention.all"] },
  } as unknown as PlatformAdapter
  expect(
    validateOutboundFeatures(adapter, {
      ...req,
      sendOptions: { mode: "proactive", imagePolicy: "require-complete" },
    })
  ).toBeUndefined()
  expect(
    validateOutboundFeatures(adapter, { ...req, sendOptions: { arbitrary: true } as never })
  ).toMatchObject({ error: { code: "validation" } })
})
