import type { TemplateRuntime } from "@/lib/templates/runtime"
import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"
import type { AgentTeam, AgentTeamTemplate, AgentTeammate } from "@/types/agent/agent-team"

import {
  SQUAD_TOOL_NAMES,
  __setSquadToolDepsForTesting,
  buildSquadToolEntries,
  runSquadTool,
  templateToolFamily,
  type SquadToolDeps,
} from "./template-tools"

const squadTemplate: AgentTeamTemplate = {
  id: "tpl-1",
  name: "Reviewers",
  description: "Two reviewers",
  category: "review",
  teammates: [
    { name: "Alpha", description: "" },
    { name: "Beta", description: "" },
  ],
}

const team = {
  id: "team-1",
  name: "Alpha squad",
  description: "",
  task: "Ship it",
  status: "idle",
  projectId: "proj-1",
} as AgentTeam

const teammate = {
  id: "mate-1",
  teamId: "team-1",
  name: "Alpha",
  role: "teammate",
  status: "idle",
} as AgentTeammate

interface Harness {
  deps: SquadToolDeps
  consent: jest.Mock
  applySquadTemplate: jest.Mock
  publishSquadTemplate: jest.Mock
  saveAsTemplate: jest.Mock
  teams: Record<string, AgentTeam>
}

function harness(overrides: Partial<SquadToolDeps> = {}): Harness {
  const consent = jest.fn(async () => true)
  const teams: Record<string, AgentTeam> = { [team.id]: team }
  const applySquadTemplate = jest.fn(async () => {
    teams["team-2"] = { ...team, id: "team-2", name: "Reviewers" }
    return { teamId: "team-2", via: "platform" as const }
  })
  const publishSquadTemplate = jest.fn(async () => undefined)
  const saveAsTemplate = jest.fn(
    (teamId: string, name: string, category?: AgentTeamTemplate["category"]) =>
      teamId in teams
        ? { ...squadTemplate, id: "tpl-new", name, category: category ?? "general" }
        : null
  )
  const deps: SquadToolDeps = {
    runtime: {} as TemplateRuntime,
    platform: "desktop",
    consent,
    squads: {
      teams: () => teams,
      teammates: (teamId) => (teamId === team.id ? [teammate] : []),
      templates: () => ({ [squadTemplate.id]: squadTemplate }),
      createTeam: jest.fn(),
      addTeammate: jest.fn(),
      createTask: jest.fn(),
      saveAsTemplate,
    },
    applySquadTemplate,
    publishSquadTemplate,
    ...overrides,
  }
  return { deps, consent, applySquadTemplate, publishSquadTemplate, saveAsTemplate, teams }
}

function surfaceCtx(fields: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext {
  return {
    session: { id: "s1" } as ToolSurfaceContext["session"],
    agent: null,
    settings: { selfInvokeTools: { templates: true } } as ToolSurfaceContext["settings"],
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    ...fields,
  }
}

afterEach(() => __setSquadToolDepsForTesting(null))

describe("surface", () => {
  it("offers the Squad template tools with the template tools' switch", async () => {
    const surface = await templateToolFamily.surface(surfaceCtx())
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(SQUAD_TOOL_NAMES).sort()
    )
    for (const entry of buildSquadToolEntries()) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema.additionalProperties).toBe(false)
    }
  })

  it("offers nothing unless opted in, nor to an IM-bound session or the CLI", async () => {
    expect(
      await templateToolFamily.surface(
        surfaceCtx({
          settings: { selfInvokeTools: { templates: false } } as ToolSurfaceContext["settings"],
        })
      )
    ).toBeNull()
    expect(
      await templateToolFamily.surface(
        surfaceCtx({
          session: { id: "s1", platformBinding: { adapterId: "telegram" } } as never,
        })
      )
    ).toBeNull()
    expect(await templateToolFamily.surface(surfaceCtx({ host: "cli" }))).toBeNull()
  })

  it("runs a call through the injected deps", async () => {
    const h = harness()
    __setSquadToolDepsForTesting(() => h.deps)
    const call = {
      sessionId: "s1",
      toolUseId: "tu-1",
      executionRunId: "run-1",
      outboundAuthorization: { kind: "tool-call", sessionId: "s1", toolUseId: "tu-1" },
    } as const
    expect(await templateToolFamily.run("squad_list", {}, call)).toMatchObject({
      ok: true,
      total: 1,
    })
  })
})

describe("squad tools", () => {
  it("lists squads with teammates plus the templates available", async () => {
    const h = harness()
    const result = (await runSquadTool("squad_list", {}, h.deps)) as {
      squads: Array<{
        teamId: string
        teammates: Array<{ name: string }>
      }>
      templates: Array<{
        templateId: string
        teammates: string[]
      }>
    }
    expect(result.squads).toEqual([
      expect.objectContaining({
        teamId: "team-1",
        teammates: [expect.objectContaining({ name: "Alpha" })],
      }),
    ])
    expect(result.templates).toEqual([
      expect.objectContaining({ templateId: "tpl-1", teammates: ["Alpha", "Beta"] }),
    ])
    const filtered = (await runSquadTool("squad_list", { status: "executing" }, h.deps)) as {
      squads: unknown[]
    }
    expect(filtered.squads).toEqual([])
  })

  it("applies a squad template through the platform after consent", async () => {
    const h = harness()
    const result = await runSquadTool("squad_apply_template", { templateId: "tpl-1" }, h.deps)
    expect(h.consent).toHaveBeenCalledWith("templates:instantiate", "instantiate:tpl-1")
    expect(h.applySquadTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: squadTemplate,
        platform: "desktop",
        runtime: h.deps.runtime,
      })
    )
    expect(result).toEqual(
      expect.objectContaining({ ok: true, teamId: "team-2", via: "platform", name: "Reviewers" })
    )
  })

  it("does not create a squad when the user declines or the template is unknown", async () => {
    const h = harness()
    h.consent.mockResolvedValueOnce(false)
    expect(await runSquadTool("squad_apply_template", { templateId: "tpl-1" }, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "consent_denied" })
    )
    expect(await runSquadTool("squad_apply_template", { templateId: "nope" }, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "not_found" })
    )
    expect(h.applySquadTemplate).not.toHaveBeenCalled()
  })

  it("saves a squad as a template only after library-write consent, then mirrors it", async () => {
    const h = harness()
    const result = await runSquadTool(
      "squad_save_as_template",
      { teamId: "team-1", name: "My reviewers", category: "review" },
      h.deps
    )
    expect(h.consent).toHaveBeenCalledWith("templates:library:write", "library-write:My reviewers")
    expect(h.saveAsTemplate).toHaveBeenCalledWith("team-1", "My reviewers", "review")
    expect(h.publishSquadTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-new", name: "My reviewers" })
    )
    expect(result).toEqual(
      expect.objectContaining({ ok: true, templateId: "tpl-new", mirroredToCatalog: true })
    )
  })

  it("leaves nothing behind when the user declines the library write", async () => {
    const h = harness()
    h.consent.mockResolvedValueOnce(false)
    expect(
      await runSquadTool("squad_save_as_template", { teamId: "team-1", name: "Nope" }, h.deps)
    ).toEqual(expect.objectContaining({ ok: false, code: "consent_denied" }))
    expect(h.saveAsTemplate).not.toHaveBeenCalled()
    expect(h.publishSquadTemplate).not.toHaveBeenCalled()
  })

  it("reports a failed mirror without failing the save, and validates arguments", async () => {
    const h = harness()
    h.publishSquadTemplate.mockRejectedValueOnce(new Error("offline"))
    expect(
      await runSquadTool("squad_save_as_template", { teamId: "team-1", name: "Mirror" }, h.deps)
    ).toEqual(expect.objectContaining({ ok: true, mirroredToCatalog: false }))
    expect(
      await runSquadTool(
        "squad_save_as_template",
        { teamId: "team-1", name: "Bad", category: "cooking" },
        h.deps
      )
    ).toEqual(expect.objectContaining({ ok: false, code: "invalid_arguments" }))
    expect(
      await runSquadTool("squad_save_as_template", { teamId: "ghost", name: "X" }, h.deps)
    ).toEqual(expect.objectContaining({ ok: false, code: "not_found" }))
  })
})

describe("failure contract", () => {
  it("never throws: a throwing store becomes a structured failure", async () => {
    const h = harness()
    h.deps.squads.teams = () => {
      throw new Error("store gone")
    }
    expect(await runSquadTool("squad_list", {}, h.deps)).toEqual({
      ok: false,
      code: "tool_failed",
      error: "store gone",
    })
    expect(await runSquadTool("template_list", {}, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
  })
})
