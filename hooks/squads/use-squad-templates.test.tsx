/** @jest-environment jsdom */

// One list and one "use" for every surface that offers Squad templates. The
// Settings library and the `/squads` New Squad dialog must agree on both, or a
// Squad made from one of them ends up without the lineage the other records.

import { act, renderHook } from "@testing-library/react"

import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import type { TemplateRuntime } from "@/lib/templates/runtime"

const applySquadTemplate = jest.fn()
jest.mock("@/lib/agent-team/apply-squad-template", () => ({
  applySquadTemplate: (...args: unknown[]) => applySquadTemplate(...args),
}))

let platform = "desktop"
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }))

const storeState = {
  templates: {} as Record<string, AgentTeamTemplate>,
  createTeam: jest.fn(),
  addTeammate: jest.fn(),
  createTask: jest.fn(),
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

jest.mock("@/lib/plugin/registries/agent-team-template-registry", () => ({
  listAgentTeamTemplateEntries: () => [],
  getTemplateWarnings: () => [],
}))

import { sortSquadTemplates, useApplySquadTemplate, useSquadTemplates } from "./use-squad-templates"

function template(over: Partial<AgentTeamTemplate> & { id: string }): AgentTeamTemplate {
  return {
    name: over.id,
    description: "",
    category: "general",
    teammates: [],
    ...over,
  } as AgentTeamTemplate
}

beforeEach(() => {
  applySquadTemplate.mockReset()
  platform = "desktop"
  storeState.templates = {}
})

describe("sortSquadTemplates", () => {
  it("lists built-ins by category, then the user's by name, then plugin rows", () => {
    const local = [
      template({ id: "u-zed", name: "Zed" }),
      template({ id: "b-research", name: "Deep Dive", category: "research", isBuiltIn: true }),
      template({ id: "u-alpha", name: "Alpha" }),
      template({ id: "b-review", name: "Parallel Review", category: "review", isBuiltIn: true }),
    ]
    const plugin = {
      id: "audit",
      pluginId: "acme",
      entry: {
        name: "Acme Audit",
        description: "",
        category: "security",
        teammates: [],
      },
    } as never

    const { merged, pluginIndex } = sortSquadTemplates(local, [plugin], () => [])

    expect(merged.map((tpl) => tpl.id)).toEqual([
      "b-research",
      "b-review",
      "u-alpha",
      "u-zed",
      "acme:audit",
    ])
    expect(pluginIndex.get("acme:audit")).toEqual({ pluginId: "acme", warnings: [] })
    expect(pluginIndex.has("u-alpha")).toBe(false)
  })
})

describe("useSquadTemplates", () => {
  it("reads the store's templates", () => {
    storeState.templates = { a: template({ id: "a", name: "A" }) }
    const { result } = renderHook(() => useSquadTemplates())
    expect(result.current.merged.map((tpl) => tpl.id)).toEqual(["a"])
  })
})

describe("useApplySquadTemplate", () => {
  const runtime = {} as TemplateRuntime

  it("creates through the platform with the store writers as the fallback", async () => {
    applySquadTemplate.mockResolvedValue({ teamId: "team_9", via: "platform" })
    const tpl = template({ id: "b-review", isBuiltIn: true })
    const { result } = renderHook(() => useApplySquadTemplate(runtime))

    let created: unknown
    await act(async () => {
      created = await result.current(tpl)
    })

    expect(created).toEqual({ teamId: "team_9", via: "platform" })
    expect(applySquadTemplate).toHaveBeenCalledWith({
      template: tpl,
      platform: "desktop",
      actions: {
        createTeam: storeState.createTeam,
        addTeammate: storeState.addTeammate,
        createTask: storeState.createTask,
      },
      runtime,
    })
  })

  it("records a plugin template's source and the surface's platform", async () => {
    platform = "mobile"
    applySquadTemplate.mockResolvedValue({ teamId: "team_1", via: "legacy" })
    const { result } = renderHook(() => useApplySquadTemplate(runtime))

    await act(async () => {
      await result.current(template({ id: "acme:audit" }), "acme")
    })

    expect(applySquadTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { pluginSource: "acme" }, platform: "mobile" })
    )
  })
})
