"use client"
import type { CSSProperties, ReactNode } from "react"

import type { ResolvedComposerSkin } from "@/lib/chat/composer-skin"

import { composerCardRadiusPx } from "./composer-box"

/**
 * The run status, docked onto the card's top edge. The inset follows the
 * corner the card actually draws (`composerCardRadiusPx` — the phone card
 * rounds further than the classic skin's own radius) so the strip's sides land
 * where the card's top edge has turned straight; a pill skin insets more, the
 * square skin not at all. Its own top corners echo the card's inner curve.
 */
export function ComposerRunStatusStrip({
  skin,
  compactLayout,
  children,
}: {
  skin: ResolvedComposerSkin
  compactLayout: boolean
  children: ReactNode
}) {
  const radius = composerCardRadiusPx(skin, compactLayout)
  return (
    <div
      data-slot="composer-run-status"
      className="empty:hidden"
      style={
        {
          paddingInline: `${radius}px`,
          "--run-strip-radius": `${Math.round(radius * 0.6)}px`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}
