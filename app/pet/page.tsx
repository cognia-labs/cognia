"use client"

import { Suspense, useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { PetConsole } from "@/components/pet/console/pet-console"
import { petConsoleTargetFromParams } from "@/lib/pet/console-tabs"

/**
 * Full-page `/pet` console. The console owns its own scroll and chrome on the
 * shared `FeaturePageShell` (which also owns the wallpaper marker), like
 * `/memory` and `/conversations`. Static-export-safe deep link: where to open
 * rides in `?tab=` (any console destination) and `?view=appearance` (the
 * appearance sub-page), read via `useSearchParams` inside a `<Suspense>`
 * boundary; used by the popup, bubble actions, the agent's `pet_show`, the
 * title bar and Settings → Pet.
 */
function PetRoute() {
  const params = useSearchParams()
  const tab = params.get("tab")
  const view = params.get("view")
  // Stable per URL: the console follows a changed target, not a new object.
  const target = useMemo(() => petConsoleTargetFromParams(tab, view), [tab, view])
  return <PetConsole initialTarget={target} />
}

export default function PetPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <PetRoute />
      </Suspense>
    </div>
  )
}
