/**
 * Project markdown subagents (`.cognia/agents/*.md` + the global agents dir)
 * as chat `@`-mention targets.
 *
 * These agents are ALREADY dispatched at send time — `build-options.ts` merges
 * `markdownAgentsToSdkMap(...)` into `opts.agents`. But they were never offered
 * as `@`-mention targets, and `resolveTargetAgentId` resolved only against
 * `buildChatMentionTargets()` (built-ins + plugins + templates), so a markdown
 * `@`-mention could never route. This module is the SHARED projection used by
 * BOTH the picker hook (`use-markdown-chat-agents.ts`) and the send-time
 * resolver (`use-agent-chat.ts:buildSendOptions`) so the two never drift.
 *
 * The markdown agent id is the kebab filename — the same key
 * `markdownAgentsToSdkMap` uses — so `handle === id` round-trips 1:1 with the
 * registered agent map. Discovery only depends on the workspace `roots`
 * (+ the global agents dir), never the cwd (see `discoverMarkdownAgentFiles`).
 */

import { buildMarkdownAgents, type MarkdownAgentFile } from "@/lib/agents/markdown-agents"
import type { SubagentMentionTarget } from "@/lib/chat/mentions/agent-targets"

/** "code-reviewer" → "Code Reviewer" (AgentDefinition carries no display name). */
function humanizeId(id: string): string {
  return (
    id
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || id
  )
}

/** Pure projection of parsed markdown agent files → picker mention targets. */
export function markdownAgentTargets(files: MarkdownAgentFile[]): SubagentMentionTarget[] {
  const { agents } = buildMarkdownAgents(files)
  return Object.entries(agents)
    .filter(([, def]) => !def.hidden && !def.disabled && !def.provider && !def.externalPresetId)
    .map(([id, def]) => ({
      id,
      name: humanizeId(id),
      description: def.description,
      model: def.model,
      // id is already kebab (no whitespace) and === the SDK agent-map key.
      handle: id,
    }))
}

/**
 * Send-time projection of markdown agent files, including `hidden`, `disabled`,
 * and runtime-pinned definitions so explicit `@handle` mentions either route
 * (`hidden`) or fail closed with a named `TargetAgentUnavailableError` instead
 * of silently falling back to ordinary chat.
 */
export function allMarkdownMentionCandidates(files: MarkdownAgentFile[]): SubagentMentionTarget[] {
  const { agents } = buildMarkdownAgents(files)
  return Object.entries(agents).map(([id, def]) => ({
    id,
    name: humanizeId(id),
    description: def.description,
    model: def.model,
    handle: id,
  }))
}

/**
 * Merge base subagent targets (built-in / plugin / template) with markdown
 * targets using the SAME precedence `build-options.ts` applies at execution
 * time: markdown agents win on `id` or `handle` collisions so picker display
 * metadata (label, description, model) matches the definition that runs.
 */
export function mergeChatMentionTargets(
  baseTargets: readonly SubagentMentionTarget[],
  markdownTargets: readonly SubagentMentionTarget[]
): SubagentMentionTarget[] {
  if (markdownTargets.length === 0) return [...baseTargets]
  const byMarkdownId = new Map(markdownTargets.map((t) => [t.id, t]))
  const byMarkdownHandle = new Map(markdownTargets.map((t) => [t.handle.toLowerCase(), t]))
  const consumedMarkdownIds = new Set<string>()
  const merged: SubagentMentionTarget[] = []

  for (const base of baseTargets) {
    const replacement = byMarkdownId.get(base.id) ?? byMarkdownHandle.get(base.handle.toLowerCase())
    if (replacement) {
      if (!consumedMarkdownIds.has(replacement.id)) {
        merged.push(replacement)
        consumedMarkdownIds.add(replacement.id)
      }
      continue
    }
    merged.push(base)
  }

  for (const md of markdownTargets) {
    if (!consumedMarkdownIds.has(md.id)) {
      merged.push(md)
      consumedMarkdownIds.add(md.id)
    }
  }
  return merged
}

/**
 * Discover + project markdown agents for a session. Returns `[]` off-Tauri or
 * when no workspace roots / global agents exist. Cheap on repeat calls —
 * `loadProjectInstructions` memoises by `{cwd, roots, config}` for 3s.
 */
export async function discoverMarkdownAgentTargets(input: {
  cwd?: string
  roots: string[]
  includeNonPicker?: boolean
}): Promise<SubagentMentionTarget[]> {
  try {
    const { loadProjectInstructions } = await import("@/lib/agents/instructions/load")
    const { markdownAgentFiles } = await loadProjectInstructions({
      cwd: input.cwd,
      roots: input.roots,
    })
    return input.includeNonPicker
      ? allMarkdownMentionCandidates(markdownAgentFiles)
      : markdownAgentTargets(markdownAgentFiles)
  } catch {
    // Discovery is best-effort: a failure must never block a send or the picker.
    return []
  }
}
