"use client"

// The room hand-off card (ADR-0252 §4), contributed through the squads UI
// manifest's `effects`: it registers with the tool-result renderer registry
// the chat's tool cards already consult, rather than the chat importing the
// squads module. The card is what the call is for, so its row opens.

import { useEffect } from "react"
import { registerToolResultRenderer } from "@/lib/plugin/api/tool-result-renderers"
import { ROOM_HANDOFF_TOOL_NAME } from "@/types/squads/room-handoff"
import { RoomHandoffCard } from "./room-handoff-card"

/** The registry owner the card is filed under. */
export const ROOM_HANDOFF_CARD_OWNER = "module:squads"

/** Registers the card while mounted, in every window. Renders nothing. */
export default function RoomHandoffCardEffect() {
  useEffect(
    () =>
      registerToolResultRenderer(ROOM_HANDOFF_CARD_OWNER, ROOM_HANDOFF_TOOL_NAME, RoomHandoffCard, {
        opensRow: true,
      }),
    []
  )
  return null
}
