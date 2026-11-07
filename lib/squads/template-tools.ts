/**
 * The Squad template tools (ADR-0164), one half of the squads module's tool
 * family (ADR-0250 §14 amendment; composed with the collaboration tools in
 * `./agent-tools.ts`). `squad_list` reads the user's Squads and the squad
 * templates they can apply, `squad_apply_template` creates a Squad from one
 * through the template platform, and `squad_save_as_template` puts an
 * existing Squad in the library.
 *
 * They belong with the template platform's tools in the user's eyes: the one
 * setting (`selfInvokeTools.templates`) switches both on, and every write asks
 * the plugin consent broker under the same subject (the templates module's
 * `agent-tool-kit.ts`). They live here because they drive the agent-team
 * store and the Squad template seams, and the squads module builds on
 * templates, not the other way round.
 */

import type { ModuleToolEntry, ModuleToolFamily } from "@/lib/modules/manifest-types"
import type { TemplatePlatform } from "@/lib/templates/contracts"
import type { TemplateRuntime } from "@/lib/templates/runtime"
import {
  LIST_MAX_ITEMS,
  currentTemplatePlatform,
  denied,
  invalidArguments,
  notFound,
  requestTemplateToolConsent,
  stringArg,
  templateToolsOffered,
  toolFailed,
  type TemplateToolConsentPermission,
} from "@/lib/templates/agent-tool-kit"
import type {
  AddTeammateInput,
  AgentTeam,
  AgentTeamTask,
  AgentTeamTemplate,
  AgentTeammate,
  CreateTaskInput,
  CreateTeamInput,
} from "@/types/agent/agent-team"

export const SQUAD_TOOL_NAMES = {
  list: "squad_list",
  applyTemplate: "squad_apply_template",
  saveAsTemplate: "squad_save_as_template",
} as const

const SQUAD_TEMPLATE_CATEGORIES: readonly AgentTeamTemplate["category"][] = [
  "review",
  "research",
  "development",
  "debugging",
  "analysis",
  "general",
  "documentation",
  "security",
]

export function buildSquadToolEntries(): ModuleToolEntry[] {
  return [
    {
      name: SQUAD_TOOL_NAMES.list,
      description:
        "List the user's Squads (agent teams) with status, task and teammates, plus the squad templates available to apply. Filter squads by `status`.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["idle", "planning", "executing", "paused", "completed", "failed", "cancelled"],
          },
        },
      },
    },
    {
      name: SQUAD_TOOL_NAMES.applyTemplate,
      description:
        "Create a new Squad from a squad template (use `squad_list` to see template ids). Goes through the template platform so the squad records its lineage. The user is asked to confirm before the squad is created.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["templateId"],
        properties: { templateId: { type: "string", minLength: 1 } },
      },
    },
    {
      name: SQUAD_TOOL_NAMES.saveAsTemplate,
      description:
        "Save an existing Squad as a reusable squad template in the user's library, mirrored into the unified template catalog. The user is asked to confirm before the library row is written.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["teamId", "name"],
        properties: {
          teamId: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1, maxLength: 120 },
          category: { type: "string", enum: [...SQUAD_TEMPLATE_CATEGORIES] },
        },
      },
    },
  ]
}

export interface SquadToolStore {
  teams: () => Record<string, AgentTeam>
  teammates: (teamId: string) => AgentTeammate[]
  templates: () => Record<string, AgentTeamTemplate>
  createTeam: (input: CreateTeamInput) => AgentTeam
  addTeammate: (input: AddTeammateInput) => AgentTeammate
  createTask: (input: CreateTaskInput) => AgentTeamTask
  saveAsTemplate: (
    teamId: string,
    name: string,
    category?: AgentTeamTemplate["category"]
  ) => AgentTeamTemplate | null
}

export interface SquadToolDeps {
  runtime: TemplateRuntime
  /** Which platform a squad template is applied for. */
  platform: TemplatePlatform
  /** Ask the user. Resolves `true` when the write may proceed. */
  consent: (permission: TemplateToolConsentPermission, reason: string) => Promise<boolean>
  squads: SquadToolStore
  /**
   * Create a squad from a template through the platform. Production binds
   * `applySquadTemplate` from `./apply-squad-template.ts`.
   */
  applySquadTemplate: (input: {
    template: AgentTeamTemplate
    platform: TemplatePlatform
    actions: Pick<SquadToolStore, "createTeam" | "addTeammate" | "createTask">
    runtime: TemplateRuntime
  }) => Promise<{
    teamId: string
    via: "platform" | "legacy"
  }>
  /**
   * Mirror a freshly saved squad template into the unified catalog. Production
   * binds `publishSquadTemplateToPlatform`. Non-fatal, like the plugin path.
   */
  publishSquadTemplate: (template: AgentTeamTemplate) => Promise<unknown>
}

type SquadToolDepsResolver = () => Promise<SquadToolDeps> | SquadToolDeps

let depsOverride: SquadToolDepsResolver | null = null

/** Inject squad-tool deps (tests / CLI host). Pass `null` to restore the default. */
export function __setSquadToolDepsForTesting(fn: SquadToolDepsResolver | null): void {
  depsOverride = fn
}

/** Resolve the host-side singletons the runner reads and writes through. */
async function resolveSquadToolDeps(): Promise<SquadToolDeps> {
  if (depsOverride) return depsOverride()
  const [
    { getTemplateRuntime },
    { useAgentTeamStore },
    { applySquadTemplate },
    { publishSquadTemplateToPlatform },
    platform,
  ] = await Promise.all([
    import("@/lib/templates/runtime"),
    import("@/stores/squads/agent-team-store/store"),
    import("./apply-squad-template"),
    import("./publish-template-to-platform"),
    currentTemplatePlatform(),
  ])
  const store = () => useAgentTeamStore.getState()
  return {
    runtime: getTemplateRuntime(),
    platform,
    consent: requestTemplateToolConsent,
    squads: {
      teams: () => store().teams,
      teammates: (teamId) => store().getTeammates(teamId),
      templates: () => store().templates,
      createTeam: (input) => store().createTeam(input),
      addTeammate: (input) => store().addTeammate(input),
      createTask: (input) => store().createTask(input),
      saveAsTemplate: (teamId, name, category) => store().saveAsTemplate(teamId, name, category),
    },
    applySquadTemplate: (input) => applySquadTemplate(input),
    publishSquadTemplate: (template) => publishSquadTemplateToPlatform(template),
  }
}

function squadSummary(team: AgentTeam, teammates: AgentTeammate[]) {
  return {
    teamId: team.id,
    name: team.name,
    status: team.status,
    task: team.task,
    ...(team.projectId ? { projectId: team.projectId } : {}),
    teammates: teammates.map((mate) => ({
      teammateId: mate.id,
      name: mate.name,
      role: mate.role,
      status: mate.status,
    })),
  }
}

function squadTemplateSummary(template: AgentTeamTemplate) {
  return {
    templateId: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    teammates: template.teammates.map((mate) => mate.name),
    ...(template.isBuiltIn ? { builtIn: true } : {}),
  }
}

/** Execute one Squad template tool call. Never throws. */
export async function runSquadTool(
  name: string,
  args: Record<string, unknown>,
  deps: SquadToolDeps
): Promise<unknown> {
  try {
    switch (name) {
      case SQUAD_TOOL_NAMES.list: {
        const status = stringArg(args, "status")
        const teams = Object.values(deps.squads.teams()).filter(
          (team) => !status || team.status === status
        )
        const templates = Object.values(deps.squads.templates())
        return {
          ok: true as const,
          squads: teams
            .slice(0, LIST_MAX_ITEMS)
            .map((team) => squadSummary(team, deps.squads.teammates(team.id))),
          total: teams.length,
          truncated: teams.length > LIST_MAX_ITEMS,
          templates: templates.slice(0, LIST_MAX_ITEMS).map(squadTemplateSummary),
        }
      }

      case SQUAD_TOOL_NAMES.applyTemplate: {
        const templateId = stringArg(args, "templateId")
        if (!templateId) return invalidArguments("templateId is required")
        const template = deps.squads.templates()[templateId]
        if (!template) return notFound("squad template", templateId)
        const confirmed = await deps.consent("templates:instantiate", `instantiate:${template.id}`)
        if (!confirmed) return denied(`create a squad from template ${template.id}`)
        const result = await deps.applySquadTemplate({
          template,
          platform: deps.platform,
          actions: {
            createTeam: deps.squads.createTeam,
            addTeammate: deps.squads.addTeammate,
            createTask: deps.squads.createTask,
          },
          runtime: deps.runtime,
        })
        const team = deps.squads.teams()[result.teamId]
        return {
          ok: true as const,
          teamId: result.teamId,
          via: result.via,
          ...(team ? { name: team.name, status: team.status } : {}),
          templateId: template.id,
        }
      }

      case SQUAD_TOOL_NAMES.saveAsTemplate: {
        const teamId = stringArg(args, "teamId")
        const templateName = stringArg(args, "name")
        if (!teamId || !templateName) return invalidArguments("teamId and name are required")
        const category = stringArg(args, "category") as AgentTeamTemplate["category"] | null
        if (category && !SQUAD_TEMPLATE_CATEGORIES.includes(category)) {
          return invalidArguments(`category must be one of ${SQUAD_TEMPLATE_CATEGORIES.join(", ")}`)
        }
        if (!deps.squads.teams()[teamId]) return notFound("squad", teamId)
        // Consent BEFORE the store write, so a refusal leaves nothing behind.
        // Same order and same permission as `ctx.team.saveAsTemplate`.
        const confirmed = await deps.consent(
          "templates:library:write",
          `library-write:${templateName}`
        )
        if (!confirmed) return denied(`save squad ${teamId} as a template`)
        const template = deps.squads.saveAsTemplate(teamId, templateName, category ?? undefined)
        if (!template) return notFound("squad", teamId)
        // Same write-time mirror the plugin API performs. Non-fatal: the legacy
        // store is still the read side.
        let mirrored = true
        await deps.publishSquadTemplate(template).catch(() => {
          mirrored = false
        })
        return {
          ok: true as const,
          ...squadTemplateSummary(template),
          mirroredToCatalog: mirrored,
        }
      }

      default:
        return invalidArguments(`unknown squad tool ${name}`)
    }
  } catch (err) {
    return toolFailed(err)
  }
}

/** The Squad template tools as one half of the squads module's tool family. */
export const templateToolFamily: ModuleToolFamily = {
  surface: (ctx) => (templateToolsOffered(ctx) ? { tools: buildSquadToolEntries() } : null),
  run: async (name, args) => runSquadTool(name, args, await resolveSquadToolDeps()),
}
