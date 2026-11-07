/** @jest-environment jsdom */
/**
 * Capability-audit tests. Pure validation is exercised with a hand-built
 * known-id snapshot; the store-sweep + sidecar path mocks the registry/Dexie
 * sources to empty so any referenced id is flagged.
 */

import "fake-indexeddb/auto"

// Mock every id source to empty so referenced ids are treated as stale.
jest.mock("@/lib/plugin/registries/skill-registry", () => ({ listSkillIds: () => [] }))
jest.mock("@/lib/plugin/registries/mcp-server-preset-registry", () => ({
  listMcpServerPresetIds: () => [],
}))
jest.mock("@/lib/plugin/registries/native-anthropic-tool-registry", () => ({
  listNativeAnthropicToolIds: () => [],
}))
jest.mock("@/lib/plugin/registries/character-pack-registry", () => ({
  listCharacterPackIds: () => [],
}))
jest.mock("@/lib/plugin/registries/subagent-registry", () => ({ listSubagentEntries: () => [] }))
jest.mock("@/lib/ai/agent/external/config/presets", () => ({ getAvailablePresets: () => [] }))
jest.mock("@/lib/db/skills", () => ({ listSkills: async () => [] }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: async () => [] }))
jest.mock("@/lib/db/a2ui-templates", () => ({ listTemplates: async () => [] }))

import {
  validateInstanceCapabilitiesWith,
  auditAllAgentTeamsCapabilities,
  refreshAllInstanceCapabilityWarnings,
  getInstanceCapabilityWarnings,
  teammateWarningsIn,
  subscribeCapabilityWarnings,
  __resetCapabilityWarningsForTesting,
  type KnownCapabilityIds,
} from "./capability-audit"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

const emptyKnown = (): KnownCapabilityIds => ({
  mcpServerIds: new Set(),
  skillIds: new Set(),
  nativeAnthropicToolIds: new Set(),
  characterPackIds: new Set(),
  externalAgentPresetIds: new Set(),
  subagentIds: new Set(),
  a2uiTemplateIds: new Set(),
  sharedMemoryAdapterIds: new Set(),
})

const mkTeam = (over: Partial<AgentTeam> = {}): AgentTeam =>
  ({
    id: "team-1",
    name: "T",
    description: "",
    task: "t",
    status: "idle",
    config: {},
    leadId: "lead-1",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
    ...over,
  }) as AgentTeam

const mkTeammate = (over: Partial<AgentTeammate> = {}): AgentTeammate =>
  ({
    id: "tm-1",
    teamId: "team-1",
    name: "M",
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...over,
  }) as AgentTeammate

describe("validateInstanceCapabilitiesWith (pure)", () => {
  it("flags a missing id in each bucket at team scope", () => {
    const team = mkTeam({
      config: {
        capabilities: {
          skillIds: ["ghost-skill"],
          subagentIds: ["plugin-x:ghost"],
        },
      },
    } as Partial<AgentTeam>)
    const warnings = validateInstanceCapabilitiesWith(emptyKnown(), team)
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-skill", missingId: "ghost-skill" }),
        expect.objectContaining({ code: "missing-subagent", missingId: "plugin-x:ghost" }),
      ])
    )
    expect(warnings.every((w) => w.scope.kind === "team")).toBe(true)
  })

  it("passes when every id resolves", () => {
    const known = emptyKnown()
    known.skillIds.add("real-skill")
    const team = mkTeam({
      config: { capabilities: { skillIds: ["real-skill"] } },
    } as Partial<AgentTeam>)
    expect(validateInstanceCapabilitiesWith(known, team)).toEqual([])
  })

  it("teammate scope checks only the overlay's own add/replace ids", () => {
    const team = mkTeam({
      config: { capabilities: { skillIds: ["team-ghost"] } },
    } as Partial<AgentTeam>)
    const teammate = mkTeammate({
      config: {
        capabilities: {
          skillIds: { add: ["tm-ghost"] },
          subagentIds: { replace: ["tm-sub-ghost"] },
        },
      },
    } as Partial<AgentTeammate>)
    const warnings = validateInstanceCapabilitiesWith(emptyKnown(), team, teammate)
    // team-ghost belongs to the team scope, not the teammate's own ids
    expect(warnings.map((w) => w.missingId).sort()).toEqual(["tm-ghost", "tm-sub-ghost"])
    expect(warnings.every((w) => w.scope.kind === "teammate")).toBe(true)
  })
})

describe("auditAllAgentTeamsCapabilities + sidecar", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    __resetCapabilityWarningsForTesting()
  })

  it("sweeps every team/teammate and groups warnings by team id", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Sweep", task: "t" })
    useAgentTeamStore.getState().updateTeamCapabilities(team.id, { subagentIds: ["ghost-sub"] })

    const result = await auditAllAgentTeamsCapabilities()
    expect(result.totalWarnings).toBeGreaterThanOrEqual(1)
    expect(result.warningsByTeamId[team.id]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-subagent", missingId: "ghost-sub" }),
      ])
    )
  })

  /** The audit reads the catalog's team surface, not a hand-kept copy of four names. */
  it("knows every team-surface built-in subagent", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Built-ins", task: "t" })
    useAgentTeamStore
      .getState()
      .updateTeamCapabilities(team.id, { subagentIds: ["general-purpose", "workflow-designer"] })

    const result = await auditAllAgentTeamsCapabilities()
    expect(result.warningsByTeamId[team.id] ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing-subagent" })])
    )
  })

  it("refreshAllInstanceCapabilityWarnings populates the readable sidecar map", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Sidecar", task: "t" })
    useAgentTeamStore.getState().updateTeamCapabilities(team.id, { skillIds: ["ghost-skill"] })

    await refreshAllInstanceCapabilityWarnings()
    const warnings = getInstanceCapabilityWarnings(team.id)
    expect(warnings.map((w) => w.missingId)).toContain("ghost-skill")
  })

  it("teammateWarningsIn narrows a team's warnings to a single teammate", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Member", task: "t" })
    const teammate = useAgentTeamStore.getState().addTeammate({
      teamId: team.id,
      name: "Worker",
      role: "teammate",
    })
    useAgentTeamStore
      .getState()
      .updateTeammateCapabilities(teammate.id, { characterPackIds: { add: ["ghost-pack"] } })

    await refreshAllInstanceCapabilityWarnings()
    const tmWarnings = teammateWarningsIn(getInstanceCapabilityWarnings(team.id), teammate.id)
    expect(tmWarnings.map((w) => w.missingId)).toContain("ghost-pack")
    expect(tmWarnings.every((w) => w.scope.kind === "teammate")).toBe(true)
  })

  it("notifies subscribers and keeps one snapshot per refresh", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "Live", task: "t" })
    useAgentTeamStore.getState().updateTeamCapabilities(team.id, { skillIds: ["ghost-skill"] })
    const listener = jest.fn()
    const unsubscribe = subscribeCapabilityWarnings(listener)

    expect(getInstanceCapabilityWarnings(team.id)).toBe(getInstanceCapabilityWarnings(team.id))
    await refreshAllInstanceCapabilityWarnings()
    expect(listener).toHaveBeenCalledTimes(1)
    const first = getInstanceCapabilityWarnings(team.id)
    expect(getInstanceCapabilityWarnings(team.id)).toBe(first)

    unsubscribe()
    await refreshAllInstanceCapabilityWarnings()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("teammateWarningsIn ignores team-scope warnings", () => {
    const team = mkTeam({
      config: { capabilities: { skillIds: ["team-ghost"] } },
    } as Partial<AgentTeam>)
    const warnings = validateInstanceCapabilitiesWith(emptyKnown(), team)
    expect(teammateWarningsIn(warnings, "tm-1")).toEqual([])
  })
})
