// What the pet needs most right now, and the care that answers it.
//
// The console's Home and the desktop popup open on one line ("Most needed
// now: energy 23%  [Sleep]") instead of leaving the reader to compare three
// meters against seven buttons. Pure: the caller passes the lazily-decayed
// needs from `computePetView` and the cooldown it already reads.
//
// The ranking comes from `INTERACTION_EFFECTS`, the same table the controller
// applies, so the suggestion is always the action that restores that need the
// most. `talked` is left out: it is owned by the speak pipeline, not a button.

import type { PetNeedKind, PetNeeds } from "@/types/pet"
import { INTERACTION_EFFECTS, type PetInteractionKind } from "@/lib/pet/needs/decay"
import { NEUTRAL_MOOD_CEILING, UNWELL_NEED_THRESHOLD } from "./condition"

/** The needs the suggestion weighs, in tie-break order. */
const NEED_ORDER: readonly PetNeedKind[] = ["energy", "mood", "bond"]

/** Below this a need reads as "attention", between it and the unwell line. */
export const ATTENTION_NEED_THRESHOLD = 50

/** How urgent the most-needed need is. */
export type PetCareTone = "urgent" | "attention" | "suggest"

export type PetCareSuggestion =
  | {
      status: "needs"
      need: PetNeedKind
      /** 0–100, rounded. */
      value: number
      tone: PetCareTone
      /** The action to offer: the best restorer of `need` not cooling down,
       *  or the best one when every one is. */
      action: PetInteractionKind
      /** Remaining cooldown of `action` in ms (0 when it can run now). */
      cooldownMs: number
    }
  | { status: "content" }

const SUGGESTABLE: readonly PetInteractionKind[] = (
  Object.keys(INTERACTION_EFFECTS) as PetInteractionKind[]
).filter((kind) => kind !== "talked")

/** Actions that raise `need`, best first. */
export function careActionsFor(need: PetNeedKind): PetInteractionKind[] {
  return SUGGESTABLE.filter((kind) => (INTERACTION_EFFECTS[kind][need] ?? 0) > 0).sort(
    (a, b) => (INTERACTION_EFFECTS[b][need] ?? 0) - (INTERACTION_EFFECTS[a][need] ?? 0)
  )
}

function toneFor(value: number): PetCareTone {
  if (value < UNWELL_NEED_THRESHOLD) return "urgent"
  if (value < ATTENTION_NEED_THRESHOLD) return "attention"
  return "suggest"
}

/**
 * The most-needed care. Every need at or above the content line
 * (`NEUTRAL_MOOD_CEILING`) is `content`: nothing is worth pushing.
 */
export function suggestPetCare(
  needs: Pick<PetNeeds, PetNeedKind>,
  cooldownRemaining: (kind: string) => number = () => 0
): PetCareSuggestion {
  let need: PetNeedKind = NEED_ORDER[0]
  for (const kind of NEED_ORDER) if (needs[kind] < needs[need]) need = kind
  const value = Math.round(needs[need])
  if (value >= NEUTRAL_MOOD_CEILING) return { status: "content" }

  const candidates = careActionsFor(need)
  const ready = candidates.find((kind) => cooldownRemaining(kind) <= 0)
  const action = ready ?? candidates[0]
  return {
    status: "needs",
    need,
    value,
    tone: toneFor(value),
    action,
    cooldownMs: ready ? 0 : Math.max(0, cooldownRemaining(action)),
  }
}
