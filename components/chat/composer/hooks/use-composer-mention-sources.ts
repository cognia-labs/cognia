"use client"

import { type ComposerWorkflowMention, type MentionMode } from "../../composer-trigger"
import { useApplyPreset } from "@/hooks/chat/use-apply-preset"
import { useMarkdownChatAgents } from "@/hooks/chat/use-markdown-chat-agents"
import { useMentionablePresets } from "@/hooks/chat/use-mentionable-presets"
import { useMentionableSkills } from "@/hooks/chat/use-mentionable-skills"
import { useMentionableSubagents } from "@/hooks/chat/use-mentionable-subagents"
import { useRouteTargets } from "@/hooks/chat/use-route-targets"
import { useTeamMemberRoles, useTeamMembers } from "@/hooks/use-team-members"
import { isRoutableSession } from "@/lib/chat/turn-route/types"
import { type ChatSession } from "@cognia/agent-config-types"
import { useMemo } from "react"

export interface ComposerMentionSourcesInput {
  cwd: string | null
  defaultProvider: string | undefined
  props: {
    routing?: boolean
    session?: ChatSession | null
    workflowMention?: ComposerWorkflowMention
  }
}

/**
 * The composer's `@` sources: mention mode, room members, agents, turn
 * routes, entity scope, skills and presets.
 */
export function useComposerMentionSources(input: ComposerMentionSourcesInput) {
  const { cwd, defaultProvider, props } = input

  // `@` mode resolution: a direct chat AND a team room get the combined panel,
  // so every general-chat composer gets `@agent` and every team room gets
  // `@member` without each call site opting in. The workflow copilot makes `@`
  // mean a node. Other composers keep the file picker.
  //
  // A team room used to fall through to `"files"`, which meant desktop had no
  // `@` completion for the people in the room at all: `parseMentions` still
  // routed a typed `@Name` at send time, but you had to remember and spell the
  // character name, and the only affordance was the `@` button on each row of
  // the members panel.
  const isTeamRoom = props.session?.kind === "team" && Boolean(props.session.teamId)
  const resolvedMentionMode: MentionMode = props.workflowMention
    ? "workflow"
    : props.session?.kind === "direct" || isTeamRoom
      ? "combined"
      : "files"
  const isCombinedMention = resolvedMentionMode === "combined"
  // The people in this room. Empty (and free) outside a team session.
  const teamMembers = useTeamMembers(isTeamRoom ? props.session?.teamId : null)
  const teamMemberRoleById = useTeamMemberRoles(isTeamRoom ? props.session?.teamId : null)
  // Reactive subagent list for the combined panel (no-op cost otherwise). The
  // built-in/plugin/template subagents union with on-disk markdown agents
  // (`.cognia/agents/*.md`) so both surface in the `@` "Agents" section.
  const mentionableSubagents = useMentionableSubagents()
  const markdownAgents = useMarkdownChatAgents(cwd, isCombinedMention)
  const chatAgents = useMemo(() => {
    if (!isCombinedMention) return undefined
    if (markdownAgents.length === 0) return mentionableSubagents
    // Dedupe by id; the reactive (built-in/plugin/template) list wins so a
    // markdown file can't shadow a registered subagent's display metadata.
    const seen = new Set(mentionableSubagents.map((t) => t.id))
    return [...mentionableSubagents, ...markdownAgents.filter((t) => !seen.has(t.id))]
  }, [isCombinedMention, mentionableSubagents, markdownAgents])
  // `@claude` / `@codex` / Squad members as the LEADING token route the turn
  // (`lib/chat/turn-route/`). Only in a conversation that has a lane of its
  // own to leave — a direct chat, or the new-chat composer — and never in the
  // workflow copilot, where `@` means a node.
  const routeEnabled =
    props.routing !== false && !props.workflowMention && isRoutableSession(props.session)
  // The provider the builtin lane would use, so `@claude` names the engine
  // that will really answer. Same resolution as the toolbar's runtime chip.
  const routeProviderId = props.session?.providerOverride ?? defaultProvider ?? "anthropic"
  // A member never shadows a subagent handle the same panel offers.
  const routeReservedHandles = useMemo(
    () => (chatAgents ?? mentionableSubagents).map((agent) => agent.handle),
    [chatAgents, mentionableSubagents]
  )
  const routes = useRouteTargets({
    enabled: routeEnabled,
    session: props.session,
    providerId: routeProviderId,
    reservedHandles: routeReservedHandles,
  })
  // `@skill:` / `@preset:` namespaced mention sources (general chat only).
  // Scope for the `@memory:` / `@issue:` / … sources. The SESSION's workspace,
  // not the focused one: a background pane composing into another workspace's
  // conversation must offer that workspace's records, matching how the send
  // path resolves everything else about the turn.
  const entityContext = useMemo(
    () => ({ projectId: props.session?.projectId ?? null, sessionId: props.session?.id ?? null }),
    [props.session?.projectId, props.session?.id]
  )
  const chatSkills = useMentionableSkills(isCombinedMention)
  const chatPresets = useMentionablePresets(isCombinedMention)
  const applyPreset = useApplyPreset()
  return {
    routes,
    chatAgents,
    teamMembers,
    resolvedMentionMode,
    applyPreset,
    isCombinedMention,
    teamMemberRoleById,
    chatSkills,
    chatPresets,
    entityContext,
  }
}
