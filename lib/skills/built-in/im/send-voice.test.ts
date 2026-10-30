jest.mock("@/lib/connectors/voice", () => ({
  connectorVoiceFormats: jest.fn(),
  synthesizeConnectorVoice: jest.fn(),
}))
jest.mock("@/lib/connectors/session-bindings", () => ({ findSessionByConversationKey: jest.fn() }))
jest.mock("@/lib/db/characters", () => ({ getCharacter: jest.fn() }))
jest.mock("@/lib/db/connector-conversation-state", () => ({
  getConnectorConversationState: jest.fn(),
}))
jest.mock("@/lib/connectors/lifecycle", () => ({ getRunningAdapter: jest.fn() }))
jest.mock("@/lib/connectors/delivery-gateway", () => ({
  enqueueAuthorized: jest.fn(async () => ({ kind: "queued" })),
}))
import "./send-voice"
import { getSharedBuiltInSkillRegistry } from "../registry"
import { getRunningAdapter } from "@/lib/connectors/lifecycle"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import { synthesizeConnectorVoice } from "@/lib/connectors/voice"
import { enqueueAuthorized } from "@/lib/connectors/delivery-gateway"
import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { getCharacter } from "@/lib/db/characters"
beforeEach(() => jest.clearAllMocks())
it("synthesizes through the shared TTS service and queues the captured destination with authorization", async () => {
  const target = {
    address: { conversationKey: "qq-official:a:g" },
    conversationRef: { platform: "qq-official", scene: "group", sceneId: "g", msgId: "captured" },
  }
  const adapter = { id: "a", health: () => ({ state: "running" }) }
  jest.mocked(getRunningAdapter).mockReturnValue({ adapter } as never)
  jest.mocked(getConnectorConversationState).mockResolvedValue({ deliveryTarget: target } as never)
  jest.mocked(synthesizeConnectorVoice).mockResolvedValue({
    type: "voice",
    url: "data:audio/mpeg;base64,AQID",
    mimeType: "audio/mpeg",
    transcript: "Hello",
  })
  const skill = getSharedBuiltInSkillRegistry().get("im.send_voice")!
  expect(skill).toMatchObject({ mutation: "write", imAccess: "opt-in" })
  jest.mocked(findSessionByConversationKey).mockResolvedValue({ characterId: "speaker" } as never)
  jest
    .mocked(getCharacter)
    .mockResolvedValue({ voiceProfile: { provider: "openai", voiceId: "nova" } } as never)
  await skill.execute(
    { conversationKey: "qq-official:a:g", text: "Hello" },
    { sessionId: "s", outboundAuthorization: { kind: "human", actor: "connector-user" } }
  )
  expect(synthesizeConnectorVoice).toHaveBeenCalledWith({
    adapter,
    target: target.conversationRef,
    text: "Hello",
    signal: undefined,
    character: { voiceProfile: { provider: "openai", voiceId: "nova" } },
  })
  expect(enqueueAuthorized).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "skill",
      authorization: { kind: "human", actor: "connector-user" },
      request: expect.objectContaining({
        deliveryTarget: target,
        segments: [expect.objectContaining({ type: "voice", mimeType: "audio/mpeg" })],
      }),
    }),
    { signal: undefined }
  )
})
it("refuses a missing captured target before synthesis or delivery", async () => {
  jest.mocked(getConnectorConversationState).mockResolvedValue(undefined)
  jest.mocked(findSessionByConversationKey).mockResolvedValue(undefined)
  await expect(
    getSharedBuiltInSkillRegistry().get("im.send_voice")!.preflight!(
      { conversationKey: "qq-official:a:unknown", text: "Hello" },
      { sessionId: "s" }
    )
  ).rejects.toThrow(/captured destination/)
  expect(synthesizeConnectorVoice).not.toHaveBeenCalled()
  expect(enqueueAuthorized).not.toHaveBeenCalled()
})

it("cancels during synthesis without putting any voice into the delivery queue", async () => {
  const controller = new AbortController()
  const target = {
    address: { conversationKey: "qq-official:a:u" },
    conversationRef: { platform: "qq-official", scene: "c2c", sceneId: "u" },
  }
  jest
    .mocked(getRunningAdapter)
    .mockReturnValue({ adapter: { id: "a", health: () => ({ state: "running" }) } } as never)
  jest.mocked(getConnectorConversationState).mockResolvedValue({ deliveryTarget: target } as never)
  jest.mocked(findSessionByConversationKey).mockResolvedValue(undefined)
  jest.mocked(synthesizeConnectorVoice).mockImplementation(async () => {
    controller.abort()
    return { type: "voice", url: "data:audio/silk;base64,AQID", mimeType: "audio/silk" }
  })
  await expect(
    getSharedBuiltInSkillRegistry()
      .get("im.send_voice")!
      .execute(
        { conversationKey: "qq-official:a:u", text: "Hello" },
        { sessionId: "s", signal: controller.signal }
      )
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(enqueueAuthorized).not.toHaveBeenCalled()
  expect(synthesizeConnectorVoice).toHaveBeenCalledWith(
    expect.objectContaining({ signal: controller.signal })
  )
})
