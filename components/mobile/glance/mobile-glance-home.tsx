"use client"

/**
 * The phone's home screen glance (ADR-0225 §9): the modules pinned to the
 * home screen, in layout order, in one container under the composer.
 *
 * It replaces four blocks that each had their own model and editor (the
 * active-runs card, the shortcut grid, the usage dashboard, recents). The
 * home stays as quiet as those blocks were: Fleet appears only while
 * something is running, waiting or failed (the active-runs card hid itself
 * when idle), usage, activity and recents only once there is some, and an
 * empty shortcut list shows nothing. The Glance drawer always shows every visible
 * module, quiet or not.
 */

import { useMemo } from "react"

import { GlanceProvider } from "@/components/glance/glance-context"
import { GlanceStack } from "@/components/glance/glance-stack"
import { homeEntries } from "@/lib/glance/mobile-layout"
import type { GlanceModuleOrigin } from "@/lib/glance/remote/phone-view"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { cn } from "@/lib/utils"
import type { GlanceMobileEntry, GlanceModuleId } from "@/types/glance/layout"

import { useMobileGlanceContext, useRegisterGlanceHome } from "./mobile-glance-provider"
import { MobileGlanceQuickModule } from "./mobile-glance-quick-module"

const RENDERERS = { quick: MobileGlanceQuickModule }

/** Whether a pinned module has something to say on the home screen right now. */
export function speaksOnHome(
  entry: GlanceMobileEntry,
  snapshot: GlanceSnapshotV1,
  shortcuts: readonly string[],
  origin: GlanceModuleOrigin | null
): boolean {
  if (entry.id === "fleet") {
    const fleet = snapshot.fleet
    if (!fleet || origin?.kind === "unavailable") return false
    const { counts, workflows } = fleet
    return counts.working + counts.awaiting + counts.failed + workflows.running > 0
  }
  if (entry.id === "quick") return shortcuts.length > 0
  // A fresh phone has no usage, activity or conversations yet. Three columns
  // of zeros, an empty heatmap and "No recent conversations" were most of its
  // home screen; the modules join it with the first turn, and the drawer
  // shows them regardless.
  if (entry.id === "usage") return (snapshot.usage?.month.turns ?? 0) > 0
  if (entry.id === "activity") return (snapshot.activity?.activeDays ?? 0) > 0
  if (entry.id === "recents") return (snapshot.recents?.rows.length ?? 0) > 0
  return true
}

export function MobileGlanceHome({ className }: { className?: string }) {
  useRegisterGlanceHome()
  const { settings, glance, originOf } = useMobileGlanceContext()

  const entries = useMemo(
    () =>
      homeEntries(settings.entries).filter((entry) =>
        speaksOnHome(entry, glance.snapshot, settings.shortcuts, originOf(entry.id as GlanceModuleId))
      ),
    [settings.entries, settings.shortcuts, glance.snapshot, originOf]
  )

  if (entries.length === 0) return null

  return (
    <GlanceProvider value={glance}>
      <section data-testid="mobile-glance-home" className={cn("w-full", className)}>
        {/* One soft card per module, not one bordered slab for all of them:
            stacked under a single border, four unrelated modules read as one
            long form, and the eye had nowhere to rest between them. The
            drawer keeps the hairline-divided list. */}
        <GlanceStack entries={entries} renderers={RENDERERS} variant="cards" />
      </section>
    </GlanceProvider>
  )
}
