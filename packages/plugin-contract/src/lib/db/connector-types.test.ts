import type { OutboundJobRow } from "./connector-types"

it("retains a Host disclosure receipt reference independently from the exact request", () => {
  const request = {
    conversationRef: { platform: "lark" as const, adapterId: "bot", channelId: "group" },
    segments: [{ type: "text" as const, text: "exact message" }],
    metadata: { idempotencyKey: "exact" },
  }
  const row: OutboundJobRow = {
    id: "job",
    adapterId: "bot",
    conversationKey: "lark:bot:group",
    request,
    status: "pending",
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    nextAttemptAt: 1,
    idempotencyKey: request.metadata.idempotencyKey,
    source: "ai-run",
    personalDisclosureReceiptId: "host-receipt",
  }
  const restored = JSON.parse(JSON.stringify(row))
  expect(restored.personalDisclosureReceiptId).toBe("host-receipt")
  expect(restored.request).toEqual(request)
  expect(restored.request).not.toHaveProperty("personalDisclosureReceiptId")
})
