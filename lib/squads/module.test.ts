import { TEAM_TOOL_NAMES } from "./collaboration-tools"
import { SQUAD_TOOL_NAMES } from "./template-tools"
import squads from "./module"

describe("squads module manifest", () => {
  it("declares a stable module whose real-world smoke is still owed", () => {
    expect(squads).toMatchObject({ id: "squads", kind: "module", stage: "stable" })
    expect(squads.acceptance).toEqual({ realSmoke: "pending" })
  })

  it("owns the settings section where the agent.team.panel slot names it, and the /agent-teams redirect", () => {
    expect(squads.owns).toEqual([
      "app/agent-teams/",
      "components/settings/agent/agent-team-templates-section",
      "components/settings/squads/",
    ])
  })

  it("lists /squad as data and loads its handler only when asked", async () => {
    const [command] = squads.slashCommands
    expect(command).toMatchObject({
      name: "squad",
      category: "goal",
      argumentOptions: ["status", "list", "run", "pause", "resume", "stop", "tasks"],
    })
    const loaded = await command.load()
    expect(typeof loaded.run).toBe("function")
  })

  it("loads the Squads search provider under its stable id", async () => {
    const { searchProviders } = await squads.searchProviders()
    expect(searchProviders.map((provider) => provider.id)).toEqual(["builtin.squads"])
  })

  it("runs the Squad bootstrap on every host from one adapter, waiting for its boot group", () => {
    expect(squads.runtimes).toEqual([
      {
        name: "agent-team-runtime",
        criticality: "optional",
        boot: "knowledge-agents",
        adapters: {
          brain: { module: "./runtime/squad-bootstrap", hosts: ["brain"] },
          desktop: "./runtime/squad-bootstrap",
          mobile: "./runtime/squad-bootstrap",
        },
      },
    ])
  })

  it("declares the collaboration tools without a tier, and the Squad template tools allowed", async () => {
    const declare = squads.tools!.declare
    expect(Object.keys(declare).sort()).toEqual(
      [...Object.values(TEAM_TOOL_NAMES), ...Object.values(SQUAD_TOOL_NAMES)].sort()
    )
    const teamReads = new Set<string>([
      TEAM_TOOL_NAMES.readMemory,
      TEAM_TOOL_NAMES.listMembers,
      TEAM_TOOL_NAMES.getTask,
      TEAM_TOOL_NAMES.twinKnowledgeSearch,
    ])
    for (const name of Object.values(TEAM_TOOL_NAMES)) {
      expect(declare[name]).toEqual({
        consent: "default",
        effect: teamReads.has(name) ? "read" : "write",
        cancellable: false,
      })
    }
    // Reviewed by the outbound engine by name, never counted as external-send.
    expect(declare.team_post_to_chat.effect).toBe("write")
    // The writes ask the consent broker inside the runner (the
    // template tools' subject), so the tier allows them.
    for (const name of Object.values(SQUAD_TOOL_NAMES)) {
      expect(declare[name]).toEqual({
        consent: "allow",
        effect: name === SQUAD_TOOL_NAMES.list ? "read" : "write",
        cancellable: false,
      })
    }
    const { toolFamily } = await squads.tools!.load()
    expect(typeof toolFamily.run).toBe("function")
  })

  it("provides the Squad side of the template platform", async () => {
    const provided = squads.provides!.find((entry) => entry.port === "squad-templates")!
    const { port } = (await provided.load()) as { port: { legacyTemplates: unknown } }
    expect(typeof port.legacyTemplates).toBe("function")
  })

  it("owns the team definition pulls through its sync handlers", async () => {
    expect(squads.syncHandlers?.tables).toEqual(["agentTeams", "agentTeammates", "agentTeamTasks"])
    const { syncHandlers } = await squads.syncHandlers!.load()
    expect(Object.keys(syncHandlers).sort()).toEqual([
      "agentTeamTasks",
      "agentTeammates",
      "agentTeams",
    ])
  })
})
