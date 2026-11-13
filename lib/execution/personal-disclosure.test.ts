/** @jest-environment node */
import {
  declaredRecipientsCoverDisclosure,
  requestMatchesPersonalDisclosureTarget,
  copyPersonalDisclosureCapability,
  hasPersonalDisclosureCapability,
} from "./personal-disclosure"

it("refuses bound-person disclosure until phase 5 supplies declared-recipient authority", () => {
  const target = { adapterId: "a", conversationKey: "lark:a:group" }
  expect(declaredRecipientsCoverDisclosure({ lane: "bound-person", target })).toBe(false)
  expect(declaredRecipientsCoverDisclosure({ lane: "delegated", target })).toBe(true)
})
it("cannot create a capability through a serialized claim or ordinary copy", () => {
  const forged = { disclosureReceiptId: "receipt", personalDisclosure: { grantedBy: "owner" } }
  expect(hasPersonalDisclosureCapability(forged)).toBe(false)
  expect(
    hasPersonalDisclosureCapability(copyPersonalDisclosureCapability(forged, { ...forged }))
  ).toBe(false)
})
it("requires the exact request destination, including a complete delivery target", () => {
  const target = { adapterId: "a", conversationKey: "lark:a:group" }
  const request = {
    conversationRef: { platform: "lark" as const, adapterId: "a", channelId: "group" },
    segments: [],
    metadata: { idempotencyKey: "fixed" },
  }
  expect(requestMatchesPersonalDisclosureTarget(request, target)).toBe(true)
  expect(
    requestMatchesPersonalDisclosureTarget({ ...request, threadId: "different-thread" }, target)
  ).toBe(false)
  expect(
    requestMatchesPersonalDisclosureTarget(request, { ...target, conversationKey: "lark:a:other" })
  ).toBe(false)
})
