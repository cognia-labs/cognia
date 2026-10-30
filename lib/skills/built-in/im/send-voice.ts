/** Governed, platform-neutral TTS delivery using an existing conversation. */
import { z } from "zod"
import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { skillDeliveryAuthorization } from "./_helpers"
import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import { parseConversationKey } from "@/types/connectors/event"

const schema = z
  .object({ conversationKey: z.string().min(1), text: z.string().trim().min(1).max(16_384) })
  .strict()
async function targetOf(key: string) {
  const { connectorVoiceFormats } = await import("@/lib/connectors/voice")
  const parsed = parseConversationKey(key)
  const { getRunningAdapter } = await import("@/lib/connectors/lifecycle")
  const adapter = getRunningAdapter(parsed.adapterId)?.adapter
  const session = await findSessionByConversationKey(key)
  const target =
    (await getConnectorConversationState(key))?.deliveryTarget ??
    session?.platformBinding?.deliveryTarget
  if (
    !adapter ||
    adapter.health().state !== "running" ||
    !target ||
    target.address.conversationKey !== key
  )
    throw new Error("Voice delivery requires a running connector and a captured destination")
  connectorVoiceFormats(adapter, target.conversationRef)
  return { adapter, target, characterId: session?.characterId }
}
const skill: BuiltInSkill<typeof schema> = {
  id: "im.send_voice",
  mcpToolName: "im_send_voice",
  family: "im",
  platforms: "any",
  label: { en: "Send voice reply", "zh-CN": "发送语音回复" },
  description: {
    en: "Synthesize a voice message using configured TTS settings and send it to a known conversation. Requires a supported encoded audio format; does not play locally.",
    "zh-CN": "使用已有 TTS 设置生成语音并发送到既有会话，需要目标支持对应音频格式。",
  },
  mutation: "write",
  imAccess: "opt-in",
  requires: ["send.voice"],
  inputSchema: schema,
  preflight: async (args) => {
    await targetOf(args.conversationKey)
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `voice_${crypto.randomUUID()}`,
      title: "Send voice reply",
      summary: args.text,
      details: [{ label: "Conversation", value: args.conversationKey }],
    }),
  execute: async (args, ctx) => {
    ctx.signal?.throwIfAborted()
    const { synthesizeConnectorVoice } = await import("@/lib/connectors/voice")
    const { adapter, target, characterId } = await targetOf(args.conversationKey)
    const { getCharacter } = await import("@/lib/db/characters")
    const character = characterId ? await getCharacter(characterId) : undefined
    const voice = await synthesizeConnectorVoice({
      adapter,
      target: target.conversationRef,
      text: args.text,
      signal: ctx.signal,
      ...(character ? { character: { voiceProfile: character.voiceProfile } } : {}),
    })
    ctx.signal?.throwIfAborted()
    const { enqueueAuthorized } = await import("@/lib/connectors/delivery-gateway")
    ctx.signal?.throwIfAborted()
    const result = await enqueueAuthorized(
      {
        adapterId: adapter.id,
        conversationKey: args.conversationKey,
        source: "skill",
        authorization: skillDeliveryAuthorization(ctx, "im.send_voice"),
        request: {
          conversationRef: target.conversationRef,
          deliveryTarget: target,
          segments: [voice],
          metadata: { idempotencyKey: `voice:${crypto.randomUUID()}` },
        },
      },
      { signal: ctx.signal }
    )
    return { status: result.kind }
  },
}
registerBuiltInSkill(skill)
