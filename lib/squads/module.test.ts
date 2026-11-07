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
})
