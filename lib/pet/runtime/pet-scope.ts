// Account-partition and lifecycle generation fences for the pet subsystem.
//
// Long-lived pet work (model replies, proactive chatter, egg hatching, remote
// intents, queued controller events) spans awaits during which the user may
// switch or lock accounts, clear pet conversation history, or reset the pet.
// Capturing a `PetScopeToken` before the first await and validating it before
// persisting or publishing prevents cross-account writes (F15), post-clear
// resurrections (F4), post-reset resurrections (F19), and stale hatch souls
// installing into replacement eggs (F20).
//
// Kept as a leaf module depending only on `lib/db/schema` so `lib/db/pet*`,
// `lib/pet/runtime/*`, `lib/pet/chat/*`, `lib/pet/remote/*`, and `hooks/pet/*`
// can share one generation owner without circular imports.

import { activeDatabaseEpoch, activeDatabaseName, onActiveDatabaseChange } from "@/lib/db/schema"

export interface PetScopeToken {
  readonly databaseName: string
  readonly databaseEpoch: number
  readonly petGeneration: number
  readonly conversationGeneration: number
}

export class PetScopeInvalidatedError extends Error {
  readonly reason: "database-changed" | "pet-reset" | "conversation-cleared"

  constructor(reason: "database-changed" | "pet-reset" | "conversation-cleared") {
    super(`Pet scope invalidated: ${reason}`)
    this.name = "PetScopeInvalidatedError"
    this.reason = reason
  }
}

const petGenerations = new Map<string, number>()
const conversationGenerations = new Map<string, number>()

type ScopeListener = (databaseName: string) => void
const petResetListeners = new Set<ScopeListener>()
const conversationClearedListeners = new Set<ScopeListener>()

function notify(listeners: Set<ScopeListener>, databaseName: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(databaseName)
    } catch {
      // Never let one subscriber break lifecycle invalidation for the rest.
    }
  }
}

export function getPetGeneration(databaseName = activeDatabaseName()): number {
  return petGenerations.get(databaseName) ?? 0
}

export function getPetConversationGeneration(databaseName = activeDatabaseName()): number {
  return conversationGenerations.get(databaseName) ?? 0
}

/** Snapshot the active account partition and both pet lifecycle generations. */
export function capturePetScope(): PetScopeToken {
  const databaseName = activeDatabaseName()
  return {
    databaseName,
    databaseEpoch: activeDatabaseEpoch(),
    petGeneration: getPetGeneration(databaseName),
    conversationGeneration: getPetConversationGeneration(databaseName),
  }
}

/** True while the active account DB and epoch still match the captured token. */
export function isPetDatabaseCurrent(
  token: Pick<PetScopeToken, "databaseName" | "databaseEpoch">
): boolean {
  return (
    activeDatabaseName() === token.databaseName && activeDatabaseEpoch() === token.databaseEpoch
  )
}

/** True while the account DB, epoch, and pet generation still match. */
export function isPetScopeCurrent(
  token: Pick<PetScopeToken, "databaseName" | "databaseEpoch" | "petGeneration">
): boolean {
  return isPetDatabaseCurrent(token) && getPetGeneration(token.databaseName) === token.petGeneration
}

/** True while the account DB, epoch, pet generation, and conversation generation still match. */
export function isPetConversationScopeCurrent(token: PetScopeToken): boolean {
  return (
    isPetScopeCurrent(token) &&
    getPetConversationGeneration(token.databaseName) === token.conversationGeneration
  )
}

export function assertPetScopeCurrent(
  token: Pick<PetScopeToken, "databaseName" | "databaseEpoch" | "petGeneration">
): void {
  if (!isPetDatabaseCurrent(token)) {
    throw new PetScopeInvalidatedError("database-changed")
  }
  if (getPetGeneration(token.databaseName) !== token.petGeneration) {
    throw new PetScopeInvalidatedError("pet-reset")
  }
}

export function assertPetConversationScopeCurrent(token: PetScopeToken): void {
  assertPetScopeCurrent(token)
  if (getPetConversationGeneration(token.databaseName) !== token.conversationGeneration) {
    throw new PetScopeInvalidatedError("conversation-cleared")
  }
}

/**
 * Invalidate in-flight pet conversation writes and cached private replies for
 * `databaseName`. Called by `clearPetConversation` and `resetPet`.
 */
export function bumpPetConversationGeneration(databaseName = activeDatabaseName()): number {
  const next = getPetConversationGeneration(databaseName) + 1
  conversationGenerations.set(databaseName, next)
  notify(conversationClearedListeners, databaseName)
  return next
}

/**
 * Invalidate in-flight controller writes, pending hatches, and conversation
 * work for `databaseName`. Called by `resetPet`.
 */
export function bumpPetGeneration(databaseName = activeDatabaseName()): number {
  const next = getPetGeneration(databaseName) + 1
  petGenerations.set(databaseName, next)
  const nextConv = getPetConversationGeneration(databaseName) + 1
  conversationGenerations.set(databaseName, nextConv)
  notify(conversationClearedListeners, databaseName)
  notify(petResetListeners, databaseName)
  return next
}

/** Subscribe to `resetPet` transitions (e.g. `PetMount` seeding a fresh egg). */
export function onPetReset(listener: ScopeListener): () => void {
  petResetListeners.add(listener)
  return () => {
    petResetListeners.delete(listener)
  }
}

/** Subscribe to pet conversation clear/reset transitions. */
export function onPetConversationCleared(listener: ScopeListener): () => void {
  conversationClearedListeners.add(listener)
  return () => {
    conversationClearedListeners.delete(listener)
  }
}

/** Re-exported convenience for listeners that also scrub on account switch/lock. */
export { onActiveDatabaseChange }

/** Test helper: reset generation maps (listeners stay attached). */
export function __resetPetScopeForTesting(): void {
  petGenerations.clear()
  conversationGenerations.clear()
}
