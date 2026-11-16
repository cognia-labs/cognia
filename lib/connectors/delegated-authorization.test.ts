const getAdapterInstance = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (id: string) => getAdapterInstance(id),
}))
const beginAuthorization = jest.fn(async () => "https://open.feishu.cn/authorize?state=s")
let hasHook = true
jest.mock("./vendor-contribution", () => ({
  connectorVendor: () =>
    hasHook
      ? { delegatedCredentials: { beginAuthorization } }
      : { delegatedCredentials: undefined },
}))
const enqueueGoverned = jest.fn(async (_input: unknown) => ({ kind: "queued" }))
jest.mock("./delivery-gateway", () => ({
  enqueueGoverned: (input: unknown) => enqueueGoverned(input),
}))

import {
  authorizationLinkText,
  forgetAuthorizationOffer,
  offerDelegatedAuthorization,
} from "./delegated-authorization"

const row = { id: "bot-a", type: "lark" }
const alice = {
  kind: "platform" as const,
  platform: "lark" as const,
  adapterId: "bot-a",
  remoteUserId: "ou_a",
}
const offer = (overrides: Partial<Parameters<typeof offerDelegatedAuthorization>[0]> = {}) =>
  offerDelegatedAuthorization({
    adapterId: "bot-a",
    conversationKey: "lark:bot-a:oc_group",
    executionRunId: "run-1",
    person: alice,
    now: 1_000_000,
    ...overrides,
  })

beforeEach(() => {
  hasHook = true
  getAdapterInstance.mockReset().mockResolvedValue(row)
  beginAuthorization.mockClear()
  enqueueGoverned.mockClear()
  forgetAuthorizationOffer("bot-a", alice)
})

it("sends the link as the marked turn's own delivery, narrowed to that person", async () => {
  expect(await offer()).toBe("queued")
  expect(beginAuthorization).toHaveBeenCalledWith(row, alice)
  expect(enqueueGoverned).toHaveBeenCalledWith({
    adapterId: "bot-a",
    conversationKey: "lark:bot-a:oc_group",
    request: {
      conversationRef: { platform: "lark", adapterId: "bot-a", channelId: "oc_group" },
      segments: [
        { type: "text", text: authorizationLinkText("https://open.feishu.cn/authorize?state=s") },
      ],
      metadata: { idempotencyKey: "delegated-authorization:run-1" },
    },
    source: "ai-run",
    personalContext: { executionRunId: "run-1" },
    authorization: { kind: "system-notice", inboundConversationKey: "lark:bot-a:oc_group" },
  })
})

it("offers one link per person while the last can still be completed", async () => {
  expect(await offer()).toBe("queued")
  expect(await offer({ executionRunId: "run-2", now: 1_000_000 + 9 * 60_000 })).toBe(
    "already-offered"
  )
  expect(await offer({ executionRunId: "run-3", person: { ...alice, remoteUserId: "ou_b" } })).toBe(
    "queued"
  )
  expect(await offer({ executionRunId: "run-4", now: 1_000_000 + 11 * 60_000 })).toBe("queued")
  expect(enqueueGoverned).toHaveBeenCalledTimes(3)
})

it("offers again at once after the throttle is forgotten", async () => {
  await offer()
  forgetAuthorizationOffer("bot-a", alice)
  expect(await offer({ executionRunId: "run-2" })).toBe("queued")
})

it("does nothing for a platform without per-person authorizations or a missing adapter", async () => {
  hasHook = false
  expect(await offer()).toBe("unsupported")
  hasHook = true
  getAdapterInstance.mockResolvedValue(undefined)
  expect(await offer()).toBe("unsupported")
  expect(enqueueGoverned).not.toHaveBeenCalled()
})

it("names the link in both languages and nothing of the turn", () => {
  const text = authorizationLinkText("https://x.test/a")
  expect(text).toContain("请点击链接授权")
  expect(text).toContain("Authorize Cognia")
  expect(text.match(/https:\/\/x\.test\/a/g)).toHaveLength(2)
})
