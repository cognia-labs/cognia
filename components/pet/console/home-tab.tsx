// The `/pet` console's Home: where the pet is now and what to do about it.
//
// Two columns once the pane is wide enough. The left one is the pet as it is
// (the hero on the console's one accent surface, mood, condition with how to
// recover, level and the three needs) and sticks while the right one scrolls.
// The right one reads top to bottom as the reader's next steps:
//
//   1. Most needed now: the lowest need and the care that answers it, as the
//      page's primary button (`PetCareSuggestion`).
//   2. Care: every action, plus any plugin-contributed actions.
//   3. Backpack: quick-use items, coins and streak, and the way to the shop.
//   4. Talk: a quick line to the pet, and the way to the full conversation.
//   5. Stats: the pet's identity and growth.
//
// On a narrow pane they stack, pet first. Flat sections with headings and
// hairlines, no cards: the console is already a page.
//
// Every action arrives as a prop: the console decides what feeding the pet
// runs, locally or as an RPC to the desktop (ADR-0219).

"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, MessagesSquareIcon } from "lucide-react"
import type { PetProfile, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { PetInteractionKind } from "@/lib/pet/needs/decay"
import { usePetStore } from "@/stores/pet/pet-store"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { PetStatCard } from "../pet-stat-card"
import { PetVitalsCard } from "../pet-vitals-card"
import { PetWalletStrip } from "../pet-wallet-strip"
import { PetActionGrid } from "../pet-action-grid"
import { PetInventoryStrip } from "../pet-inventory-strip"
import { PetTalkComposer } from "../pet-talk-composer"
import { PetRenderer } from "../pet-renderer"
import { PetCareSuggestion } from "../pet-care-suggestion"

export interface HomeTabProps {
  profile: PetProfile
  view: PetView
  /** Run one of the six care actions. */
  onCare: (kind: Exclude<PetInteractionKind, "talked">) => void
  /** Talk to the pet. Composer text rides along; a bare talk omits it. */
  onTalk: (text?: string) => void
  /** Effective skin so the hero matches the live pet. */
  skinId?: string
  selection?: PetSkinSelection
  lowPower?: boolean
  /** Open the console's Shop. */
  onOpenShop?: () => void
  /** Open the console's Chat. */
  onOpenChat?: () => void
  /** Remaining cooldown per care kind when the caller owns it (remote care). */
  cooldownRemaining?: (kind: string) => number
  /**
   * `composer` keeps a quick-talk field on the page, whose words reach the
   * pet's LLM speak. `direct` makes talk a plain care action: remote care
   * (ADR-0219) carries conversation through the Chat tab, which records the
   * turn, so a field here would collect words the desktop never sees.
   */
  talkMode?: "composer" | "direct"
  /**
   * Mount the `pet.panel.actions` plugin slot under the care actions. Only the
   * desktop's main window runs plugins, so the remote console turns it off.
   */
  showPluginActions?: boolean
  /** A note about the pet's picture (the skin fallback), above the columns. */
  notice?: ReactNode
}

function SectionHeading({
  id,
  children,
  action,
}: {
  id: string
  children: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <h2 id={id} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {children}
      </h2>
      {action}
    </div>
  )
}

export function HomeTab({
  profile,
  view,
  onCare,
  onTalk,
  skinId,
  selection,
  lowPower,
  onOpenShop,
  onOpenChat,
  cooldownRemaining,
  talkMode = "composer",
  showPluginActions = true,
  notice,
}: HomeTabProps) {
  const t = useTranslations("pet")
  const grewStats = usePetStore((s) => s.lastGrewStats)
  const petName = profile.soul?.name

  const openChat = onOpenChat ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="pet-home-open-chat"
      className="-me-2 h-7 gap-1 text-xs text-muted-foreground"
      onClick={onOpenChat}
    >
      {t("console.home.openChat")}
      <ChevronRightIcon className="size-3.5" aria-hidden />
    </Button>
  ) : null

  return (
    <div data-testid="pet-home-tab" className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {notice}
      <div className="grid gap-6 @3xl/pet-pane:grid-cols-[18rem_minmax(0,1fr)] @3xl/pet-pane:items-start @5xl/pet-pane:gap-10">
        {/* The pet as it is now. Sticky beside the actions on a wide pane. */}
        <section
          data-testid="pet-home-status"
          aria-labelledby="pet-home-status-heading"
          className="flex min-w-0 flex-col gap-4 @3xl/pet-pane:sticky @3xl/pet-pane:top-0"
        >
          <h2 id="pet-home-status-heading" className="sr-only">
            {t("console.home.status")}
          </h2>
          {/* The console's one accent surface: the pet stands on it. */}
          <div
            data-testid="pet-home-stage"
            className="flex justify-center rounded-xl bg-gradient-to-b from-primary/10 via-primary/4 to-transparent px-4 pt-6 pb-2"
          >
            <PetRenderer
              bones={view.effectiveBones}
              stage={profile.stage}
              state="idle"
              size={160}
              skinId={skinId}
              selection={selection}
              flavor={profile.evolutionFlavor}
              mood={view.mood}
              lowPower={lowPower}
              renderPriority="console"
            />
          </div>
          <PetVitalsCard
            xp={profile.xp}
            needs={view.needs}
            mood={view.mood}
            condition={view.condition}
            variant="flat"
            recoveryHint
          />
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section
            aria-labelledby="pet-home-next-heading"
            data-testid="pet-home-next"
            className="flex flex-col gap-2"
          >
            <h2 id="pet-home-next-heading" className="sr-only">
              {t("console.home.next")}
            </h2>
            <PetCareSuggestion
              needs={view.needs}
              petName={petName}
              onCare={(kind) => (kind === "talked" ? onTalk() : onCare(kind))}
              cooldownRemaining={cooldownRemaining}
            />
          </section>

          <Separator />

          <section aria-labelledby="pet-home-care-heading" className="flex flex-col gap-3">
            <SectionHeading id="pet-home-care-heading">{t("console.home.care")}</SectionHeading>
            <PetActionGrid
              size="comfortable"
              onFeed={() => onCare("fed")}
              onPlay={() => onCare("played")}
              onPet={() => onCare("petted")}
              onSleep={() => onCare("slept")}
              onClean={() => onCare("cleaned")}
              onTreat={() => onCare("treated")}
              // Local talk has its own field below; remote talk is a care tap.
              onToggleTalk={talkMode === "direct" ? () => onTalk() : undefined}
              cooldownRemaining={cooldownRemaining}
            />
            {showPluginActions ? (
              <PluginExtensionSlot
                point="pet.panel.actions"
                limit={4}
                className="flex flex-wrap items-center gap-2 empty:hidden"
                context={{
                  level: profile.level,
                  stage: profile.stage,
                  mood: view.mood,
                  condition: view.condition,
                }}
              />
            ) : null}
          </section>

          <Separator />

          <section aria-labelledby="pet-home-backpack-heading" className="flex flex-col gap-3">
            <SectionHeading id="pet-home-backpack-heading">
              {t("console.home.backpack")}
            </SectionHeading>
            <PetInventoryStrip variant="flat" size="comfortable" />
            <PetWalletStrip
              coins={profile.coins}
              streak={profile.streak}
              onOpenShop={onOpenShop}
              variant="flat"
              className="min-h-11"
            />
          </section>

          <Separator />

          <section aria-labelledby="pet-home-talk-heading" className="flex flex-col gap-3">
            <SectionHeading id="pet-home-talk-heading" action={openChat}>
              {t("console.home.talk")}
            </SectionHeading>
            {talkMode === "composer" ? (
              <PetTalkComposer onTalk={onTalk} autoFocus={false} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <MessagesSquareIcon className="size-4 shrink-0" aria-hidden />
                {t("console.home.talkInChat")}
              </p>
            )}
          </section>

          <Separator />

          <section aria-labelledby="pet-home-stats-heading" className="flex flex-col gap-3">
            <SectionHeading id="pet-home-stats-heading">{t("console.home.stats")}</SectionHeading>
            <PetStatCard
              bones={view.effectiveBones}
              soul={profile.soul}
              stage={profile.stage}
              progress={profile.statProgress}
              grew={grewStats}
              flavor={profile.evolutionFlavor}
              skinId={skinId}
              selection={selection}
              lowPower={lowPower}
              variant="flat"
            />
          </section>
        </div>
      </div>
    </div>
  )
}
