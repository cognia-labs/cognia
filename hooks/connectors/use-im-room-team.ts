"use client"

/**
 * The character team an IM room answers with, if its conversation names one
 * (ADR-0177 batch 4, `ConversationOverrideRow.characterTeamId`).
 *
 * The room settings use it to name the members a room can mute; a plain
 * group, a one-to-one chat and any room that is not an IM group get `null`.
 * The members are read through `listCharactersByIds`, which applies variant
 * overlays, the same read the connector runtime runs the room with.
 */

import type { Character, ChatSession, Team } from "@cognia/agent-config-types"
import { useLiveQuery } from "dexie-react-hooks"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { roomKindOf } from "@/lib/chat/room/kind"
import { listCharactersByIds } from "@/lib/db/characters"
import { getTeam } from "@/lib/db/teams"

export interface ImRoomTeam {
  team: Team
  /** The team's characters in the team's order; a deleted one is left out. */
  members: Character[]
}

type ImRoomSession = Pick<ChatSession, "platformBinding" | "kind" | "teamId" | "collaboration">

export function useImRoomTeam(session: ImRoomSession | null | undefined): ImRoomTeam | null {
  const binding = roomKindOf(session) === "im" ? session?.platformBinding : undefined
  const override = useConversationOverride(binding?.conversationKey)
  const teamId = binding ? override?.characterTeamId?.trim() || undefined : undefined
  // Loading reads as "no team" until the rows arrive, so no mute list flashes.
  return (
    useLiveQuery<ImRoomTeam | null>(
      async () => {
        if (typeof window === "undefined" || !teamId) return null
        const team = await getTeam(teamId)
        if (!team) return null
        const characters = await listCharactersByIds(team.members.map((slot) => slot.characterId))
        const members = team.members.flatMap((slot) => {
          const character = characters.find((candidate) => candidate.id === slot.characterId)
          return character ? [character] : []
        })
        return { team, members }
      },
      [teamId],
      null
    ) ?? null
  )
}
