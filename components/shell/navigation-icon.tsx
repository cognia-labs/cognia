"use client"

import type { ComponentType } from "react"

import { MobileSpotIcon, type MobileSpotIconName } from "@/components/mobile/mobile-spot-icon"
import { useSettingsStore } from "@/stores/settings/settings-store"
import iconManifest from "@/public/icons/cognia-mobile-spots/icon-manifest.json"

const NAVIGATION_ARTWORK: Partial<Record<string, MobileSpotIconName>> = {
  ...(iconManifest.coverage.desktopNavigation as Record<string, MobileSpotIconName>),
  chat: "chat",
  canvas: "canvas",
  settings: "preferences",
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
  fallback: Fallback,
  className = "size-4",
}: {
  id: string
  fallback: ComponentType<{ className?: string }>
  className?: string
}) {
  const anime = useIllustratedNavigationIcons()
  const artwork = anime ? NAVIGATION_ARTWORK[id] : undefined
  return artwork ? (
    <span
      data-navigation-artwork={id}
      aria-hidden="true"
      className="pointer-events-none relative flex size-7 shrink-0 items-center justify-center"
    >
      <MobileSpotIcon name={artwork} size={28} className="size-7 shrink-0" />
    </span>
  ) : (
    <Fallback className={className} />
  )
}
