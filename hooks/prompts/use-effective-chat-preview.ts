"use client"

/**
 * Inputs of the effective chat preview (ADR-0236 §4, R5), read from the same
 * owners a turn reads: the agent row (through `resolveCharacterById`, so a
 * variant's overlay applies), the default system prompt, the instruction
 * loader, the workspace record, the mode's resolved prompt and the agent's
 * enabled Skills. The preview is for a new chat with the chosen agent, mode
 * and workspace; a session's own prompt is not part of it.
 *
 * Its static parts are computed the way the send path computes them: the
 * working directory through `resolveEffectiveCwd` (workspace root, then the
 * agent's directory, then the app default), and the mode section through the
 * same template substitution. A preview reads prompts without using them
 * (`record: false`). While a new selection loads, the previous selection's
 * preview is not reported as ready for the new one.
 */

import { useCallback, useEffect, useState } from "react"
import {
  BUILT_IN_AGENT_MODES,
  BUILT_IN_MODE_PROMPTS,
  MODE_PROMPT_PASSTHROUGH_VALUES,
} from "@/lib/agent/modes/built-ins"
import { resolveCharacterById } from "@/lib/db/characters"
import { listEnabledSkillsByIds } from "@/lib/db/skills"
import { renderHarnessSections } from "@/lib/harness/render"
import {
  composeEffectivePreview,
  type EffectivePreview,
  type EffectivePreviewInput,
} from "@/lib/prompts/effective-preview"
import { resolveActiveAgentMode } from "@/lib/agent/resolve-agent-mode"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { isTauri } from "@/lib/tauri"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { allRootPaths } from "@/lib/workspace/roots"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { processPromptTemplateVariables } from "@/stores/agent/custom-mode-store/helpers"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

export interface EffectiveChatPreviewSelection {
  agentId: string | null
  modeId: string | null
  workspaceId: string | null
}

export type EffectiveChatPreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: EffectivePreview }
  | { status: "error"; error: string }

export function useEffectiveChatPreview(selection: EffectiveChatPreviewSelection): {
  state: EffectiveChatPreviewState
  reload: () => void
} {
  const { agentId, modeId, workspaceId } = selection
  const selectionKey = JSON.stringify([agentId, modeId, workspaceId])
  const [epoch, setEpoch] = useState(0)
  // Each result remembers the selection it was composed for.
  const [result, setResult] = useState<{
    key: string
    state: Exclude<EffectiveChatPreviewState, { status: "loading" }>
  } | null>(null)
  const reload = useCallback(() => setEpoch((value) => value + 1), [])
  const settings = useSettingsStore((store) => store.settings)
  // Subscribed so an edited mode recomposes; the lookup itself goes through
  // `resolveActiveAgentMode`. Plugin records likewise, so a contributed mode
  // that arrives or leaves recomposes.
  const customModes = useCustomModeStore((store) => store.customModes)
  const plugins = usePluginStore((store) => store.plugins)
  const project = useProjectStore((store) =>
    workspaceId ? store.projects.find((candidate) => candidate.id === workspaceId) : undefined
  )

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<EffectivePreview> => {
      const character = agentId ? await resolveCharacterById(agentId) : undefined
      const roots = project ? allRootPaths(project) : []
      // A new chat has no session override or execution binding yet.
      const cwd = resolveEffectiveCwd({
        activeProject: project ?? null,
        characterWorkingDir: character?.workingDir,
        defaultWorkingDir: settings?.defaultWorkingDir,
      })

      let instructions: EffectivePreviewInput["instructions"]
      if (character?.bareMode ?? settings?.bareMode) {
        instructions = { omitted: "bare-mode" }
      } else if (!isTauri()) {
        instructions = { omitted: "no-filesystem" }
      } else {
        try {
          const { loadProjectInstructions } = await import("@/lib/agents/instructions/load")
          const resolved = await loadProjectInstructions({
            cwd,
            roots,
            config: character?.instructionsOverride ?? settings?.instructions,
          })
          instructions = { section: resolved.section }
        } catch {
          instructions = { omitted: "load-failed" }
        }
      }

      let mode: EffectivePreviewInput["mode"] = null
      const builtIn = modeId ? BUILT_IN_AGENT_MODES.find((entry) => entry.id === modeId) : undefined
      // The send path's own lookup: the user's modes, then enabled plugins'.
      const other = builtIn ? undefined : resolveActiveAgentMode(modeId)
      // The send path's substitution of `{{mode_name}}`, `{{tools_list}}`, …
      // over the mode's text, with the mode's own name, description and tools.
      const renderMode = (
        raw: string,
        source: { name: string; description?: string; tools?: readonly string[] }
      ) =>
        processPromptTemplateVariables(raw.trim(), {
          modeName: source.name,
          modeDescription: source.description,
          tools: source.tools ? [...source.tools] : undefined,
        })
      if (builtIn) {
        const def = BUILT_IN_MODE_PROMPTS.get(builtIn.id)
        const raw = def
          ? (
              await resolvePromptAsync(def, {
                context: workspaceId ? { workspaceId } : {},
                values: MODE_PROMPT_PASSTHROUGH_VALUES,
                record: false,
              })
            ).text
          : (builtIn.systemPrompt ?? "")
        mode = { name: builtIn.name, text: renderMode(raw, builtIn) }
      } else if (other) {
        mode = { name: other.name, text: renderMode(other.systemPrompt ?? "", other) }
      }

      const skillIds = character?.skillIds ?? []
      const skills =
        skillIds.length > 0
          ? (await listEnabledSkillsByIds(skillIds, { projectId: workspaceId })).map(
              (skill) => skill.name
            )
          : []

      return composeEffectivePreview({
        base: {
          characterPrompt: character?.systemPrompt,
          appDefault: settings?.defaultSystemPrompt,
        },
        ...(character ? { agentName: character.name } : {}),
        ...(character?.persona ? { persona: character.persona } : {}),
        harnessText: renderHarnessSections(character?.harness),
        instructions,
        workspace: project
          ? { name: project.name, customInstructions: project.customInstructions }
          : null,
        mode,
        skills,
      })
    }
    load()
      .then((preview) => {
        if (!cancelled) setResult({ key: selectionKey, state: { status: "ready", preview } })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({
            key: selectionKey,
            state: {
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentId, modeId, workspaceId, selectionKey, project, settings, customModes, plugins, epoch])

  const state: EffectiveChatPreviewState =
    result && result.key === selectionKey ? result.state : LOADING
  return { state, reload }
}

const LOADING: EffectiveChatPreviewState = { status: "loading" }
