/**
 * In-process tools that feature modules contribute (ADR-0250 §14 amendment).
 *
 * A module declares each tool's consent and effect in its manifest's
 * `tools.declare` and names a file exporting `toolFamily`. The generated
 * registry `lib/modules/generated/tools.ts` lists the declarations as data
 * and each family lazily, so the resolver and the dispatcher import no
 * module.
 *
 * - Resolution: {@link collectContributedTools} asks every active family's
 *   `surface` what this run is offered, concurrently and under one deadline,
 *   and returns the manifest entries, the consent tier derived from the
 *   declarations of exactly the offered tools, and their instructions. A
 *   tier can therefore never be offered apart from its tools.
 * - Failure: a family whose file does not load, whose `surface` throws or
 *   misses the deadline, or which offers a tool it did not declare (or
 *   another module's) is left out of the run and reported. Tools only add,
 *   so no failure refuses the turn.
 * - Dispatch: {@link findContributedTool} and {@link runContributedTool}
 *   route a call by name to the family that declared it.
 */

import { loggers } from "@cognia/logging"
import { MODULE_TOOLS } from "@/lib/modules/generated/tools"
import type {
  ModuleToolDeclaration,
  ModuleToolEntry,
  ModuleToolFamily,
  ModuleToolsEntry,
  ToolCallContext,
  ToolSurfaceContext,
  ToolSurfaceHost,
} from "@/lib/modules/manifest-types"
import { findDeclaredModuleTool, type DeclaredModuleTool } from "@/lib/modules/tool-declarations"
import { detectPlatform, isCliHost, isHeadlessHost } from "@/lib/platform/detect"
import type { PermissionVerdict, Ruleset } from "./permissions/ruleset"

/** How long all families together may take to say what a run is offered. */
export const TOOL_SURFACE_DEADLINE_MS = 2_000

/** The MCP server the sidecar mounts plugin tools on; rules carry both spellings. */
const PLUGIN_TOOLS_SERVER_NAME = "cognia-plugin-tools"

/** A contributed tool as `SendOptions.pluginTools` carries it. */
export interface ContributedPluginTool {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  /** `cognia-<module>-builtin`: the id the built-in families have always used. */
  pluginId: string
  /** Set for `consent: "per-call"`: every call asks a human. */
  requiresApproval?: true
  timeoutMs?: number
  pathParams?: string[]
  access?: "read" | "write"
}

/** A family left out of a run, and why. */
export interface SkippedToolFamily {
  module: string
  error: unknown
}

export interface ContributedTools {
  tools: ContributedPluginTool[]
  /** The lowest ruleset layer for exactly the offered tools; empty when none are. */
  ruleset: Ruleset
  /** Each offering family's instructions, in module id order. */
  instructions: string[]
  skipped: SkippedToolFamily[]
}

/** The host a run is being resolved on, as a family sees it. */
export function toolSurfaceHost(): ToolSurfaceHost {
  if (isCliHost()) return "cli"
  if (isHeadlessHost()) return "brain"
  const platform = detectPlatform()
  if (platform === "tauri") return "desktop"
  if (platform === "mobile") return "mobile"
  return "web"
}

/** The plugin id a module's tools travel under. */
export function contributedToolPluginId(module: string): string {
  return `cognia-${module}-builtin`
}

/**
 * The consent tier of a declaration: `"per-call"` asks, and more (see
 * `requiresApproval`); `"default"` has none, so no rule is written for it.
 */
export function verdictFor(declaration: ModuleToolDeclaration): PermissionVerdict | null {
  if (declaration.consent === "default") return null
  return declaration.consent === "allow" ? "allow" : "ask"
}

/** The ruleset layer for offered tools: both the bare and the MCP-prefixed spelling. */
export function rulesetForTools(
  tools: readonly { name: string; declaration: ModuleToolDeclaration }[]
): Ruleset {
  const rules: Ruleset = {}
  for (const { name, declaration } of tools) {
    const verdict = verdictFor(declaration)
    if (verdict === null) continue
    rules[name] = verdict
    rules[`mcp__${PLUGIN_TOOLS_SERVER_NAME}__${name}`] = verdict
  }
  return rules
}

const loaded = new Map<string, ModuleToolFamily>()
const loading = new Map<string, Promise<ModuleToolFamily>>()

function checkFamily(module: string, family: unknown): ModuleToolFamily {
  const candidate = family as Partial<ModuleToolFamily> | null | undefined
  if (!candidate || typeof candidate !== "object")
    throw new Error(`${module}: \`toolFamily\` is not an object`)
  if (typeof candidate.surface !== "function")
    throw new Error(`${module}: toolFamily.surface is not a function`)
  if (typeof candidate.run !== "function")
    throw new Error(`${module}: toolFamily.run is not a function`)
  return candidate as ModuleToolFamily
}

/** A module's family, loaded once; a failed load is retried by the next caller. */
function loadFamily(entry: ModuleToolsEntry): Promise<ModuleToolFamily> {
  const known = loaded.get(entry.module)
  if (known) return Promise.resolve(known)
  let pending = loading.get(entry.module)
  if (!pending) {
    pending = entry
      .load()
      .then(({ toolFamily }) => {
        const family = checkFamily(entry.module, toolFamily)
        loaded.set(entry.module, family)
        return family
      })
      .finally(() => loading.delete(entry.module))
    loading.set(entry.module, pending)
  }
  return pending
}

/** The manifest entry for one offered tool, or the reason the family is refused. */
function checkEntry(
  entry: ModuleToolsEntry,
  tool: ModuleToolEntry,
  seen: Set<string>
): ContributedPluginTool {
  if (!tool || typeof tool.name !== "string")
    throw new Error(`${entry.module}: an offered tool has no name`)
  const declaration = entry.declare[tool.name]
  if (!declaration)
    throw new Error(`${entry.module}: offers ${tool.name}, which its manifest does not declare`)
  if (seen.has(tool.name)) throw new Error(`${entry.module}: offers ${tool.name} twice`)
  if (typeof tool.description !== "string" || tool.description.trim() === "")
    throw new Error(`${entry.module}/${tool.name}: no description`)
  if (!tool.jsonSchema || typeof tool.jsonSchema !== "object" || Array.isArray(tool.jsonSchema))
    throw new Error(`${entry.module}/${tool.name}: jsonSchema is not an object`)
  seen.add(tool.name)
  return {
    name: tool.name,
    description: tool.description,
    jsonSchema: tool.jsonSchema,
    pluginId: contributedToolPluginId(entry.module),
    ...(declaration.consent === "per-call" ? { requiresApproval: true as const } : {}),
    ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    ...(tool.pathParams !== undefined ? { pathParams: [...tool.pathParams] } : {}),
    ...(tool.access !== undefined ? { access: tool.access } : {}),
  }
}

/**
 * What every active module offers this run, in module id order and then the
 * order each family offers its tools.
 */
export async function collectContributedTools(
  ctx: ToolSurfaceContext,
  entries: readonly ModuleToolsEntry[] = MODULE_TOOLS,
  deadlineMs: number = TOOL_SURFACE_DEADLINE_MS
): Promise<ContributedTools> {
  const active = entries.filter((entry) => entry.stage !== "experimental")
  const result: ContributedTools = { tools: [], ruleset: {}, instructions: [], skipped: [] }
  if (active.length === 0) return result

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs)
  })
  deadline.catch(() => undefined)
  try {
    const surfaces = await Promise.allSettled(
      active.map((entry) =>
        Promise.race([loadFamily(entry).then((family) => family.surface(ctx)), deadline])
      )
    )
    const offered: { name: string; declaration: ModuleToolDeclaration }[] = []
    const taken = new Set<string>()
    surfaces.forEach((outcome, index) => {
      const entry = active[index]
      try {
        if (outcome.status === "rejected") throw outcome.reason
        const surface = outcome.value
        if (!surface) return
        if (!Array.isArray(surface.tools))
          throw new Error(`${entry.module}: surface.tools is not a list`)
        if (surface.instructions !== undefined && typeof surface.instructions !== "string")
          throw new Error(`${entry.module}: surface.instructions is not text`)
        const seen = new Set<string>()
        const tools = surface.tools.map((tool) => checkEntry(entry, tool, seen))
        const clash = tools.find((tool) => taken.has(tool.name))
        if (clash)
          throw new Error(`${entry.module}: ${clash.name} is already offered by another module`)
        if (tools.length === 0) return
        for (const tool of tools) {
          taken.add(tool.name)
          offered.push({ name: tool.name, declaration: entry.declare[tool.name] })
        }
        result.tools.push(...tools)
        const instructions = surface.instructions?.trim()
        if (instructions) result.instructions.push(instructions)
      } catch (error) {
        loggers.agent.warn("tool family skipped", {
          module: entry.module,
          error: error instanceof Error ? error.message : String(error),
        })
        result.skipped.push({ module: entry.module, error })
      }
    })
    result.ruleset = rulesetForTools(offered)
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The declared tool a call names, when an active module declares it. Calls
 * arrive with bare names; an `experimental` module's tools are never routed.
 */
export function findContributedTool(
  name: string,
  entries: readonly ModuleToolsEntry[] = MODULE_TOOLS
): DeclaredModuleTool | undefined {
  const tool = findDeclaredModuleTool(name, entries)
  return tool && tool.entry.stage !== "experimental" && tool.name === name ? tool : undefined
}

/** Run one call through the family that declared its tool. */
export async function runContributedTool(
  tool: DeclaredModuleTool,
  args: Record<string, unknown>,
  call: ToolCallContext
): Promise<unknown> {
  const family = await loadFamily(tool.entry)
  return family.run(tool.name, args, call)
}

/** Test helper: forget every loaded family. */
export function __resetContributedToolsForTests(): void {
  loaded.clear()
  loading.clear()
}
