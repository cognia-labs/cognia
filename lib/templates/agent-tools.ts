/**
 * The templates module's tool family (ADR-0250 §14 amendment): the agent-facing
 * tools over the unified template catalog and the user's saved chat templates
 * (ADR-0164). The Squad template tools are the squads module's
 * (`lib/squads/agent-tools.ts`); consent, caps and failures are shared through
 * `./agent-tool-kit.ts`.
 *
 * Every store these tools read or write lives on the host: the template
 * catalog and service (`./runtime.ts`) and the Dexie chat-template table
 * (`lib/db/chat-templates.ts`). The sidecar cannot import `lib/`, so the
 * tools ride the plugin-tool relay and run here.
 */

import type { ModuleToolEntry, ModuleToolFamily } from "@/lib/modules/manifest-types"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type { TemplateRuntime } from "./runtime"
import type { TemplateDefinitionEnvelope, TemplateDomain, TemplatePlatform } from "./contracts"
import { TEMPLATE_CATALOG_ONLY_DOMAINS, TEMPLATE_FULL_DOMAINS } from "./contracts"
import type { TemplatePreflightPlan } from "./service"
import {
  LIST_MAX_ITEMS,
  READ_CONTENT_MAX_CHARS,
  currentTemplatePlatform,
  denied,
  invalidArguments,
  notFound,
  requestTemplateToolConsent,
  stringArg,
  templateToolsOffered,
  toolFailed,
  type TemplateToolConsentPermission,
  type TemplateToolFailure,
} from "./agent-tool-kit"

export const TEMPLATE_TOOL_NAMES = {
  list: "template_list",
  get: "template_get",
  instantiate: "template_instantiate",
  chatList: "chat_template_list",
  chatGet: "chat_template_get",
} as const

const TEMPLATE_DOMAINS: readonly TemplateDomain[] = [
  ...TEMPLATE_FULL_DOMAINS,
  ...TEMPLATE_CATALOG_ONLY_DOMAINS,
]

export function buildTemplateToolEntries(): ModuleToolEntry[] {
  return [
    {
      name: TEMPLATE_TOOL_NAMES.list,
      description:
        "List templates in the user's unified template catalog: squads, workflows, subagents, custom modes, characters, skills and the catalog-only domains. Filter by `domain` or a free-text `query`. Returns ids, names, domains and versions, capped at 50 rows.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string", enum: [...TEMPLATE_DOMAINS] },
          query: { type: "string", maxLength: 200 },
        },
      },
    },
    {
      name: TEMPLATE_TOOL_NAMES.get,
      description:
        "Read one template definition by id (optionally a specific `version`): metadata, declared inputs, dependencies, capabilities, compatible platforms, and a truncated view of its payload.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
        },
      },
    },
    {
      name: TEMPLATE_TOOL_NAMES.instantiate,
      description:
        "Preflight and instantiate a template from the catalog on this device, creating the resource it describes (a squad, workflow, subagent, mode, character or skill). Pass `bindings` for any declared input slots. The user is asked to confirm before anything is created, and a blocked preflight is returned with its reasons instead of creating anything.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          bindings: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Input slot id to resource id, for the template's declared inputs.",
          },
        },
      },
    },
    {
      name: TEMPLATE_TOOL_NAMES.chatList,
      description:
        "List the user's saved chat templates (reusable message bodies with `{{parameter}}` tokens), most recently used first. Optional free-text `query` matches name and description.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string", maxLength: 200 } },
      },
    },
    {
      name: TEMPLATE_TOOL_NAMES.chatGet,
      description:
        "Read one saved chat template by id: its body, declared parameters, launch configuration and the values used last time.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", minLength: 1 } },
      },
    },
  ]
}

export interface TemplateToolDeps {
  runtime: TemplateRuntime
  /** Which platform the preflight is evaluated for. */
  platform: TemplatePlatform
  /** Ask the user. Resolves `true` when the write may proceed. */
  consent: (permission: TemplateToolConsentPermission, reason: string) => Promise<boolean>
  chatTemplates: {
    list: () => Promise<ChatTemplateRow[]>
    get: (id: string) => Promise<ChatTemplateRow | undefined>
  }
}

type TemplateToolDepsResolver = () => Promise<TemplateToolDeps> | TemplateToolDeps

let depsOverride: TemplateToolDepsResolver | null = null

/** Inject template-tool deps (tests / CLI host). Pass `null` to restore the default. */
export function __setTemplateToolDepsForTesting(fn: TemplateToolDepsResolver | null): void {
  depsOverride = fn
}

/** Resolve the host-side singletons the runner reads and writes through. */
async function resolveTemplateToolDeps(): Promise<TemplateToolDeps> {
  if (depsOverride) return depsOverride()
  const [{ getTemplateRuntime }, chatTemplates, platform] = await Promise.all([
    import("./runtime"),
    import("@/lib/db/chat-templates"),
    currentTemplatePlatform(),
  ])
  return {
    runtime: getTemplateRuntime(),
    platform,
    consent: requestTemplateToolConsent,
    chatTemplates: {
      list: () => chatTemplates.listChatTemplates(),
      get: (id) => chatTemplates.getChatTemplate(id),
    },
  }
}

function truncate(content: string): {
  content: string
  truncated: boolean
  length: number
} {
  if (content.length <= READ_CONTENT_MAX_CHARS) {
    return { content, truncated: false, length: content.length }
  }
  return {
    content: content.slice(0, READ_CONTENT_MAX_CHARS),
    truncated: true,
    length: content.length,
  }
}

function definitionSummary(definition: TemplateDefinitionEnvelope) {
  return {
    id: definition.id,
    name: definition.metadata.name,
    domain: definition.domain,
    status: definition.status,
    version: definition.version,
    ...(definition.metadata.description ? { description: definition.metadata.description } : {}),
    ...(definition.metadata.category ? { category: definition.metadata.category } : {}),
    source: definition.provenance.source,
    platforms: definition.compatibility.platforms,
  }
}

function chatTemplateSummary(row: ChatTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    parameters: row.params.map((param) => ({
      id: param.id,
      label: param.label,
      required: param.required,
      kind: param.kind,
    })),
    usageCount: row.usageCount,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
  }
}

function blocked(plan: TemplatePreflightPlan): TemplateToolFailure {
  return {
    ok: false,
    code: "preflight_blocked",
    error: plan.issues.map((issue) => issue.message).join(", ") || "template preflight was blocked",
    issues: plan.issues.map((issue) => ({ code: issue.code, message: issue.message })),
  }
}

function bindingsFrom(args: Record<string, unknown>): Record<string, string> | TemplateToolFailure {
  const raw = args.bindings
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidArguments("bindings must be an object of slot id to resource id")
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return invalidArguments(`binding ${key} must be a string`)
    }
    out[key] = value
  }
  return out
}

function isFailure(value: unknown): value is TemplateToolFailure {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false
}

/** Execute one template or chat-template tool call. Never throws. */
export async function runTemplateTool(
  name: string,
  args: Record<string, unknown>,
  deps: TemplateToolDeps
): Promise<unknown> {
  try {
    switch (name) {
      case TEMPLATE_TOOL_NAMES.list: {
        const domain = stringArg(args, "domain") as TemplateDomain | null
        if (domain && !TEMPLATE_DOMAINS.includes(domain)) {
          return invalidArguments(`domain must be one of ${TEMPLATE_DOMAINS.join(", ")}`)
        }
        const query = stringArg(args, "query") ?? undefined
        const rows = deps.runtime.catalog.query({
          ...(domain ? { domain } : {}),
          ...(query ? { text: query } : {}),
        })
        return {
          ok: true as const,
          templates: rows.slice(0, LIST_MAX_ITEMS).map(definitionSummary),
          total: rows.length,
          truncated: rows.length > LIST_MAX_ITEMS,
        }
      }

      case TEMPLATE_TOOL_NAMES.get: {
        const id = stringArg(args, "id")
        if (!id) return invalidArguments("id is required")
        const version = stringArg(args, "version")
        const definition = deps.runtime.catalog.get(id, version ?? undefined)
        if (!definition) return notFound("template", version ? `${id}@${version}` : id)
        const payload = truncate(JSON.stringify(definition.payload, null, 2))
        return {
          ok: true as const,
          ...definitionSummary(definition),
          revision: definition.revision,
          inputs: definition.inputs,
          dependencies: definition.dependencies,
          capabilities: definition.capabilities,
          compatibility: definition.compatibility,
          ...(definition.metadata.tags?.length ? { tags: definition.metadata.tags } : {}),
          payload: payload.content,
          payloadLength: payload.length,
          truncated: payload.truncated,
        }
      }

      case TEMPLATE_TOOL_NAMES.instantiate: {
        const id = stringArg(args, "id")
        if (!id) return invalidArguments("id is required")
        const version = stringArg(args, "version")
        const bindings = bindingsFrom(args)
        if (isFailure(bindings)) return bindings
        const definition = deps.runtime.catalog.get(id, version ?? undefined)
        if (!definition) return notFound("template", version ? `${id}@${version}` : id)
        if (!(TEMPLATE_FULL_DOMAINS as readonly string[]).includes(definition.domain)) {
          return {
            ok: false as const,
            code: "catalog_only",
            error: `templates in the ${definition.domain} domain can be read but not instantiated`,
          }
        }
        // Preflight first so a blocked plan never costs the user a prompt.
        const plan = await deps.runtime.service.preflight({
          definitionId: definition.id,
          ...(definition.version ? { version: definition.version } : {}),
          platform: deps.platform,
          bindings,
        })
        if (plan.status === "blocked") return blocked(plan)
        // The consent prompt IS the explicit confirmation the service demands
        // for a `needs-confirmation` plan, so `confirmed` is the user's answer,
        // never a constant.
        const confirmed = await deps.consent(
          "templates:instantiate",
          `instantiate:${definition.id}`
        )
        if (!confirmed) return denied(`instantiate template ${definition.id}`)
        const result = await deps.runtime.service.instantiate({ plan, confirmed })
        return {
          ok: true as const,
          ...definitionSummary(definition),
          resources: result.resources,
          warnings: plan.issues.filter((issue) => issue.severity === "warning"),
        }
      }

      case TEMPLATE_TOOL_NAMES.chatList: {
        const query = stringArg(args, "query")?.toLocaleLowerCase()
        const rows = (await deps.chatTemplates.list()).filter((row) => {
          if (!query) return true
          return `${row.name} ${row.description ?? ""}`.toLocaleLowerCase().includes(query)
        })
        return {
          ok: true as const,
          templates: rows.slice(0, LIST_MAX_ITEMS).map(chatTemplateSummary),
          total: rows.length,
          truncated: rows.length > LIST_MAX_ITEMS,
        }
      }

      case TEMPLATE_TOOL_NAMES.chatGet: {
        const id = stringArg(args, "id")
        if (!id) return invalidArguments("id is required")
        const row = await deps.chatTemplates.get(id)
        if (!row) return notFound("chat template", id)
        const body = truncate(row.body)
        return {
          ok: true as const,
          ...chatTemplateSummary(row),
          body: body.content,
          bodyLength: body.length,
          truncated: body.truncated,
          revision: row.revision,
          parameters: row.params,
          ...(row.launchSpec ? { launchSpec: row.launchSpec } : {}),
          ...(row.lastParams ? { lastParams: row.lastParams } : {}),
        }
      }

      default:
        return invalidArguments(`unknown template tool ${name}`)
    }
  } catch (err) {
    return toolFailed(err)
  }
}

export const toolFamily: ModuleToolFamily = {
  surface: (ctx) => (templateToolsOffered(ctx) ? { tools: buildTemplateToolEntries() } : null),
  run: async (name, args) => runTemplateTool(name, args, await resolveTemplateToolDeps()),
}
