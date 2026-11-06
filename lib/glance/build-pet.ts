/**
 * Pet slice: mood and needs, decayed to now (ADR-0225 §2). Read from the
 * pet's `pet.status` topic (ADR-0250 §14), which decays the pet with the same
 * `computePetView` its console and the tray menu use, so all three agree and
 * the glance never imports the pet.
 */

import type { PetStatusTopic } from "@/types/pet/events"

import type { GlancePetSlice } from "./snapshot"

export function buildPetSlice(status: PetStatusTopic | undefined, now: number): GlancePetSlice {
  const view = status?.enabled ? status.at(now) : null
  if (!view) {
    return {
      updatedAt: now,
      enabled: false,
      mood: null,
      condition: null,
      energy: 0,
      moodLevel: 0,
      bond: 0,
    }
  }
  return {
    updatedAt: now,
    enabled: true,
    mood: view.mood,
    condition: view.condition,
    energy: Math.round(view.needs.energy),
    moodLevel: Math.round(view.needs.mood),
    bond: Math.round(view.needs.bond),
  }
}
