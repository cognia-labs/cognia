// The value of the `pet.status` topic (`types/pet/events.ts`, ADR-0250 §14):
// what the tray and the glance read about the pet without importing it.
//
// Built here, from the stored profile, with the same `computePetView` the
// console and the widget use, so every surface agrees on the decayed needs.
// The bands come from the pet's own care thresholds.

import { NEUTRAL_MOOD_CEILING, UNWELL_NEED_THRESHOLD } from "@/lib/pet/care/condition"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"
import type { PetNeedsBand, PetStatusTopic, PetStatusView } from "@/types/pet/events"

/** The band of the lower of energy and mood. */
export function petNeedsBand(needs: { energy: number; mood: number }): PetNeedsBand {
  const worst = Math.min(needs.energy, needs.mood)
  if (worst < UNWELL_NEED_THRESHOLD) return "low"
  if (worst < NEUTRAL_MOOD_CEILING) return "neutral"
  return "high"
}

/** The pet decayed to `now`. */
export function petStatusView(profile: PetProfile, now: number): PetStatusView {
  const view = computePetView(profile, null, now)
  const needs = { energy: view.needs.energy, mood: view.needs.mood, bond: view.needs.bond }
  return { mood: view.mood, condition: view.condition, needs, band: petNeedsBand(needs) }
}

/**
 * The topic's value for this setting and profile. Off, or with no profile yet,
 * `at` answers `null`.
 */
export function petStatusTopic(
  enabled: boolean,
  profile: PetProfile | null | undefined
): PetStatusTopic {
  const live = enabled && profile ? profile : null
  return {
    enabled,
    at: (now) => (live ? petStatusView(live, now) : null),
  }
}
