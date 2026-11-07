import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import { createLegacyTemplateSources } from "./legacy-sources"
import type { FullDomainTemplatePorts } from "./adapters"

const crud = {
  create: async () => ({ id: "created" }),
  snapshot: async () => ({}),
}

const ports: FullDomainTemplatePorts = {
  agentTeam: {
    createTeam: async () => ({ id: "team" }),
    addTeammate: async () => ({ id: "member" }),
    createTask: async () => ({ id: "task" }),
    deleteTeam: async () => undefined,
    snapshot: async () => ({}),
  },
  workflow: crud,
  subagent: crud,
  customMode: crud,
  character: crud,
  skill: crud,
}

describe("legacy template sources", () => {
  it("converts local AgentTeam Twin ids into portable role slots", async () => {
    const [source] = createLegacyTemplateSources({
      ports,
      readers: {
        agentTeams: () => [
          {
            id: "legacy-team",
            name: "Legacy team",
            description: "Portable",
            category: "general",
            config: { knowledgeTwinIds: ["private-team-twin"] },
            teammates: [
              {
                name: "Researcher",
                description: "Research",
                config: { twinId: "private-member-twin", model: "m" },
              },
            ],
          },
        ],
        subagents: () => [],
        customModes: () => [],
        workflows: () => [],
        characters: () => [],
        skills: () => [],
      },
    })

    const row = (await source.read())[0]
    const converted = await source.convert(row)
    const serialized = JSON.stringify(converted)

    expect(converted.inputs.map((slot) => slot.id)).toEqual(["team.knowledge.1", "teammate-1.twin"])
    expect(serialized).not.toContain("private-team-twin")
    expect(serialized).not.toContain("private-member-twin")
  })

  describe("the default squad reader", () => {
    afterEach(() => __resetPortsForTesting())
    const empty = {
      subagents: () => [],
      customModes: () => [],
      workflows: () => [],
      characters: () => [],
      skills: () => [],
    }

    it("reads the user's squad templates through the squad-templates port", async () => {
      const legacyTemplates = jest.fn(() => [
        { id: "mine", name: "Mine", description: "", category: "general" as const, teammates: [] },
      ])
      __setPortForTesting("squad-templates", {
        agentTeam: ports.agentTeam,
        legacyTemplates,
      })
      const [source] = createLegacyTemplateSources({ ports, readers: empty })
      expect(source.domain).toBe("agentTeam")
      expect(await source.read()).toEqual([expect.objectContaining({ id: "mine" })])
      expect(legacyTemplates).toHaveBeenCalled()
    })

    it("reads nothing when no module provides the port", async () => {
      __setPortForTesting("squad-templates", null)
      const [source] = createLegacyTemplateSources({ ports, readers: empty })
      expect(await source.read()).toEqual([])
    })
  })
})
