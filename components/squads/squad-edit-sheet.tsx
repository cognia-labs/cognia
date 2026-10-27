"use client"

/**
 * A Squad's editor, opened over `/squads` instead of in Settings.
 *
 * "Configure this Squad", "Edit roster" and "Add a teammate" all used to leave
 * the page for `/settings?section=squads`, so changing one member of a Squad
 * you were watching meant losing the run you were watching it for, then
 * finding the way back. The edit now happens beside the Squad.
 *
 * The body IS the Settings library's panel (`SquadDetailPanel`), mounted
 * whole: name, roster, readiness, provenance, the advanced governance block and
 * delete. One editor in two places, not two editors, so a field added to one is
 * in both. Settings keeps its own entry for browsing the library.
 *
 * `ResponsiveDetailSheet` is the house drawer: a right sheet on a wide pane and
 * a bottom drawer on a phone. `focus` is `?edit=` from the URL, so a reload or a
 * shared link reopens it, and `roster` scrolls to the members, which is what
 * the two roster entries are asking for.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { SQUAD_ROSTER_SETTING_ID } from "@/components/settings/squads/nav-config"
import { SquadDetailPanel } from "@/components/settings/squads/squad-detail-panel"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import type { SquadEditFocus } from "@/hooks/squads/use-squad-route-state"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

export interface SquadEditSheetProps {
  squadId: string
  /** `undefined` is closed. */
  focus: SquadEditFocus | undefined
  onFocusChange: (focus: SquadEditFocus | undefined) => void
  /** After a delete: the Squad is gone, so the host leaves it. */
  onDeleted: (squadId: string) => void
  /** A duplicate opens its copy, with the drawer still open on it. */
  onOpenSquad: (squadId: string) => void
}

export function SquadEditSheet({
  squadId,
  focus,
  onFocusChange,
  onDeleted,
  onOpenSquad,
}: SquadEditSheetProps) {
  const t = useTranslations("squads.edit")
  const name = useAgentTeamStore((s) => s.teams[squadId]?.name ?? "")
  const body = useRef<HTMLDivElement>(null)
  const open = focus !== undefined

  // DOM-only: scroll the body to the roster once it has rendered. The sheet
  // animates in, so wait a frame for its content to be laid out.
  useEffect(() => {
    if (focus !== "roster") return
    const frame = requestAnimationFrame(() => {
      body.current
        ?.querySelector(`[data-setting-id="${SQUAD_ROSTER_SETTING_ID}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" })
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, squadId])

  return (
    <ResponsiveDetailSheet
      open={open}
      onOpenChange={(next) => onFocusChange(next ? (focus ?? "general") : undefined)}
      title={t("title", { name })}
      description={t("description")}
      contentClassName="flex flex-col gap-0 sm:max-w-[36rem]"
    >
      <div
        ref={body}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-6"
        data-testid="squad-edit-sheet"
        data-focus={focus}
      >
        {open ? (
          <SquadDetailPanel squadId={squadId} onDeleted={onDeleted} onOpenSquad={onOpenSquad} />
        ) : null}
      </div>
    </ResponsiveDetailSheet>
  )
}

export default SquadEditSheet
