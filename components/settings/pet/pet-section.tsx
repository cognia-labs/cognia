"use client"

// Settings → Pet: the pet's whole console (ADR-0058 D16). Home, chat, shop,
// collection, activity, extensions and the Appearance & settings sub-page all
// live here; there is no `/pet` page to send anyone to. The place to open
// rides in the section's own params (`petTab`, `petView`, written by
// `petConsoleHref`), read here so a deep link from the popup, a bubble, the
// agent's `pet_show`, the title bar or ⌘K lands where it points.
//
// The phone's Me sub-page `/me/pet` renders this same section.

import { useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { PetConsole } from "@/components/pet/console/pet-console"
import { PET_TAB_PARAM, PET_VIEW_PARAM, petConsoleTargetFromParams } from "@/lib/pet/console-tabs"

export function PetSection() {
  const params = useSearchParams()
  const tab = params.get(PET_TAB_PARAM)
  const view = params.get(PET_VIEW_PARAM)
  // Stable per URL: the console follows a changed target, not a new object.
  const target = useMemo(() => petConsoleTargetFromParams(tab, view), [tab, view])
  return (
    <div
      data-testid="settings-pet-section"
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      <PetConsole initialTarget={target} />
    </div>
  )
}

export default PetSection
