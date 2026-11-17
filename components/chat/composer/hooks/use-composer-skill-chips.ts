"use client"

import type { ComposerInnerProps } from "../../composer"
import { useChatStore, useComposerEphemeralSkillIds } from "@/stores/chat"
import { useCallback } from "react"

export interface ComposerSkillChipsInput {
  props: Pick<ComposerInnerProps, "session">
}

/**
 * The skill chips above the box: the skills attached to this conversation for
 * the next turn, and removing one. Keyed by THIS pane's conversation, so × in
 * split view detaches the skill from the chat it is drawn in.
 */
export function useComposerSkillChips(input: ComposerSkillChipsInput) {
  const { props } = input

  const ephemeralSkillIds = useComposerEphemeralSkillIds(props.session?.id ?? null)
  const toggleEphemeralSkill = useChatStore((s) => s.toggleEphemeralSkill)
  // Keyed by THIS pane's conversation, matching where `ephemeralSkillIds` are read
  // from — the bare action defaults to the focused pane, so × detached a skill
  // from the conversation beside it and left this chip standing.
  const composerSessionIdForSkills = props.session?.id ?? null
  const removeEphemeralSkill = useCallback(
    (skillId: string) => toggleEphemeralSkill(skillId, composerSessionIdForSkills),
    [toggleEphemeralSkill, composerSessionIdForSkills]
  )
  return { ephemeralSkillIds, removeEphemeralSkill }
}
