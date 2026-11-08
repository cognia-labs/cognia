"use client"

import { isValidElement, type ComponentType, type ReactElement } from "react"

import { AvatarBadge } from "@/components/shared/avatar-badge"
import { MobileSpotIcon, type MobileSpotIconName } from "@/components/mobile/mobile-spot-icon"
import type { AvatarSubject } from "@/lib/ui/avatar"
import { navCatalog } from "@/lib/shell/nav-catalog"
import { useSettingsStore } from "@/stores/settings/settings-store"
import iconManifest from "@/public/icons/cognia-mobile-spots/icon-manifest.json"

const NAVIGATION_ARTWORK: Partial<Record<string, MobileSpotIconName>> = {
  ...(iconManifest.coverage.desktopNavigation as Record<string, MobileSpotIconName>),
  // A module destination names its illustration in its manifest; the gate
  // checks it is a `MobileSpotIconName`.
  ...Object.fromEntries(
    navCatalog().flatMap((entry) =>
      entry.module && entry.spotIcon ? [[entry.id, entry.spotIcon as MobileSpotIconName]] : []
    )
  ),
  chat: "chat",
  canvas: "canvas",
  settings: "preferences",
  more: "sidebar",
  "glance:fleet": "fleet",
  "glance:quick": "shortcuts",
  "glance:usage": "usage-cost",
  "glance:activity": "performance",
  "glance:recents": "command-history",
  "glance:quota": "subscription",
  "glance:agenda": "scheduler",
  "glance:pet": "pet",
  "cognia-config-governance:config-governance": "security",
  team_builtin_brainstorm: "skills",
  team_builtin_code_review_pair: "source-control",
  team_builtin_doc_polishers: "instructions",
  team_builtin_research_squad: "discover",
}

/**
 * Whether navigation draws its illustrated artwork (the saved icon style is
 * anything but "ordinary"). Exported so a host can lay a tile out for the
 * style it will get: a plate behind a line icon is a box around a glyph,
 * behind an illustration it is the illustration's frame.
 */
export function useIllustratedNavigationIcons(): boolean {
  return useSettingsStore((s) => s.settings?.settingsIconStyle !== "ordinary")
}

/** Keeps the rail, expanded rows and overflow menu on the same saved icon style. */
export function NavigationIcon({
  id,
  fallback,
  defaultArtwork,
  size = 28,
  className = "size-4",
}: {
  id: string
  fallback: ComponentType<{ className?: string }> | ReactElement
  /** Artwork for dynamic plugin/team entries absent from the built-in catalog. */
  defaultArtwork?: MobileSpotIconName
  size?: number
  className?: string
}) {
  const anime = useIllustratedNavigationIcons()
  const artwork = anime ? (NAVIGATION_ARTWORK[id] ?? defaultArtwork) : undefined
  if (artwork)
    return (
      <span
        data-navigation-artwork={id}
        aria-hidden="true"
        className="pointer-events-none relative flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <MobileSpotIcon name={artwork} size={size} className="size-full shrink-0" />
      </span>
    )
  if (isValidElement(fallback)) return fallback
  const Fallback = fallback
  return <Fallback className={className} />
}

/** Team scopes use the same artwork in expanded rows and the collapsed rail. */
export function TeamNavigationIcon({
  team,
  size = 16,
  textClassName,
}: {
  team: AvatarSubject & { id: string }
  size?: number
  textClassName?: string
}) {
  const avatar = <AvatarBadge subject={team} size={size} textClassName={textClassName} />
  if (team.avatarImageUrl) return avatar
  return <NavigationIcon id={team.id} defaultArtwork="teams" fallback={avatar} />
}
