"use client"

/**
 * Render a glance layout: the visible entries, in order, one column,
 * hairline-separated (ADR-0225 §2, §3).
 *
 * Every first-party module has a default renderer here except `quick`, whose
 * content is the host's own action list (the tray panel's actions on the
 * desktop, the layout's shortcuts on a phone). Each host passes its own
 * through `renderers`.
 *
 * A plugin entry renders through `GlancePluginModule` while its module is in
 * the snapshot's plugin catalogue, at the nearest size the module declares.
 * An entry whose plugin is off is skipped: the layout keeps it for when the
 * plugin comes back (ADR-0225 §6).
 */

import type { ComponentType } from "react"

import { effectiveSize, effectiveSizeIn } from "@/lib/glance/registry"
import {
  isPluginEntryId,
  type GlanceLayoutEntry,
  type GlanceModuleId,
  type GlanceModuleSize,
} from "@/types/glance/layout"
import { cn } from "@/lib/utils"

import { useGlance } from "./glance-context"
import { GlanceUnavailableModule } from "./glance-primitives"
import { GlanceActivityModule } from "./modules/glance-activity-module"
import { GlanceAgendaModule } from "./modules/glance-agenda-module"
import { GlanceFleetModule } from "./modules/glance-fleet-module"
import { GlancePetModule } from "./modules/glance-pet-module"
import { GlancePluginModule } from "./modules/glance-plugin-module"
import { GlanceQuotaModule } from "./modules/glance-quota-module"
import { GlanceRecentsModule } from "./modules/glance-recents-module"
import { GlanceUsageModule } from "./modules/glance-usage-module"

export type GlanceModuleRenderer = ComponentType<{ size: GlanceModuleSize }>

export const DEFAULT_GLANCE_RENDERERS: Partial<Record<GlanceModuleId, GlanceModuleRenderer>> = {
  fleet: GlanceFleetModule,
  usage: GlanceUsageModule,
  quota: GlanceQuotaModule,
  agenda: GlanceAgendaModule,
  activity: GlanceActivityModule,
  recents: GlanceRecentsModule,
  pet: GlancePetModule,
}

export interface GlanceStackProps {
  entries: readonly GlanceLayoutEntry[]
  renderers?: Partial<Record<GlanceModuleId, GlanceModuleRenderer>>
  className?: string
  /**
   * `"list"` (default): one column, hairline-separated — a list to scan (the
   * tray panel, the Glance drawer). `"cards"`: each module on a soft card of
   * its own with air between them — a home screen to land on, where four
   * unrelated modules under one border read as one long form.
   */
  variant?: "list" | "cards"
}

const CARD_CLASS =
  "overflow-hidden rounded-2xl bg-foreground/[0.035] ring-1 ring-inset ring-border/50 empty:hidden"

export function GlanceStack({ entries, renderers, className, variant = "list" }: GlanceStackProps) {
  const { originOf, snapshot } = useGlance()
  const table = { ...DEFAULT_GLANCE_RENDERERS, ...renderers }
  const catalog = snapshot.plugins?.catalog ?? []
  const cards = variant === "cards"
  const renderEntry = (entry: GlanceLayoutEntry) => {
    const unavailable = originOf?.(entry.id)?.kind === "unavailable"
    if (isPluginEntryId(entry.id)) {
      const def = catalog.find((c) => c.id === entry.id)
      // A paired phone that never heard from its desktop knows the entry
      // but not the module yet: it says so rather than vanishing.
      if (unavailable) {
        return <GlanceUnavailableModule key={entry.id} moduleId={entry.id} title={def?.title} />
      }
      if (!def) return null
      return (
        <GlancePluginModule
          key={entry.id}
          entryId={entry.id}
          size={effectiveSizeIn(def.sizes, entry.size)}
        />
      )
    }
    const Module = table[entry.id]
    if (!Module) return null
    // A paired phone whose desktop cannot supply this module says so in
    // place, rather than leaving the module "loading" forever.
    if (unavailable) {
      return <GlanceUnavailableModule key={entry.id} moduleId={entry.id} />
    }
    return <Module key={entry.id} size={effectiveSize(entry.id, entry.size)} />
  }

  return (
    <div
      data-testid="glance-stack"
      data-variant={variant}
      className={cn("flex flex-col", cards ? "gap-2.5" : "divide-y divide-border", className)}
    >
      {entries
        .filter((entry) => !entry.hidden)
        .map((entry) => {
          const node = renderEntry(entry)
          if (!node || !cards) return node
          // `empty:hidden`: a module with nothing to say renders null, and its
          // card must not stay behind as an empty ring.
          return (
            <div key={entry.id} className={CARD_CLASS} data-slot="glance-card">
              {node}
            </div>
          )
        })}
    </div>
  )
}
