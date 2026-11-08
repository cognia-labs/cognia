import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import { TEAM_MESSAGING_PROTOCOL, TEAM_TOOL_NAMES, teamToolFamily } from "./collaboration-tools"
import { SQUAD_TOOL_NAMES, templateToolFamily } from "./template-tools"
import { toolFamily } from "./agent-tools"
import {
  ROOM_HANDOFF_INSTRUCTIONS,
  __setRoomHandoffToolDepsForTesting,
  roomHandoffToolFamily,
} from "./room-handoff/tool"
import {
  clearTeamDispatchContext,
  registerTeamDispatchContext,
} from "@/lib/claude/agents/dispatch-context-registry"

function surfaceCtx(selfInvokeTools: Record<string, boolean>): ToolSurfaceContext {
  return {
    session: { id: "team-sess", kind: "team" } as ToolSurfaceContext["session"],
    agent: null,
    settings: { selfInvokeTools } as unknown as ToolSurfaceContext["settings"],
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
  }
}

const call: ToolCallContext = {
  sessionId: "team-sess",
  toolUseId: "use-1",
  executionRunId: "run-1",
  outboundAuthorization: { kind: "tool-call", sessionId: "team-sess", toolUseId: "use-1" },
}

// A teammate's own dispatch session: the collaboration half is offered only there.
beforeEach(() =>
  registerTeamDispatchContext("team-sess", { teamId: "t", teammateId: "m", teammateName: "M" })
)
afterEach(() => {
  clearTeamDispatchContext("team-sess")
  __setRoomHandoffToolDepsForTesting(null)
  jest.restoreAllMocks()
})

describe("the squads tool family", () => {
  it("offers each half under its own switch, the protocol only with the collaboration tools", async () => {
    const both = await toolFamily.surface(surfaceCtx({ teamCollaboration: true, templates: true }))
    const names = both!.tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([TEAM_TOOL_NAMES.sendMessage, SQUAD_TOOL_NAMES.list])
    )
    expect(both!.instructions).toBe(TEAM_MESSAGING_PROTOCOL)

    const templatesOnly = await toolFamily.surface(surfaceCtx({ templates: true }))
    expect(templatesOnly!.tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(SQUAD_TOOL_NAMES).sort()
    )
    expect(templatesOnly!.instructions).toBeUndefined()

    const teamOnly = await toolFamily.surface(surfaceCtx({ teamCollaboration: true }))
    expect(teamOnly!.tools.map((tool) => tool.name)).not.toContain(SQUAD_TOOL_NAMES.list)
  })

  it("offers nothing when neither half is switched on", async () => {
    expect(await toolFamily.surface(surfaceCtx({}))).toBeNull()
  })

  it("offers a room's member the hand-off, with its instructions beside the templates'", async () => {
    __setRoomHandoffToolDepsForTesting({
      listSquads: () => [{ id: "sq-1", name: "Builders" }],
      getSession: async () => undefined,
      decide: jest.fn(),
    })
    const ctx = {
      ...surfaceCtx({ templates: true }),
      session: { id: "room-1", kind: "team", teamId: "team-1" },
      agent: { id: "ava" },
    } as unknown as ToolSurfaceContext
    const surface = await toolFamily.surface(ctx)
    expect(surface!.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["room_handoff_to_squad", SQUAD_TOOL_NAMES.list])
    )
    expect(surface!.instructions).toBe(ROOM_HANDOFF_INSTRUCTIONS)
  })

  it("routes a call to the half that declares its name", async () => {
    const team = jest.spyOn(teamToolFamily, "run").mockResolvedValue("team")
    const template = jest.spyOn(templateToolFamily, "run").mockResolvedValue("template")
    const room = jest.spyOn(roomHandoffToolFamily, "run").mockResolvedValue("room")
    expect(await toolFamily.run(TEAM_TOOL_NAMES.vote, {}, call)).toBe("team")
    expect(await toolFamily.run(SQUAD_TOOL_NAMES.applyTemplate, {}, call)).toBe("template")
    expect(await toolFamily.run("room_handoff_to_squad", {}, call)).toBe("room")
    expect(team).toHaveBeenCalledWith(TEAM_TOOL_NAMES.vote, {}, call)
    expect(template).toHaveBeenCalledWith(SQUAD_TOOL_NAMES.applyTemplate, {}, call)
    expect(room).toHaveBeenCalledWith("room_handoff_to_squad", {}, call)
  })
})
