import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import { TEAM_MESSAGING_PROTOCOL, TEAM_TOOL_NAMES, teamToolFamily } from "./collaboration-tools"
import { SQUAD_TOOL_NAMES, templateToolFamily } from "./template-tools"
import { toolFamily } from "./agent-tools"

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

afterEach(() => jest.restoreAllMocks())

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

  it("routes a call to the half that declares its name", async () => {
    const team = jest.spyOn(teamToolFamily, "run").mockResolvedValue("team")
    const template = jest.spyOn(templateToolFamily, "run").mockResolvedValue("template")
    expect(await toolFamily.run(TEAM_TOOL_NAMES.vote, {}, call)).toBe("team")
    expect(await toolFamily.run(SQUAD_TOOL_NAMES.applyTemplate, {}, call)).toBe("template")
    expect(team).toHaveBeenCalledWith(TEAM_TOOL_NAMES.vote, {}, call)
    expect(template).toHaveBeenCalledWith(SQUAD_TOOL_NAMES.applyTemplate, {}, call)
  })
})
