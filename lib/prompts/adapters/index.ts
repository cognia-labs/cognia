/**
 * Every Prompt Center resource, code-owned slots and owner resources alike,
 * behind one list (ADR-0236 §5.1). The catalog is the authority for code
 * slots; each adapter for its owner's resources.
 */

import { listPromptOverrideBindings } from "@/lib/db/prompt-overrides"
import { listPromptDefinitions, loadPromptCatalog, type PromptCatalogFailure } from "../catalog"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceContext,
  type PromptResourceSource,
  type PromptResourceSummary,
} from "../resources"
import { appSettingPromptAdapter } from "./app-settings"
import { characterPromptAdapter } from "./characters"
import { composerTemplatePromptAdapter } from "./composer-templates"
import { customModePromptAdapter } from "./custom-modes"
import { instructionFilePromptAdapter } from "./instruction-files"
import { presetPromptAdapter } from "./presets"
import { skillPromptAdapter } from "./skills"
import { subagentTemplatePromptAdapter } from "./subagent-templates"
import { teamTemplatePromptAdapter } from "./team-templates"
import { workspaceInstructionsPromptAdapter } from "./workspace-instructions"

export const OWNER_PROMPT_ADAPTERS: readonly OwnerPromptAdapter[] = [
  appSettingPromptAdapter,
  instructionFilePromptAdapter,
  workspaceInstructionsPromptAdapter,
  characterPromptAdapter,
  customModePromptAdapter,
  presetPromptAdapter,
  skillPromptAdapter,
  subagentTemplatePromptAdapter,
  teamTemplatePromptAdapter,
  composerTemplatePromptAdapter,
]

const BY_SOURCE = new Map<string, OwnerPromptAdapter>(
  OWNER_PROMPT_ADAPTERS.map((adapter) => [adapter.source, adapter])
)

/** The adapter that owns `key`, or `undefined` for code slots and unknown keys. */
export function ownerAdapterFor(key: string): OwnerPromptAdapter | undefined {
  return BY_SOURCE.get(parseResourceKey(key).source)
}

export interface CodePromptListingOptions {
  /** Loads the module-contributed prompts; the catalog's own loader by default. */
  loadCatalog?: () => Promise<{ failures: readonly PromptCatalogFailure[] }>
}

export interface CodePromptListing {
  resources: PromptResourceSummary[]
  /** Modules whose prompts did not load, so their slots are missing from `resources`. */
  failedModules: string[]
}

/**
 * Code-owned slots (shipped and those enabled plugins registered) with whether
 * any scope overrides them, then every slot that still holds overrides but has
 * no definition here, as unavailable. A module whose prompts did not load is
 * named rather than silently missing; the next listing retries it.
 */
export async function listCodePromptResources(
  options: CodePromptListingOptions = {}
): Promise<CodePromptListing> {
  const [bindings, catalog] = await Promise.all([
    listPromptOverrideBindings(),
    (options.loadCatalog ?? loadPromptCatalog)(),
  ])
  const overridden = new Set(
    bindings.filter((binding) => binding.activeRevisionId).map((binding) => binding.promptId)
  )
  const defs = listPromptDefinitions()
  const known = new Set(defs.map((def) => def.id))
  const available = defs.map((def): PromptResourceSummary => ({
    key: resourceKey("code", def.id),
    source: "code",
    kind: def.kind,
    operation: def.operation,
    promptId: def.id,
    group: def.group,
    builtIn: true,
    modified: overridden.has(def.id),
    edit: def.operation === "inspect-only" ? "owner-only" : "publish",
  }))
  const orphaned = [...new Set(bindings.map((binding) => binding.promptId))]
    .filter((promptId) => !known.has(promptId))
    .sort()
    .map((promptId): PromptResourceSummary => ({
      key: resourceKey("code", promptId),
      source: "code",
      kind: "feature-template",
      operation: "replace-template",
      promptId,
      builtIn: false,
      modified: overridden.has(promptId),
      edit: "owner-only",
      unavailable: true,
    }))
  return {
    resources: [...available, ...orphaned],
    failedModules: catalog.failures.map((failure) => failure.module),
  }
}

export interface PromptResourceListing {
  resources: PromptResourceSummary[]
  /** Sources whose owner could not be read, so the UI can say so instead of showing an empty list. */
  failed: PromptResourceSource[]
  /** Modules whose built-in prompts did not load; their slots are missing until a retry. */
  failedModules: string[]
}

/** The whole Prompt Center list. One failing owner never hides the others. */
export async function listPromptResources(
  ctx: PromptResourceContext,
  options: CodePromptListingOptions = {}
): Promise<PromptResourceListing> {
  const failed: PromptResourceSource[] = []
  let failedModules: string[] = []
  const settle = async (
    source: PromptResourceSource,
    load: () => Promise<PromptResourceSummary[]>
  ): Promise<PromptResourceSummary[]> => {
    try {
      return await load()
    } catch {
      failed.push(source)
      return []
    }
  }
  const groups = await Promise.all([
    settle("code", async () => {
      const listing = await listCodePromptResources(options)
      failedModules = listing.failedModules
      return listing.resources
    }),
    ...OWNER_PROMPT_ADAPTERS.map((adapter) => settle(adapter.source, () => adapter.list(ctx))),
  ])
  return { resources: groups.flat(), failed, failedModules }
}
