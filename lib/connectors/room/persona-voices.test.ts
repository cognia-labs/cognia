import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import {
  RESPOND_VIA_ECHO_WAIT_MS,
  findRespondViaEcho,
  memberVoiceAdapterId,
  personaVoiceRoomOf,
  voiceNeedsSignature,
} from "./persona-voices"

const room = { characterTeamId: "ct", memberBotAdapterIds: { c_ana: "bot_b", c_ben: "bot_c" } }

function groupEvent(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    adapterId: "bot_a",
    platform: "slack",
    conversationKey: "slack:bot_a:C1",
    messageId: "m_echo",
    channel: { id: "C1", kind: "group" },
    ...over,
  } as NormalizedInboundEvent
}

describe("which bot a member speaks through", () => {
  it("is the one its room maps, only with a character team", () => {
    expect(memberVoiceAdapterId(room, "c_ana")).toBe("bot_b")
    expect(memberVoiceAdapterId(room, "c_cy")).toBeUndefined()
    expect(memberVoiceAdapterId({ memberBotAdapterIds: room.memberBotAdapterIds }, "c_ana")).toBe(
      undefined
    )
    expect(memberVoiceAdapterId(null, "c_ana")).toBeUndefined()
    expect(
      memberVoiceAdapterId({ characterTeamId: "ct", memberBotAdapterIds: { c_ana: "  " } }, "c_ana")
    ).toBeUndefined()
  })

  it("goes unsigned only through a bot that speaks for that member alone", () => {
    expect(voiceNeedsSignature(room, "c_ana", "bot_b", "bot_a")).toBe(false)
    // The room's own bot, including a fallback to it.
    expect(voiceNeedsSignature(room, "c_ana", "bot_a", "bot_a")).toBe(true)
    // A rule's respond-via target that is not the member's voice.
    expect(voiceNeedsSignature(room, "c_ana", "bot_c", "bot_a")).toBe(true)
    // Two members sharing one bot.
    const shared = {
      characterTeamId: "ct",
      memberBotAdapterIds: { c_ana: "bot_b", c_ben: "bot_b" },
    }
    expect(voiceNeedsSignature(shared, "c_ana", "bot_b", "bot_a")).toBe(true)
  })
})

describe("personaVoiceRoomOf", () => {
  const bots = [
    { id: "bot_a", type: "slack", enabled: true },
    { id: "bot_b", type: "slack", enabled: true },
    { id: "bot_off", type: "slack", enabled: false },
  ] as AdapterInstanceRow[]
  const deps = (overrides: Record<string, unknown>) => ({
    listAdapters: jest.fn(async () => bots),
    readOverride: jest.fn(async (key: string) => overrides[key] as never),
  })

  it("names the sibling's room in the same chat that uses this bot as a voice", async () => {
    const d = deps({ "slack:bot_a:C1": room })
    const event = groupEvent({ adapterId: "bot_b", conversationKey: "slack:bot_b:C1" })
    expect(await personaVoiceRoomOf(event, { id: "bot_b", type: "slack" }, d)).toBe(
      "slack:bot_a:C1"
    )
    // A disabled bot's room is not read: it answers nobody.
    expect(d.readOverride).not.toHaveBeenCalledWith("slack:bot_off:C1")
  })

  it("finds the room from a thread of the same chat", async () => {
    const event = groupEvent({
      adapterId: "bot_b",
      conversationKey: "slack:bot_b:C1:T9",
      channel: { id: "T9", kind: "thread", platformChannelId: "C1" },
    } as never)
    const d = deps({ "slack:bot_a:C1": room })
    expect(await personaVoiceRoomOf(event, { id: "bot_b", type: "slack" }, d)).toBe(
      "slack:bot_a:C1"
    )
  })

  it("is nobody's voice without a mapping, in another chat, or in a one-to-one chat", async () => {
    const event = groupEvent({ adapterId: "bot_b", conversationKey: "slack:bot_b:C1" })
    expect(
      await personaVoiceRoomOf(event, { id: "bot_b", type: "slack" }, deps({}))
    ).toBeUndefined()
    expect(
      await personaVoiceRoomOf(
        event,
        { id: "bot_b", type: "slack" },
        deps({ "slack:bot_a:C1": { memberBotAdapterIds: room.memberBotAdapterIds } })
      )
    ).toBeUndefined()
    expect(
      await personaVoiceRoomOf(
        groupEvent({ adapterId: "bot_b", channel: { id: "D1", kind: "private" } } as never),
        { id: "bot_b", type: "slack" },
        deps({ "slack:bot_a:D1": room })
      )
    ).toBeUndefined()
  })
})

describe("findRespondViaEcho", () => {
  const job = (over: Partial<OutboundJobRow>): OutboundJobRow =>
    ({
      id: "job_1",
      adapterId: "bot_b",
      conversationKey: "slack:bot_b:C1",
      source: "ai-run",
      status: "sent",
      platformMessageId: "m_echo",
      createdAt: 0,
      authorizationProvenance: {
        authorization: { kind: "origin-reply", inboundConversationKey: "slack:bot_a:C1" },
      },
      ...over,
    }) as OutboundJobRow

  function deps(sequence: OutboundJobRow[][]) {
    let clock = 1_000_000
    let call = 0
    return {
      listJobs: jest.fn(async () => sequence[Math.min(call++, sequence.length - 1)]!),
      now: () => clock,
      sleep: jest.fn(async (ms: number) => {
        clock += ms
      }),
    }
  }

  it("is the reply this conversation sent through the sibling", async () => {
    const d = deps([[job({})]])
    expect((await findRespondViaEcho(groupEvent(), "bot_b", d))?.id).toBe("job_1")
    expect(d.listJobs).toHaveBeenCalledWith("slack:bot_b:C1", 1_000_000 - 10 * 60_000)
  })

  it("is nothing for the sibling's own replies, another chat's, or another message", async () => {
    const others = [
      job({ id: "own", authorizationProvenance: undefined }),
      job({
        id: "other-chat",
        authorizationProvenance: {
          authorization: { kind: "origin-reply", inboundConversationKey: "slack:bot_a:C2" },
        } as never,
      }),
      job({ id: "manual", source: "manual" }),
      job({ id: "later", platformMessageId: "m_other" }),
    ]
    expect(await findRespondViaEcho(groupEvent(), "bot_b", deps([others]))).toBeUndefined()
  })

  it("waits briefly for a send that has not reported its id yet", async () => {
    const racing = job({ status: "sending", platformMessageId: undefined })
    const d = deps([[racing], [racing], [job({})]])
    expect((await findRespondViaEcho(groupEvent(), "bot_b", d))?.id).toBe("job_1")
    expect(d.sleep).toHaveBeenCalledTimes(2)
  })

  it("gives up once the wait is over", async () => {
    const racing = job({ status: "pending", platformMessageId: undefined })
    const d = deps([[racing]])
    expect(await findRespondViaEcho(groupEvent(), "bot_b", d)).toBeUndefined()
    const waited = d.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)
    expect(waited).toBeGreaterThanOrEqual(RESPOND_VIA_ECHO_WAIT_MS)
    expect(waited).toBeLessThan(RESPOND_VIA_ECHO_WAIT_MS + 1_000)
  })

  it("does not wait when nothing is in flight", async () => {
    const d = deps([[job({ platformMessageId: "m_other" })]])
    expect(await findRespondViaEcho(groupEvent(), "bot_b", d)).toBeUndefined()
    expect(d.sleep).not.toHaveBeenCalled()
  })
})
