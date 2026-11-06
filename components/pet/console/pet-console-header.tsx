// The pet's identity at the top of Settings → Pet's detail card, on the
// shared `FeaturePageHeader` (the same identity tile and action cluster every
// feature page and settings detail uses).
//
// The pet itself in the identity tile, its name (editable once it has one), a
// level · stage · coins line, and on the right the "out on the desktop"
// toggle. Navigation is the rail beside the card (`PetConsoleNav`), so the
// header carries no tabs and no Appearance entry: Appearance & settings is a
// rail item.
//
// Presentational: every action arrives as a prop from `PetConsole`, which is
// the one place that decides what renaming or summoning the pet actually runs.
//
// Caring for the desktop pet from a paired phone (ADR-0219), the toggle
// becomes the header's status chip saying whether the pet is out on the
// desktop (only the desktop can send it out).

"use client"

import { useTranslations } from "next-intl"
import { Loader2Icon, MonitorOffIcon, MonitorUpIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  FeaturePageHeader,
  type FeatureHeaderStatus,
} from "@/components/feature-shell/feature-page-header"
import { normalizeCoins } from "@/types/pet"
import type { PetProfile, PetSkinId, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { PetRenderer } from "../pet-renderer"
import { PetNameEditor } from "../pet-name-editor"

export interface PetConsoleHeaderProps {
  profile: PetProfile
  view: PetView
  effectiveSkinId: PetSkinId
  selection: PetSkinSelection
  lowPower?: boolean
  onRename: (name: string) => void
  /** Desktop overlay state + toggle. Omitted, the toggle is not offered. */
  desktop?: {
    onDesktop: boolean
    pending: boolean
    onToggle: () => void
  }
  /**
   * Remote care: whether the pet is out on the desktop, shown as the header's
   * status chip in place of the toggle (only the desktop can send it out).
   */
  desktopStatus?: { visible: boolean }
}

export function PetConsoleHeader({
  profile,
  view,
  effectiveSkinId,
  selection,
  lowPower,
  onRename,
  desktop,
  desktopStatus,
}: PetConsoleHeaderProps) {
  const t = useTranslations("pet")
  const desktopLabel = desktop?.onDesktop
    ? t("quickMenu.hideDesktopPet")
    : t("quickMenu.showDesktopPet")

  const avatar = (
    <PetRenderer
      bones={view.effectiveBones}
      stage={profile.stage}
      state="idle"
      size={34}
      skinId={effectiveSkinId}
      selection={selection}
      renderPriority="console"
      lowPower={lowPower}
      flavor={profile.evolutionFlavor}
    />
  )

  const meta = (
    <span
      data-testid="pet-console-meta"
      className="flex min-w-0 items-center gap-x-1.5 tabular-nums"
    >
      <span>{t("panel.level", { level: profile.level })}</span>
      <span aria-hidden>·</span>
      <span>{t(`console.stages.${profile.stage}`)}</span>
      <span aria-hidden>·</span>
      <span>{t("shop.balance", { coins: normalizeCoins(profile.coins) })}</span>
    </span>
  )

  const desktopStatusChip: FeatureHeaderStatus | undefined = desktopStatus
    ? {
        label: desktopStatus.visible
          ? t("console.remote.desktopVisible")
          : t("console.remote.desktopHidden"),
        tone: desktopStatus.visible ? "success" : "neutral",
        testId: "pet-console-desktop-status",
      }
    : undefined

  const desktopControl = desktopStatus ? null : desktop ? (
    // The console is where people look after the pet, so it is also where
    // they send it out to the desktop and call it back. The same switch as
    // the title bar's and the popup's (`desktopPet.enabled`).
    <Button
      type="button"
      size="sm"
      variant={desktop.onDesktop ? "outline" : "default"}
      className="shrink-0"
      data-testid="pet-console-desktop-toggle"
      aria-pressed={desktop.onDesktop}
      aria-busy={desktop.pending || undefined}
      disabled={desktop.pending}
      onClick={desktop.onToggle}
    >
      {desktop.pending ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      ) : desktop.onDesktop ? (
        <MonitorOffIcon className="size-3.5" aria-hidden />
      ) : (
        <MonitorUpIcon className="size-3.5" aria-hidden />
      )}
      <span className="hidden @lg/feature-header:inline">{desktopLabel}</span>
      <span className="sr-only @lg/feature-header:hidden">{desktopLabel}</span>
    </Button>
  ) : null

  return (
    <FeaturePageHeader
      testId="pet-console-header"
      // Settings' own header is the page's h1; the pet heads the detail card.
      headingLevel={2}
      avatar={avatar}
      title={
        profile.soul ? (
          <PetNameEditor name={profile.soul.name} onRename={onRename} nameClassName="" />
        ) : (
          t("console.title")
        )
      }
      description={meta}
      status={desktopStatusChip}
      // A toggle (`aria-pressed`), so it stays a custom control.
      actions={desktopControl}
    />
  )
}
