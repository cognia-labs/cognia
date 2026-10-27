// The /pet console's header, on the shared `FeaturePageHeader` band every
// feature route uses (the same hairline, identity tile and action cluster as
// `/memory` and `/conversations`).
//
// Main view: the pet itself in the identity tile, its name (editable once it
// has one), a level · stage · coins line, the five-place navigation in the
// second row, and two actions on the right: "Appearance & settings", and the
// "out on the desktop" toggle.
//
// Appearance view: a breadcrumb back to the pet, the sub-page's title, and the
// same desktop toggle; no navigation row.
//
// Presentational: every action arrives as a prop from `PetConsole`, which is
// the one place that decides what renaming or summoning the pet actually runs.
//
// Caring for the desktop pet from a paired phone (ADR-0219), the toggle
// becomes a read-only chip saying whether the pet is out on the desktop, and
// the appearance entry carries the "Desktop" badge: its workspace is the
// desktop's (only the character binding reads remotely).

"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronLeftIcon,
  Loader2Icon,
  MonitorIcon,
  MonitorOffIcon,
  MonitorUpIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { normalizeCoins } from "@/types/pet"
import type { PetProfile, PetSkinId, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { PetRenderer } from "../pet-renderer"
import { PetNameEditor } from "../pet-name-editor"

export interface PetConsoleHeaderProps {
  /** Which view the header heads. */
  mode: "main" | "appearance"
  profile: PetProfile
  view: PetView
  effectiveSkinId: PetSkinId
  selection: PetSkinSelection
  lowPower?: boolean
  onRename: (name: string) => void
  /** The main view's navigation row. */
  navigation?: ReactNode
  /** Open the appearance sub-page (main view). */
  onOpenAppearance?: () => void
  /** The appearance workspace only runs on the desktop here: badge the entry. */
  appearanceDesktopOnly?: boolean
  /** Back to the main view (appearance view). */
  onBack?: () => void
  /** Desktop overlay state + toggle. Omitted, the toggle is not offered. */
  desktop?: {
    onDesktop: boolean
    pending: boolean
    onToggle: () => void
  }
  /**
   * Remote care: whether the pet is out on the desktop, shown as a read-only
   * chip in place of the toggle (only the desktop can send it out).
   */
  desktopStatus?: { visible: boolean }
}

export function PetConsoleHeader({
  mode,
  profile,
  view,
  effectiveSkinId,
  selection,
  lowPower,
  onRename,
  navigation,
  onOpenAppearance,
  appearanceDesktopOnly,
  onBack,
  desktop,
  desktopStatus,
}: PetConsoleHeaderProps) {
  const t = useTranslations("pet")
  const desktopLabel = desktop?.onDesktop
    ? t("quickMenu.hideDesktopPet")
    : t("quickMenu.showDesktopPet")
  const appearanceLabel = t("console.appearance.title")

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

  const appearanceEntry =
    mode === "main" && onOpenAppearance ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="pet-console-open-appearance"
            data-desktop-only={appearanceDesktopOnly || undefined}
            aria-label={appearanceLabel}
            className="size-8 px-0 @2xl/feature-header:w-auto @2xl/feature-header:px-3"
            onClick={onOpenAppearance}
          >
            <SlidersHorizontalIcon className="size-3.5" aria-hidden />
            <span className="hidden @2xl/feature-header:inline">{appearanceLabel}</span>
            {appearanceDesktopOnly ? (
              <span
                data-testid="pet-console-desktop-badge"
                className="hidden rounded-sm bg-muted px-1 py-px text-[10px] leading-none font-medium text-muted-foreground @2xl/feature-header:inline"
              >
                {t("console.desktopOnly.badge")}
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {appearanceDesktopOnly
            ? `${appearanceLabel} · ${t("console.desktopOnly.badge")}`
            : appearanceLabel}
        </TooltipContent>
      </Tooltip>
    ) : null

  const desktopControl = desktopStatus ? (
    <Badge
      variant="outline"
      data-testid="pet-console-desktop-status"
      data-visible={desktopStatus.visible}
      className="shrink-0 gap-1 text-muted-foreground"
    >
      <MonitorIcon className="size-3" aria-hidden />
      {desktopStatus.visible
        ? t("console.remote.desktopVisible")
        : t("console.remote.desktopHidden")}
    </Badge>
  ) : desktop ? (
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

  if (mode === "appearance") {
    return (
      <FeaturePageHeader
        testId="pet-console-header"
        avatar={avatar}
        breadcrumb={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="pet-console-back"
            className="-ms-1.5 h-8 gap-1 px-1.5 text-muted-foreground"
            onClick={onBack}
          >
            <ChevronLeftIcon className="size-4" aria-hidden />
            <span>{profile.soul?.name ?? t("console.title")}</span>
          </Button>
        }
        title={appearanceLabel}
        description={t("console.appearance.description")}
        actions={desktopControl}
      />
    )
  }

  return (
    <FeaturePageHeader
      testId="pet-console-header"
      avatar={avatar}
      title={
        profile.soul ? (
          <PetNameEditor name={profile.soul.name} onRename={onRename} nameClassName="" />
        ) : (
          t("console.title")
        )
      }
      description={meta}
      navigation={navigation}
      actions={
        <>
          {appearanceEntry}
          {desktopControl}
        </>
      }
    />
  )
}
