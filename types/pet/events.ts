/**
 * Moved to `@cognia/plugin-contract`, which owns the plugin contract types.
 * This re-export keeps host imports of `@/types/pet/events` working.
 */
import type { PetCondition, PetMood } from "@cognia/plugin-contract/types/pet"

export * from "@cognia/plugin-contract/types/pet/events"

// ── Topics the pet publishes (ADR-0250 §14) ──────────────────────────────────
// Read with `useTopic` / `readTopic` (`lib/runtime/topics.ts`). A reader
// imports only these types, never the pet's code; `undefined` means the pet's
// publisher is not running in this window.

/**
 * The lower of energy and mood, in three coarse bands: `low` is where the pet
 * starts to need care, `high` where it reads as happy. The thresholds are the
 * pet's (`lib/pet/care/condition.ts`), so a reader never re-derives them.
 */
export type PetNeedsBand = "low" | "neutral" | "high"

/** The pet decayed to one moment. */
export interface PetStatusView {
  mood: PetMood
  condition: PetCondition
  /** 0–100 each, decayed to the moment asked for. */
  needs: { energy: number; mood: number; bond: number }
  band: PetNeedsBand
}

/** `pet.status`: whether the pet is on, and how it is at any moment. */
export interface PetStatusTopic {
  /** `PetSettings.enabled`. */
  enabled: boolean
  /**
   * The pet decayed to `now`, or `null` while it is off or has no profile yet.
   * Needs decay with the clock, so a reader passes the moment it renders.
   */
  at(now: number): PetStatusView | null
}

declare module "@/lib/runtime/topics" {
  interface TopicMap {
    "pet.status": PetStatusTopic
  }
}
