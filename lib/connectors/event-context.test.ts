import { captureSystemDeliveryContext } from "./event-context"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
it("rolls back interaction occurrence dedup when atomic audit capture fails", async () => {
  const event = {
    platform: "matrix",
    adapterId: "a",
    selfId: "bot",
    originEventId: "menu",
    messageId: "menu",
    kind: "system",
    systemKind: "interaction",
    interaction: { kind: "menu", featureId: "help" },
    conversationKey: "matrix:a:chat",
    conversationRef: { platform: "matrix", adapterId: "a" },
    channel: { id: "chat", kind: "private" },
    sender: { id: "user", platform: "matrix", adapterId: "a", remoteUserId: "user" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  } satisfies NormalizedInboundEvent
  const spy = jest.spyOn(getDb().connectorAudit, "add").mockRejectedValueOnce(new Error("disk"))
  await expect(captureSystemDeliveryContext(event)).rejects.toThrow("disk")
  spy.mockRestore()
  expect(await captureSystemDeliveryContext(event)).toBe(true)
  expect(await captureSystemDeliveryContext(event)).toBe(false)
  expect(await getDb().connectorAudit.count()).toBe(1)
})
it("captures event authority and consent once, retaining the newest decision", async () => {
  const time = Date.now() - 1000
  const event = {
    kind: "system",
    selfId: "bot",
    sender: { id: "user", platform: "qq-official", adapterId: "a", remoteUserId: "user" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    raw: {},
    originEventId: "event",
    platform: "qq-official",
    adapterId: "a",
    messageId: "event",
    conversationKey: "qq-official:a:chat",
    conversationRef: {
      platform: "qq-official",
      adapterId: "a",
      scene: "c2c",
      sceneId: "chat",
      eventId: "event",
      receivedAt: time,
    },
    channel: { id: "chat", kind: "private" },
    timestamp: time,
    deliveryPermissionChange: { proactive: true },
    passiveEvent: { id: "event", expiresAt: time + 300000 },
  } satisfies NormalizedInboundEvent
  expect(await captureSystemDeliveryContext(event)).toBe(true)
  expect(await captureSystemDeliveryContext(event)).toBe(false)
  expect(
    (await getDb().connectorConversationStates.get(event.conversationKey))?.deliveryPermissions
      ?.proactive
  ).toBe(true)
  await captureSystemDeliveryContext({
    ...event,
    originEventId: "new",
    timestamp: time + 500,
    deliveryPermissionChange: { proactive: false },
  })
  await captureSystemDeliveryContext({ ...event, originEventId: "delayed" })
  expect(
    (await getDb().connectorConversationStates.get(event.conversationKey))?.deliveryPermissions
      ?.proactive
  ).toBe(false)
})
