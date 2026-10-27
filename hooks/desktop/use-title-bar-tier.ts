"use client"

/**
 * The title bar's width tier (`lib/desktop/title-bar-density.ts`), read from
 * the viewport — the bar spans the window, so the two are the same width.
 * `wide` outside a browser and wherever `matchMedia` is missing.
 */

import { useSyncExternalStore } from "react"

import { TITLE_BAR_TIER_QUERIES, type TitleBarTier } from "@/lib/desktop/title-bar-density"

function canMatch(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
}

function subscribe(notify: () => void): () => void {
  if (!canMatch()) return () => {}
  const lists = TITLE_BAR_TIER_QUERIES.map(([, query]) => window.matchMedia(query))
  for (const mq of lists) mq.addEventListener("change", notify)
  return () => {
    for (const mq of lists) mq.removeEventListener("change", notify)
  }
}

function snapshot(): TitleBarTier {
  if (!canMatch()) return "wide"
  for (const [tier, query] of TITLE_BAR_TIER_QUERIES) {
    if (window.matchMedia(query).matches) return tier
  }
  return "wide"
}

export function useTitleBarTier(): TitleBarTier {
  return useSyncExternalStore(subscribe, snapshot, () => "wide")
}
