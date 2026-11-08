/** @jest-environment node */
import type { ChatSession, Character } from "@cognia/agent-config-types"
import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import { subSessionId } from "@/lib/claude/team-session-id"
import {
  ROOM_HANDOFF_INSTRUCTIONS,
  ROOM_HANDOFF_LISTED_SQUADS,
  __setRoomHandoffToolDepsForTesting,
  isRoomHandoffTool,
  roomHandoffToolFamily,
  type RoomHandoffToolDeps,
} from "./tool"

const ROOM = "room-1"
const room = (extra: Partial<ChatSession> = {}) =>
  ({ id: ROOM, kind: "team", teamId: "team-1", ...extra }) as ChatSession

function world(session: ChatSession = room()) {
  const squads = [{ id: "sq-1", name: "Builders" }]
  const deps: RoomHandoffToolDeps = {
    listSquads: () => squads,
    getSession: async (id) => (id === ROOM ? session : undefined),
    decide: jest.fn(async () => ({
      ok: true as const,
      decision: {
        status: "started" as const,
        squadId: "sq-1",
        squadName: "Builders",
        delegationRunId: "execution:delegation:room-handoff:tu-1",
        squadRunId: "execution:team:r1",
        decidedAt: 7,
        decidedBy: { kind: "auto" as const },
      },
    })),
  }
  __setRoomHandoffToolDepsForTesting(deps)
  return { deps, squads }
}

afterEach(() => __setRoomHandoffToolDepsForTesting(null))

const surfaceCtx = (
  session: ChatSession | null,
  agent: Character | null = { id: "ava" } as Character
) => ({ session, agent }) as unknown as ToolSurfaceContext

const call = (extra: Partial<ToolCallContext> = {}): ToolCallContext => ({
  sessionId: subSessionId(ROOM, "ava", "t1"),
  toolUseId: "tu-1",
  executionRunId: "execution:tool:member",
  outboundAuthorization: { kind: "tool-call", sessionId: ROOM, toolUseId: "tu-1" },
  ...extra,
})

describe("roomHandoffToolFamily.surface", () => {
  it("is offered to a member of a room this host runs, naming the Squads", async () => {
    world()
    const surface = await roomHandoffToolFamily.surface(surfaceCtx(room()))
    expect(surface?.tools.map((tool) => tool.name)).toEqual(["room_handoff_to_squad"])
    expect(surface?.tools[0]?.description).toContain("Builders (sq-1)")
    expect(surface?.instructions).toBe(ROOM_HANDOFF_INSTRUCTIONS)
    expect(isRoomHandoffTool("room_handoff_to_squad")).toBe(true)
    expect(isRoomHandoffTool("team_delegate")).toBe(false)
  })

  it("is offered to no teammate, no shared room, no plain chat and no run without an agent", async () => {
    world()
    expect(await roomHandoffToolFamily.surface(surfaceCtx(room({ teamId: undefined })))).toBeNull()
    expect(
      await roomHandoffToolFamily.surface(surfaceCtx(room({ collaboration: {} as never })))
    ).toBeNull()
    expect(
      await roomHandoffToolFamily.surface(surfaceCtx({ id: "c", kind: "chat" } as never))
    ).toBeNull()
    expect(await roomHandoffToolFamily.surface(surfaceCtx(room(), null))).toBeNull()
  })

  it("names a bounded number of Squads, and says so when there are none", async () => {
    const w = world()
    w.squads.splice(0)
    expect(
      (await roomHandoffToolFamily.surface(surfaceCtx(room())))?.tools[0]?.description
    ).toContain("There are no Squads yet")
    for (let i = 0; i < ROOM_HANDOFF_LISTED_SQUADS + 3; i += 1)
      w.squads.push({ id: `sq-${i}`, name: `S${i}` })
    const description = (await roomHandoffToolFamily.surface(surfaceCtx(room())))?.tools[0]
      ?.description
    expect(description).toContain("and others")
    expect(description).not.toContain(`S${ROOM_HANDOFF_LISTED_SQUADS}`)
  })
})

describe("roomHandoffToolFamily.run", () => {
  it("proposes in a confirm room, naming the member's run, and decides nothing", async () => {
    const w = world()
    await expect(
      roomHandoffToolFamily.run(
        "room_handoff_to_squad",
        { brief: " Write a hello script ", squadId: "sq-1" },
        call()
      )
    ).resolves.toEqual({
      status: "proposed",
      proposalId: "tu-1",
      brief: "Write a hello script",
      squadId: "sq-1",
      memberRunId: "execution:tool:member",
    })
    expect(w.deps.decide).not.toHaveBeenCalled()
  })

  it("proposes in an auto room when the member named no Squad", async () => {
    const w = world(room({ roomSettings: { squadHandoff: "auto" } } as never))
    await expect(
      roomHandoffToolFamily.run("room_handoff_to_squad", { brief: "Do it" }, call())
    ).resolves.toMatchObject({ status: "proposed" })
    expect(w.deps.decide).not.toHaveBeenCalled()
  })

  it("starts the Squad run in an auto room through the same decision, vouching for its proposal", async () => {
    const w = world(room({ roomSettings: { squadHandoff: "auto" } } as never))
    await expect(
      roomHandoffToolFamily.run(
        "room_handoff_to_squad",
        { brief: "Write a hello script", squadId: "sq-1" },
        call()
      )
    ).resolves.toEqual({
      status: "started",
      proposalId: "tu-1",
      brief: "Write a hello script",
      squadId: "sq-1",
      squadName: "Builders",
      delegationRunId: "execution:delegation:room-handoff:tu-1",
      squadRunId: "execution:team:r1",
      decidedAt: 7,
    })
    expect(w.deps.decide).toHaveBeenCalledWith(
      { roomId: ROOM, toolUseId: "tu-1", decision: "confirm", squadId: "sq-1" },
      { kind: "auto" },
      {
        proposal: { proposerId: "ava", args: { brief: "Write a hello script", squadId: "sq-1" } },
        memberRunId: "execution:tool:member",
      }
    )
  })

  it("reports an auto start that did not happen", async () => {
    const w = world(room({ roomSettings: { squadHandoff: "auto" } } as never))
    ;(w.deps.decide as jest.Mock).mockResolvedValueOnce({ ok: false, reason: "write_failed" })
    await expect(
      roomHandoffToolFamily.run("room_handoff_to_squad", { brief: "Go", squadId: "sq-1" }, call())
    ).resolves.toMatchObject({ status: "refused", reason: "write_failed" })
    ;(w.deps.decide as jest.Mock).mockResolvedValueOnce({
      ok: true,
      decision: {
        status: "failed",
        squadId: "sq-1",
        reason: "engine_refused",
        decidedAt: 1,
        decidedBy: { kind: "auto" },
      },
    })
    await expect(
      roomHandoffToolFamily.run("room_handoff_to_squad", { brief: "Go", squadId: "sq-1" }, call())
    ).resolves.toMatchObject({ status: "refused", reason: "engine_refused" })
  })

  it("refuses a caller outside a room, a missing brief, an unknown Squad and a room it does not run", async () => {
    world()
    await expect(
      roomHandoffToolFamily.run(
        "room_handoff_to_squad",
        { brief: "Go" },
        call({ sessionId: "chat-1" })
      )
    ).resolves.toMatch(/only available to a room member/)
    await expect(roomHandoffToolFamily.run("room_handoff_to_squad", {}, call())).resolves.toMatch(
      /needs a brief/
    )
    await expect(
      roomHandoffToolFamily.run("room_handoff_to_squad", { brief: "Go", squadId: "nope" }, call())
    ).resolves.toMatch(/no Squad nope/)
    world(room({ collaboration: {} as never }))
    await expect(
      roomHandoffToolFamily.run("room_handoff_to_squad", { brief: "Go" }, call())
    ).resolves.toMatch(/room this host runs/)
  })
})
