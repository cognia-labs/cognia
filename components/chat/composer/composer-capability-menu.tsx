"use client"
import type { ChatStatus as PromptStatus } from "ai"

import type { SettingsTab } from "@/lib/slash-commands/builtin"
import type { ChatSession } from "@cognia/agent-config-types"

import { RoomTargetPicker } from "./room-target-picker"
import { SkillsMenuEntry } from "./skills-menu-entry"
import { WebSearchToggle } from "./web-search-toggle"

/** The capability rows the `+` menus carry: web search, room target, skills. */
export function ComposerCapabilityMenu({
  session,
  status,
  disabled,
  onOpenSettings,
}: {
  session?: ChatSession | null
  status: PromptStatus
  disabled?: boolean
  onOpenSettings: (tab: SettingsTab) => void
}) {
  const isStreaming = status === "streaming"
  const controlsDisabled = disabled || isStreaming

  return (
    <>
      {/* The prompt-enhance wand used to live here. It rewrites what is in the
          box, so it belongs ON the box: it now sits beside the save-as-template
          bookmark in the input's corner, in the same icon-button style, where
          it is visible without opening a menu first. */}
      {/* Each capability is a CapabilityRow — a full-width menu row matching
          the menus' own entries, not a toolbar chip. */}
      <div data-testid="composer-capability-menu">
        <WebSearchToggle disabled={controlsDisabled} onOpenSettings={onOpenSettings} />
        <RoomTargetPicker session={session} disabled={controlsDisabled} />
        <SkillsMenuEntry session={session} disabled={controlsDisabled} />
      </div>
    </>
  )
}
