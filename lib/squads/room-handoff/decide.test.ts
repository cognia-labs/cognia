/** @jest-environment node */
import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import {
  __setRoomHandoffDecideDepsForTesting,
  decideRoomSquadHandoff,
  type RoomHandoffDecideDeps,
} from "./decide"
import { handoffDecisionOf } from "./proposal"

const ROOM = "room-1"
const room = { id: ROOM, kind: "team", teamId: "team-1", projectId: "p-1" } as ChatSession

function world(options: { input?: Record<string, unknown>; output?: unknown } = {}) {
  let messages: UIMessage[] = [
    {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-room_handoff_to_squad",
          toolCallId: "tu-1",
          state: "output-available",
          input: options.input ?? { brief: "Write a hello script", squadId: "sq-1" },
          output: options.output ?? {
            status: "proposed",
            proposalId: "tu-1",
            brief: "Write a hello script",
            memberRunId: "execution:tool:member",
          },
        },
      ],
      metadata: { senderId: "ava" },
    } as unknown as UIMessage,
  ]
  const delegations = new Map<string, ExecutionRun[]>()
  let outcome: (value: ChildRunOutcome) => void = () => undefined
  const deps: RoomHandoffDecideDeps = {
    getSession: jest.fn(async (id: string) => (id === ROOM ? room : undefined)),
    readMessages: jest.fn(async () => messages),
    patchMessage: jest.fn(async (_roomId, messageId, apply) => {
      const index = messages.findIndex((message) => message.id === messageId)
      if (index < 0) return false
      messages = messages.map((message, i) => (i === index ? apply(message) : message))
      return true
    }),
    getSquad: jest.fn((id: string) =>
      id === "sq-1"
        ? { id, name: "Builders" }
        : id === "sq-2"
          ? { id, name: "Reviewers" }
          : undefined
    ),
    acceptDelegation: jest.fn(async (input) => {
      const runId = `execution:delegation:${input.delegationId}`
      const created = !delegations.has(runId)
      if (created) delegations.set(runId, [])
      return { runId, created }
    }),
    listAttempts: jest.fn(async (runId: string) => delegations.get(runId) ?? []),
    launch: jest.fn(async (input) => {
      delegations.get(input.delegationRunId)?.push({ id: "execution:team:r1" } as ExecutionRun)
      return {
        started: true as const,
        childId: "r1",
        executionRunId: "execution:team:r1",
        outcome: new Promise<ChildRunOutcome>((resolve) => {
          outcome = resolve
        }),
      }
    }),
    failDelegation: jest.fn(async () => undefined),
    watchAttempt: jest.fn(),
    now: () => 42,
  }
  __setRoomHandoffDecideDepsForTesting(deps)
  return {
    deps,
    decisionOnReply: () => handoffDecisionOf(messages[0]!, "tu-1"),
    settle: (value: ChildRunOutcome) => outcome(value),
  }
}

afterEach(() => __setRoomHandoffDecideDepsForTesting(null))

const confirm = (extra: Partial<{ squadId: string; roomId: string; toolUseId: string }> = {}) =>
  decideRoomSquadHandoff(
    { roomId: ROOM, toolUseId: "tu-1", decision: "confirm", ...extra },
    { kind: "local" }
  )

describe("decideRoomSquadHandoff", () => {
  it("takes the work on as the member turn's child, launches the Squad and records it on the reply", async () => {
    const w = world()
    const result = await confirm()
    const decision = {
      status: "started",
      squadId: "sq-1",
      squadName: "Builders",
      delegationRunId: "execution:delegation:room-handoff:tu-1",
      squadRunId: "execution:team:r1",
      decidedAt: 42,
      decidedBy: { kind: "local" },
    }
    expect(result).toEqual({ ok: true, decision })
    expect(w.decisionOnReply()).toEqual(decision)
    expect(w.deps.acceptDelegation).toHaveBeenCalledWith({
      delegationId: "room-handoff:tu-1",
      title: "Builders",
      sessionId: ROOM,
      projectId: "p-1",
      parentRunId: "execution:tool:member",
    })
    expect(w.deps.launch).toHaveBeenCalledWith({
      delegationRunId: "execution:delegation:room-handoff:tu-1",
      roomId: ROOM,
      squadId: "sq-1",
      squadName: "Builders",
      brief: "Write a hello script",
    })
    expect(w.deps.watchAttempt).toHaveBeenCalledWith(
      {
        roomId: ROOM,
        toolUseId: "tu-1",
        proposerId: "ava",
        squadId: "sq-1",
        squadName: "Builders",
        brief: "Write a hello script",
        delegationRunId: "execution:delegation:room-handoff:tu-1",
        squadRunId: "execution:team:r1",
        startedAt: 42,
      },
      expect.any(Promise)
    )
  })

  it("starts one Squad run for two presses at once, and answers the second with the first's decision", async () => {
    const w = world()
    const [first, second] = await Promise.all([confirm(), confirm({ squadId: "sq-2" })])
    expect(first).toMatchObject({ ok: true, decision: { squadId: "sq-1" } })
    expect(second).toMatchObject({ ok: true, already: true, decision: { squadId: "sq-1" } })
    expect(w.deps.launch).toHaveBeenCalledTimes(1)
  })

  it("records an attempt a lost write left behind instead of launching a second", async () => {
    const w = world()
    await w.deps.acceptDelegation({
      delegationId: "room-handoff:tu-1",
      title: "x",
      sessionId: ROOM,
    })
    await w.deps.launch({
      delegationRunId: "execution:delegation:room-handoff:tu-1",
      roomId: ROOM,
      squadId: "sq-1",
      squadName: "Builders",
      brief: "x",
    })
    ;(w.deps.launch as jest.Mock).mockClear()
    await expect(confirm()).resolves.toMatchObject({
      ok: true,
      decision: { status: "started", squadRunId: "execution:team:r1" },
    })
    expect(w.deps.launch).not.toHaveBeenCalled()
    expect(w.decisionOnReply()).toMatchObject({ status: "started" })
  })

  it("takes the person's pick over the member's, and needs one when the member named none", async () => {
    const w = world({ input: { brief: "Review it" } })
    await expect(confirm()).resolves.toEqual({ ok: false, reason: "squad_required" })
    await expect(confirm({ squadId: "nope" })).resolves.toEqual({
      ok: false,
      reason: "squad_not_found",
    })
    await expect(confirm({ squadId: "sq-2" })).resolves.toMatchObject({
      ok: true,
      decision: { squadId: "sq-2", squadName: "Reviewers" },
    })
    expect(w.deps.acceptDelegation).toHaveBeenCalledTimes(1)
  })

  it("records a decline, and starts nothing", async () => {
    const w = world()
    await expect(
      decideRoomSquadHandoff(
        { roomId: ROOM, toolUseId: "tu-1", decision: "decline" },
        { kind: "device", deviceId: "phone-1" }
      )
    ).resolves.toEqual({
      ok: true,
      decision: {
        status: "declined",
        decidedAt: 42,
        decidedBy: { kind: "device", deviceId: "phone-1" },
      },
    })
    expect(w.deps.acceptDelegation).not.toHaveBeenCalled()
    await expect(confirm()).resolves.toMatchObject({
      ok: true,
      already: true,
      decision: { status: "declined" },
    })
  })

  it("closes the delegation and records the refusal when the Squad run does not start", async () => {
    const w = world()
    ;(w.deps.launch as jest.Mock).mockResolvedValueOnce({
      started: false,
      reason: "engine_refused",
      detail: "already_running",
    })
    await expect(confirm()).resolves.toEqual({
      ok: true,
      decision: {
        status: "failed",
        squadId: "sq-1",
        reason: "engine_refused: already_running",
        decidedAt: 42,
        decidedBy: { kind: "local" },
      },
    })
    expect(w.deps.failDelegation).toHaveBeenCalledWith("execution:delegation:room-handoff:tu-1")
    expect(w.deps.watchAttempt).not.toHaveBeenCalled()
  })

  it("refuses outside a room this host runs and for a proposal the room does not hold", async () => {
    world()
    await expect(confirm({ roomId: "elsewhere" })).resolves.toEqual({
      ok: false,
      reason: "room_not_found",
    })
    await expect(confirm({ toolUseId: "tu-9" })).resolves.toEqual({
      ok: false,
      reason: "proposal_not_found",
    })
  })

  it("decides in an IM group bound to a character team, as the person who answered its card", async () => {
    const w = world()
    const imGroup = {
      id: ROOM,
      platformBinding: {
        platform: "lark",
        adapterId: "a1",
        conversationKey: "k",
        scopeKind: "group",
      },
    } as unknown as ChatSession
    ;(w.deps.getSession as jest.Mock).mockResolvedValue(imGroup)
    const decidedBy = { kind: "im" as const, adapterId: "a1", remoteUserId: "ou_1" }
    await expect(
      decideRoomSquadHandoff({ roomId: ROOM, toolUseId: "tu-1", decision: "confirm" }, decidedBy)
    ).resolves.toMatchObject({ ok: true, decision: { status: "started", decidedBy } })
    expect(w.decisionOnReply()).toMatchObject({ status: "started", decidedBy })
    // A one-to-one chat is no room, so it holds no hand-off to decide.
    ;(w.deps.getSession as jest.Mock).mockResolvedValue({
      ...imGroup,
      platformBinding: { ...imGroup.platformBinding, scopeKind: "private" },
    })
    await expect(
      decideRoomSquadHandoff({ roomId: ROOM, toolUseId: "tu-1", decision: "decline" }, decidedBy)
    ).resolves.toEqual({ ok: false, reason: "room_not_found" })
  })

  it("starts an auto proposal its own call vouches for before the reply holds the part", async () => {
    const w = world({ input: {} })
    const result = await decideRoomSquadHandoff(
      { roomId: ROOM, toolUseId: "tu-1", decision: "confirm", squadId: "sq-1" },
      { kind: "auto" },
      {
        memberRunId: "execution:tool:call-run",
        proposal: { proposerId: "ava", args: { brief: "Ship it", squadId: "sq-1" } },
      }
    )
    expect(result).toMatchObject({
      ok: true,
      decision: { status: "started", decidedBy: { kind: "auto" } },
    })
    expect(w.deps.acceptDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "execution:tool:call-run" })
    )
    expect(w.deps.launch).toHaveBeenCalledWith(expect.objectContaining({ brief: "Ship it" }))
    // Nothing was written: the reply's part had no brief to read.
    expect(w.decisionOnReply()).toBeUndefined()
  })

  it("reports a write failure as a refusal and never throws", async () => {
    const w = world()
    ;(w.deps.getSession as jest.Mock).mockRejectedValueOnce(new Error("db gone"))
    await expect(confirm()).resolves.toEqual({ ok: false, reason: "write_failed" })
    ;(w.deps.patchMessage as jest.Mock).mockResolvedValueOnce(false)
    await expect(
      decideRoomSquadHandoff(
        { roomId: ROOM, toolUseId: "tu-1", decision: "decline" },
        { kind: "local" }
      )
    ).resolves.toEqual({ ok: false, reason: "write_failed" })
  })
})
