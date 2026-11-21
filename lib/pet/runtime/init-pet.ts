// Profile lifecycle: ensure the singleton exists, and hatch the egg (generate +
// persist the Soul) on demand. Both are idempotent. The account id is resolved
// by the caller (`lib/pet/bones/account-id.ts`) so this stays storage-only.

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetProfile } from "@/types/pet"
import { getPetProfile } from "@/lib/db/pet"
import { getDb } from "@/lib/db/schema"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { generateBones } from "@/lib/pet/bones/generate"
import { generatePetSoul } from "@/lib/pet/soul/generate-soul"
import { stageForLevel } from "@/lib/pet/xp/leveling"
import {
  assertPetScopeCurrent,
  capturePetScope,
  enqueuePetWork,
  isPetScopeCurrent,
} from "@/lib/pet/runtime/pet-scope"

function monotonicUpdatedAt(prevIso: string, candidateMs: number): string {
  const prevMs = Date.parse(prevIso)
  const nextMs = Number.isFinite(prevMs) ? Math.max(candidateMs, prevMs + 1) : candidateMs
  return new Date(nextMs).toISOString()
}

/** Ensure a profile row exists for this account; create a fresh egg if not. */
export async function ensurePetProfile(accountId: string, now = Date.now()): Promise<PetProfile> {
  const scope = capturePetScope()
  return enqueuePetWork(async () => {
    assertPetScopeCurrent(scope)
    const db = getDb()
    return db.transaction("rw", db.petProfile, async () => {
      assertPetScopeCurrent(scope)
      const existing = await db.petProfile.get("global")
      if (existing) return existing
      const created = createDefaultProfile(accountId, now)
      await db.petProfile.put(created)
      return created
    })
  })
}

export type HatchPetDetail =
  | { status: "hatched"; profile: PetProfile }
  | { status: "already-hatched"; profile: PetProfile }
  | { status: "stale" }
  | { status: "no-profile" }

/**
 * Hatch the egg and report whether THIS call installed the generated Soul,
 * another path already hatched it, or a reset/account-switch invalidated the
 * originating egg while the model was answering (F20).
 */
export async function hatchPetDetailed(
  client: LlmClient | null,
  now?: number
): Promise<HatchPetDetail> {
  const originScope = capturePetScope()
  const profile = await getPetProfile()
  if (!profile) return { status: "no-profile" }
  if (profile.soul) return { status: "already-hatched", profile }

  const originCreatedAt = profile.createdAt
  const bones = generateBones(profile.accountFingerprint)
  const soul = await generatePetSoul(client, bones, { now: now ?? Date.now() })
  if (!isPetScopeCurrent(originScope)) return { status: "stale" }

  return enqueuePetWork(async (): Promise<HatchPetDetail> => {
    if (!isPetScopeCurrent(originScope)) return { status: "stale" }
    const db = getDb()
    return db.transaction("rw", db.petProfile, async () => {
      if (!isPetScopeCurrent(originScope)) return { status: "stale" }
      const latest = await db.petProfile.get("global")
      if (!latest) return { status: "no-profile" }
      // A replacement egg was created after reset while the old hatch ran:
      // never install the old soul into the new egg.
      if (latest.createdAt !== originCreatedAt) return { status: "stale" }
      if (latest.soul) return { status: "already-hatched", profile: latest }
      const writeNow = now ?? Date.now()
      const updated: PetProfile = {
        ...latest,
        soul,
        stage: stageForLevel(latest.level),
        updatedAt: monotonicUpdatedAt(latest.updatedAt, writeNow),
      }
      await db.petProfile.put(updated)
      return { status: "hatched", profile: updated }
    })
  })
}

/**
 * Hatch the egg: generate the Soul (LLM, with deterministic fallback) and move to
 * the level-appropriate stage. No-op if already hatched, no profile exists, or
 * the originating egg was replaced/switched during generation (F20).
 */
export async function hatchPet(
  client: LlmClient | null,
  now?: number
): Promise<PetProfile | undefined> {
  const detail = await hatchPetDetailed(client, now)
  if (detail.status === "hatched" || detail.status === "already-hatched") {
    return detail.profile
  }
  return undefined
}
