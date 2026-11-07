/**
 * Module tool declarations as data (ADR-0250 §14 amendment).
 *
 * A module declares each tool's consent and effect in its manifest's
 * `tools.declare`; the generated registry carries those declarations as
 * literals beside one lazy import per family. This file answers questions
 * about them without loading any module: which module owns a name, which
 * permission classes a tool belongs to, and the name lists other kernel
 * policy derives from them (the outbound tools, a probe's denials, live
 * voice's non-cancellable tools).
 *
 * The lists cover every declared tool whatever its module's stage: a list
 * that denies or reviews a tool an `experimental` module never offers costs
 * nothing, and leaving it out would make the list depend on a stage flip.
 * Dispatch is the one place that skips `experimental` modules
 * (`lib/claude/tool-contributions.ts`).
 */

import type { PermissionClass } from "@cognia/agent-config-types"
import { MODULE_TOOLS } from "@/lib/modules/generated/tools"
import type { ModuleToolDeclaration, ModuleToolsEntry } from "./manifest-types"

/** One declared tool, with the module and registry entry it belongs to. */
export interface DeclaredModuleTool {
  name: string
  module: string
  declaration: ModuleToolDeclaration
  entry: ModuleToolsEntry
}

/** Where the sidecar mounts plugin tools; a call can reach a gate under either spelling. */
const PLUGIN_TOOL_PREFIX = "mcp__cognia-plugin-tools__"

/** A tool name with the plugin-tool server prefix removed, if it has one. */
export function bareToolName(name: string): string {
  return name.startsWith(PLUGIN_TOOL_PREFIX) ? name.slice(PLUGIN_TOOL_PREFIX.length) : name
}

/** Every declared tool, in module id order and then declaration order. */
export function declaredModuleTools(
  entries: readonly ModuleToolsEntry[] = MODULE_TOOLS
): DeclaredModuleTool[] {
  return entries.flatMap((entry) =>
    Object.entries(entry.declare).map(([name, declaration]) => ({
      name,
      module: entry.module,
      declaration,
      entry,
    }))
  )
}

/** The declared tool a name (bare or prefixed) refers to, if a module declares it. */
export function findDeclaredModuleTool(
  name: string,
  entries: readonly ModuleToolsEntry[] = MODULE_TOOLS
): DeclaredModuleTool | undefined {
  const bare = bareToolName(name)
  for (const entry of entries) {
    const declaration = entry.declare[bare]
    if (declaration) return { name: bare, module: entry.module, declaration, entry }
  }
  return undefined
}

/** The bare names of the declared tools `predicate` accepts. */
export function moduleToolNamesWhere(
  predicate: (declaration: ModuleToolDeclaration) => boolean,
  entries: readonly ModuleToolsEntry[] = MODULE_TOOLS
): string[] {
  return declaredModuleTools(entries)
    .filter((tool) => predicate(tool.declaration))
    .map((tool) => tool.name)
}

/** The permission classes a declaration puts its tool in (ADR-0224 A7). */
export function permissionClassesOf(declaration: ModuleToolDeclaration): PermissionClass[] {
  const classes: PermissionClass[] = []
  if (declaration.effect === "outbound") classes.push("outbound")
  if (declaration.secrets === true) classes.push("secrets")
  return classes
}

/** The permission classes of a declared tool, or none for a name no module declares. */
export function moduleToolPermissionClasses(
  name: string,
  entries: readonly ModuleToolsEntry[] = MODULE_TOOLS
): PermissionClass[] {
  const tool = findDeclaredModuleTool(name, entries)
  return tool ? permissionClassesOf(tool.declaration) : []
}
