/** @jest-environment node */
import type { RoomSquadHandoffPort } from "@/types/modules/ports/room-squad-handoff"
import {
  ROOM_HANDOFF_CARD_SQUAD_CHOICES,
  buildRoomHandoffSurface,
  handleRoomHandoffCallback,
  postRoomHandoffCard,
  roomHandoffCardChoices,
  roomHandoffCardOutcome,
  roomHandoffConfirmActionId,
  roomHandoffDeclineActionId,
  roomHandoffPressOf,
} from "./room-handoff-card"
import { namespacedCallbackAction } from "@/lib/claude/hitl/callback-prefixes"

const squads = [
  { id: "sq-1", name: "Builders" },
  { id: "sq-2", name: "Reviewers" },
]

const post = (extra: Partial<Parameters<typeof postRoomHandoffCard>[0]> = {}) => {
  const enqueue = jest.fn(async () => ({ id: "job-1" }))
  const recordBinding = jest.fn(async () => undefined)
  const audit = jest.fn(async () => undefined)
  const promise = postRoomHandoffCard({
    roomId: "room-1",
    toolUseId: "tu-1",
    proposerId: "ava",
    proposerName: "Ava",
    brief: "Write the launch post",
    squads,
    adapterId: "a1",
    conversationKey: "lark:a1:oc_1",
    conversationRef: { platform: "lark", adapterId: "a1" } as never,
    initiatorUserId: "ou_asker",
    now: 5,
    enqueue: enqueue as never,
    recordBinding: recordBinding as never,
    audit: audit as never,
    ...extra,
  })
  return { promise, enqueue, recordBinding, audit }
}

describe("the room hand-off card", () => {
  it("confirms the Squad a proposal names with one button", () => {
    expect(roomHandoffCardChoices(squads, "sq-2")).toEqual({
      choices: [{ id: "sq-2", name: "Reviewers" }],
      named: true,
      moreSquads: false,
    })
    const surface = buildRoomHandoffSurface({
      bindingId: "b1",
      proposerName: "Ava",
      brief: "Write the launch post",
      choices: [{ id: "sq-2", name: "Reviewers" }],
      named: true,
      moreSquads: false,
    })
    const components = surface.components as Record<string, Record<string, unknown>>
    expect(components.actions?.children).toEqual(["confirm0", "decline"])
    expect(components.confirm0).toMatchObject({ action: "approve", value: "rhoc:b1.0" })
    expect(components.decline).toMatchObject({ action: "cancel", value: "rhod:b1" })
    expect(String(components.prompt?.text)).toContain('the Squad "Reviewers"')
    expect(String(components.prompt?.text)).toContain("Write the launch post")
    expect(surface.widget?.fallbackText).toContain("1 确认 / Confirm / 2 拒绝 / Decline")
    expect(namespacedCallbackAction(roomHandoffConfirmActionId("b1", 0))).toBe("approve")
    expect(namespacedCallbackAction(roomHandoffDeclineActionId("b1"))).toBe("cancel")
  })

  it("offers a bounded set of Squads when the proposal names none, or a deleted one", () => {
    const many = Array.from({ length: ROOM_HANDOFF_CARD_SQUAD_CHOICES + 2 }, (_, i) => ({
      id: `sq-${i}`,
      name: `S${i}`,
    }))
    const picked = roomHandoffCardChoices(many, "sq-gone")
    expect(picked.named).toBe(false)
    expect(picked.choices).toHaveLength(ROOM_HANDOFF_CARD_SQUAD_CHOICES)
    expect(picked.moreSquads).toBe(true)
    const surface = buildRoomHandoffSurface({
      bindingId: "b1",
      proposerName: "Ava",
      brief: "x",
      ...picked,
    })
    const components = surface.components as Record<string, Record<string, unknown>>
    expect(components.confirm1).toMatchObject({ text: "交给 S1 / Start S1", value: "rhoc:b1.1" })
    expect(String(components.prompt?.text)).toContain("Pick any other Squad on the desktop")
    const none = buildRoomHandoffSurface({
      bindingId: "b1",
      proposerName: "Ava",
      brief: "x",
      ...roomHandoffCardChoices([], undefined),
    })
    expect((none.components as Record<string, Record<string, unknown>>).actions?.children).toEqual([
      "decline",
    ])
    expect(
      String((none.components as Record<string, Record<string, unknown>>).prompt?.text)
    ).toContain("There are no Squads yet")
  })

  it("records one binding per button for the person the room answered, then delivers the card once", async () => {
    const { promise, enqueue, recordBinding, audit } = post()
    const { surfaceId } = await promise
    expect(surfaceId).toMatch(/^room_handoff:lark:a1:oc_1:/)
    const rows = recordBinding.mock.calls.map(
      (args) => (args as unknown[])[0] as Record<string, unknown>
    )
    expect(rows.map((row) => [row.componentId, row.payload, row.allowedActions])).toEqual([
      [
        "confirm0",
        { roomId: "room-1", toolUseId: "tu-1", decision: "confirm", squadId: "sq-1" },
        ["approve"],
      ],
      [
        "confirm1",
        { roomId: "room-1", toolUseId: "tu-1", decision: "confirm", squadId: "sq-2" },
        ["approve"],
      ],
      ["decline", { roomId: "room-1", toolUseId: "tu-1", decision: "decline" }, ["cancel"]],
    ])
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "room_handoff",
        surfaceId,
        actorScope: { mode: "initiator", allowedUserIds: ["ou_asker"] },
      })
    }
    const delivered = (enqueue.mock.calls[0] as unknown[])[0] as {
      request: { metadata: unknown }
      authorization: unknown
    }
    expect(delivered.request.metadata).toEqual({ idempotencyKey: "room-handoff-card:room-1:tu-1" })
    expect(delivered.authorization).toEqual({
      kind: "system-notice",
      inboundConversationKey: "lark:a1:oc_1",
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "room.handoff_requested",
        fields: {
          roomId: "room-1",
          toolUseId: "tu-1",
          proposerId: "ava",
          choices: ["sq-1", "sq-2"],
        },
      })
    )
  })

  it("leaves the card to operators when the platform named nobody", async () => {
    const { promise, recordBinding } = post({ initiatorUserId: undefined })
    await promise
    expect(
      ((recordBinding.mock.calls[0] as unknown[])[0] as Record<string, unknown>).actorScope
    ).toEqual({
      mode: "operators",
    })
  })
})

describe("handleRoomHandoffCallback", () => {
  const binding = (payload: Record<string, unknown>) => ({ payload })
  const started = {
    ok: true as const,
    decision: {
      status: "started" as const,
      squadId: "sq-1",
      squadName: "Builders",
      delegationRunId: "d",
      squadRunId: "r",
      decidedAt: 1,
      decidedBy: { kind: "im" as const, adapterId: "a1" },
    },
  }

  it("decides a confirm press as the person who pressed, with the Squad its button names", async () => {
    const decide = jest.fn(async () => started)
    const audit = jest.fn(async () => undefined)
    const outcome = await handleRoomHandoffCallback({
      binding: binding({
        roomId: "room-1",
        toolUseId: "tu-1",
        decision: "confirm",
        squadId: "sq-1",
      }),
      cancelled: false,
      adapterId: "a1",
      conversationKey: "k",
      remoteUserId: "ou_1",
      loadDecider: async () => ({ decide }) as RoomSquadHandoffPort,
      audit: audit as never,
    })
    expect(decide).toHaveBeenCalledWith(
      { roomId: "room-1", toolUseId: "tu-1", decision: "confirm", squadId: "sq-1" },
      { kind: "im", adapterId: "a1", remoteUserId: "ou_1" }
    )
    expect(outcome).toMatchObject({ state: "approved", result: started })
    expect(outcome.detail).toContain("Handed to Builders")
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "room.handoff_decided",
        fields: { roomId: "room-1", toolUseId: "tu-1", decision: "confirm", outcome: "started" },
      })
    )
  })

  it("declines a dismissed card whatever its button, without a Squad", async () => {
    const decide = jest.fn(async () => ({
      ok: true as const,
      decision: {
        status: "declined" as const,
        decidedAt: 1,
        decidedBy: { kind: "local" as const },
      },
      already: true,
    }))
    const outcome = await handleRoomHandoffCallback({
      binding: binding({
        roomId: "room-1",
        toolUseId: "tu-1",
        decision: "confirm",
        squadId: "sq-1",
      }),
      cancelled: true,
      adapterId: "a1",
      loadDecider: async () => ({ decide }) as RoomSquadHandoffPort,
      audit: jest.fn(async () => undefined) as never,
    })
    expect(decide).toHaveBeenCalledWith(
      { roomId: "room-1", toolUseId: "tu-1", decision: "decline" },
      { kind: "im", adapterId: "a1" }
    )
    expect(outcome.state).toBe("denied")
    expect(outcome.detail).toContain("decided earlier")
  })

  it("closes as failed for a malformed press, a host without Squads and a decider that throws", async () => {
    const audit = jest.fn(async () => undefined) as never
    await expect(
      handleRoomHandoffCallback({ binding: binding({}), cancelled: false, adapterId: "a1", audit })
    ).resolves.toMatchObject({
      state: "failed",
      result: { ok: false, reason: "proposal_not_found" },
    })
    await expect(
      handleRoomHandoffCallback({
        binding: binding({ roomId: "r", toolUseId: "t", decision: "decline" }),
        cancelled: false,
        adapterId: "a1",
        loadDecider: async () => null,
        audit,
      })
    ).resolves.toMatchObject({ result: { ok: false, reason: "room_not_found" } })
    await expect(
      handleRoomHandoffCallback({
        binding: binding({ roomId: "r", toolUseId: "t", decision: "decline" }),
        cancelled: false,
        adapterId: "a1",
        loadDecider: async () =>
          ({ decide: jest.fn(async () => Promise.reject(new Error("boom"))) }) as never,
        audit,
      })
    ).resolves.toMatchObject({ result: { ok: false, reason: "write_failed" } })
  })

  it("reads a press off its binding", () => {
    expect(
      roomHandoffPressOf(binding({ roomId: "r", toolUseId: "t", decision: "nope" }))
    ).toBeNull()
    expect(
      roomHandoffPressOf(binding({ roomId: "r", toolUseId: "t", decision: "confirm", squadId: "" }))
    ).toEqual({ roomId: "r", toolUseId: "t", decision: "confirm" })
    expect(roomHandoffCardOutcome({ ok: false, reason: "squad_not_found" }).state).toBe("failed")
  })
})
