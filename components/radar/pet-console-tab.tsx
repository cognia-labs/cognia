"use client"

// The radar's panel in the pet console's Extensions tab: the module's
// contribution to `pet.console.tab` (`./module.ui.ts`). The console renders it
// through `PluginExtensionSlot`, ahead of any plugin's panel.

import type { ModuleSlotProps } from "@/lib/modules/manifest-types"

import { RadarPanel } from "./radar-panel"

export default function RadarPetConsoleTab(_props: ModuleSlotProps) {
  return (
    <div
      data-testid="radar-pet-console-tab"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
    >
      <RadarPanel />
    </div>
  )
}
