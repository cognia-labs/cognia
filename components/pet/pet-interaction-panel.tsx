// The desktop popup's pet panel: a mini version of the /pet console's Home,
// read in the same order. Who the pet is (stat card, level and needs), what
// it needs most right now with the care that answers it, every care action,
// and a quick line to talk. The window actions (click-through, put away, open
// the pet page, appearance & settings) are the popup's own, below this panel.
//
// The stat card, vitals, suggestion, action grid and talk composer are the
// same components the console's Home uses, so the popup shares its cooldown
// gate, its "most needed" choice, IME-safe Enter and ↑/↓ phrase recall.
//
// Inventory and plugin actions are not here: consuming an item emits a pet
// event and this window has no controller to process it (the bridge carries
// only the seven care interactions), and plugins run only in the main window.
// Both live on the console's Home.

"use client"

import type { PetProfile, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { PetInteractionKind } from "@/lib/pet/needs/decay"
import { cn } from "@/lib/utils"
import { usePetStore } from "@/stores/pet/pet-store"
import { PetStatCard } from "./pet-stat-card"
import { PetVitalsCard } from "./pet-vitals-card"
import { PetActionGrid } from "./pet-action-grid"
import { PetCareSuggestion } from "./pet-care-suggestion"
import { PetTalkComposer } from "./pet-talk-composer"

export interface PetInteractionPanelProps {
  profile: PetProfile
  view: PetView
  /** Run one of the six care actions. */
  onCare: (kind: Exclude<PetInteractionKind, "talked">) => void
  /** Talk action. Submitted composer text rides along; empty submit omits it. */
  onTalk: (text?: string) => void
  /** Effective skin for the stat-card preview (so it matches the live pet). */
  skinId?: string
  selection?: PetSkinSelection
  className?: string
}

export function PetInteractionPanel({
  profile,
  view,
  onCare,
  onTalk,
  skinId,
  selection,
  className,
}: PetInteractionPanelProps) {
  const grewStats = usePetStore((s) => s.lastGrewStats)

  return (
    <div
      data-testid="pet-interaction-panel"
      className={cn(
        "flex max-h-[calc(100dvh-2rem)] w-[min(18rem,calc(100vw-3rem))] max-w-full flex-col gap-3 overflow-y-auto overscroll-contain",
        className
      )}
    >
      <PetStatCard
        bones={view.effectiveBones}
        soul={profile.soul}
        stage={profile.stage}
        progress={profile.statProgress}
        grew={grewStats}
        flavor={profile.evolutionFlavor}
        skinId={skinId}
        selection={selection}
      />

      <PetVitalsCard
        xp={profile.xp}
        needs={view.needs}
        mood={view.mood}
        condition={view.condition}
      />

      <PetCareSuggestion
        size="compact"
        needs={view.needs}
        petName={profile.soul?.name}
        onCare={(kind) => (kind === "talked" ? onTalk() : onCare(kind))}
      />

      <PetActionGrid
        onFeed={() => onCare("fed")}
        onPlay={() => onCare("played")}
        onPet={() => onCare("petted")}
        onSleep={() => onCare("slept")}
        onClean={() => onCare("cleaned")}
        onTreat={() => onCare("treated")}
      />

      <PetTalkComposer onTalk={onTalk} autoFocus={false} />
    </div>
  )
}
