// Main-window hook that turns the controller's "that interaction was refused"
// store signal into a bubble.
//
// The controller decides refusals because it is the only place that sees every
// path into the pet, but it cannot render one: bubbles need the React i18n
// context, and the controller stays i18n-free. Same split as `usePetCareAlert`.
//
// A bubble, not a toast, on purpose. The refusal is in-fiction (the pet is
// still chewing, or has not hatched), and the bubble is the only feedback
// surface that already reaches the transparent overlay, where a toast cannot
// render. The cross-window bridge broadcasts bubble changes, so a refusal
// raised by a tray click shows up on whichever pet surface is open.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { usePetStore } from "@/stores/pet/pet-store"

/**
 * Authored variants per reason. Must match `pet.bubbles.refused.<reason>` in
 * BOTH locales. `lint:i18n` cannot check a template-literal key, so the
 * co-located test compares this against the authored arrays instead.
 */
export const REFUSAL_VARIANTS: Record<string, number> = {
  cooldown: 3,
  notHatched: 2,
}

const REFUSAL_BUBBLE_MS = 4000

/** i18n key segment for a refusal reason. */
function reasonKey(reason: string): string {
  return reason === "not-hatched" ? "notHatched" : reason
}

export function usePetInteractionRefusal(enabled: boolean): void {
  const t = useTranslations("pet")
  const refusal = usePetStore((s) => s.interactionRefusal)
  const setInteractionRefusal = usePetStore((s) => s.setInteractionRefusal)
  const setBubble = usePetStore((s) => s.setBubble)
  const handledAtRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!enabled || !refusal) return
    if (handledAtRef.current === refusal.at) return
    handledAtRef.current = refusal.at

    const key = reasonKey(refusal.reason)
    const variants = REFUSAL_VARIANTS[key]
    if (!variants) {
      setInteractionRefusal(null)
      return
    }
    // Deterministic from the refusal time so the renderer never calls
    // Math.random, matching how the template bubbles pick a variant.
    const pick = Math.abs(refusal.at) % variants
    const bubble = { text: t(`bubbles.refused.${key}.${pick}`), origin: "template" as const }
    setBubble(bubble)
    const version = usePetStore.getState().bubbleVersion
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      usePetStore.getState().clearBubbleIfOwner(version, bubble)
    }, REFUSAL_BUBBLE_MS)
    setInteractionRefusal(null)
  }, [enabled, refusal, setBubble, setInteractionRefusal, t])
}
