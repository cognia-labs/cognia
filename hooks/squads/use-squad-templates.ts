"use client"

/**
 * The Squad templates a person can start from, and the one way to use one.
 *
 * Two surfaces offer templates: the Settings library, which also edits,
 * publishes and imports them, and the `/squads` "New Squad" dialog, which only
 * picks one. Both must list the same templates in the same order and create
 * the Squad the same way, through the template platform, so the Squad records
 * which template it came from. A second copy of either half is how a Squad made
 * from the dialog ends up with no lineage while one made from Settings has it.
 */

import { useCallback, useMemo } from "react"

import { applySquadTemplate } from "@/lib/agent-team/apply-squad-template"
import {
  projectPluginTemplate,
  type PluginTemplateOverlayEntry,
} from "@/lib/agent-team/project-plugin-template"
import {
  getTemplateWarnings,
  listAgentTeamTemplateEntries,
  type PluginAgentTeamTemplateWarning,
} from "@/lib/plugin/registries/agent-team-template-registry"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import type { TemplatePlatform } from "@/lib/templates/contracts"
import { usePlatform } from "@/hooks/use-platform"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

/** Where a plugin-contributed template came from, keyed by its projected id. */
export interface PluginTemplateSource {
  pluginId?: string
  warnings: readonly PluginAgentTeamTemplateWarning[]
}

export interface SquadTemplateList {
  /** Built-ins first (grouped by category), then the user's by name, then plugins'. */
  merged: AgentTeamTemplate[]
  /** Only plugin rows have an entry; a missing entry means "not a plugin row". */
  pluginIndex: Map<string, PluginTemplateSource>
}

/**
 * Pure ordering, exported for tests. Plugin entries are projected into the
 * store's template shape under `<pluginId>:<defId>`, so they never collide with
 * a store-resident id.
 */
export function sortSquadTemplates(
  local: readonly AgentTeamTemplate[],
  pluginEntries: readonly PluginTemplateOverlayEntry[],
  warningsFor: (entryId: string) => readonly PluginAgentTeamTemplateWarning[] = () => []
): SquadTemplateList {
  const pluginIndex = new Map<string, PluginTemplateSource>()
  const pluginProjected = pluginEntries.map((entry) => {
    const projected = projectPluginTemplate(entry)
    pluginIndex.set(projected.id, {
      ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
      warnings: warningsFor(entry.id),
    })
    return projected
  })
  const merged = [...local, ...pluginProjected]
  merged.sort((a, b) => {
    const aPlugin = pluginIndex.has(a.id)
    const bPlugin = pluginIndex.has(b.id)
    if (aPlugin !== bPlugin) return aPlugin ? 1 : -1
    const aBuiltIn = a.isBuiltIn ?? false
    const bBuiltIn = b.isBuiltIn ?? false
    if (aBuiltIn !== bBuiltIn) return aBuiltIn ? -1 : 1
    if (aBuiltIn && bBuiltIn && a.category !== b.category) {
      return a.category.localeCompare(b.category)
    }
    return a.name.localeCompare(b.name)
  })
  return { merged, pluginIndex }
}

/** Every template on offer, in the order both surfaces list them. */
export function useSquadTemplates(): SquadTemplateList {
  const templates = useAgentTeamStore((s) => s.templates)
  return useMemo(
    () =>
      sortSquadTemplates(
        Object.values(templates),
        listAgentTeamTemplateEntries(),
        getTemplateWarnings
      ),
    [templates]
  )
}

export interface AppliedSquadTemplate {
  teamId: string
  via: string
}

/**
 * Creates a Squad from a template through the platform.
 *
 * `applySquadTemplate` falls back to the direct store writer only when the
 * feature flag is off or the definition genuinely is not in the catalog, and
 * the store actions are handed over for exactly that case. Navigation is the
 * caller's: Settings routes to the new Squad, the dialog selects it in place.
 */
export function useApplySquadTemplate(
  runtime?: TemplateRuntime
): (template: AgentTeamTemplate, pluginSource?: string) => Promise<AppliedSquadTemplate> {
  const platform = usePlatform()
  const templatePlatform: TemplatePlatform =
    platform === "mobile" ? "mobile" : platform === "web" ? "web" : "desktop"
  const resolvedRuntime = useMemo(() => runtime ?? getTemplateRuntime(), [runtime])
  const createTeam = useAgentTeamStore((s) => s.createTeam)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)
  const createTask = useAgentTeamStore((s) => s.createTask)

  return useCallback(
    async (template, pluginSource) => {
      const result = await applySquadTemplate({
        template,
        ...(pluginSource ? { origin: { pluginSource } } : {}),
        platform: templatePlatform,
        actions: { createTeam, addTeammate, createTask },
        runtime: resolvedRuntime,
      })
      return { teamId: result.teamId, via: result.via }
    },
    [addTeammate, createTask, createTeam, resolvedRuntime, templatePlatform]
  )
}
