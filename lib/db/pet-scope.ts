// Foundation-layer account-partition and lifecycle generation fences for the
// pet subsystem. Lives under `lib/db/` so `lib/db/pet.ts` and
// `lib/db/pet-conversation.ts` never import upward into the `pet` module, while
// `lib/pet/runtime/pet-scope.ts` re-exports this single source of truth.

import { activeDatabaseEpoch, activeDatabaseName, onActiveDatabaseChange } from "./schema"

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
const petResetCompletedListeners = new Set<ScopeListener>()
const conversationClearedListeners = new Set<ScopeListener>()

let workChain: Promise<void> = Promise.resolve()

/**
 * Serialize all pet profile/economy/lifecycle writes through one promise chain.
 */
export function enqueuePetWork<T>(fn: () => Promise<T>): Promise<T> {
  const result = workChain.then(() => fn())
  workChain = result.then(
    () => {},
    () => {}
  )
  return result
}

/** Drain the serialization chain, including any re-entrant lifecycle events queued during settlement. */
export async function whenPetEventsSettled(): Promise<void> {
  let settled: Promise<void> | null = null
  while (settled !== workChain) {
    settled = workChain
    await settled
  }
}

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

export function bumpPetConversationGeneration(databaseName = activeDatabaseName()): number {
  const next = getPetConversationGeneration(databaseName) + 1
  conversationGenerations.set(databaseName, next)
  notify(conversationClearedListeners, databaseName)
  return next
}

export function bumpPetGeneration(databaseName = activeDatabaseName()): number {
  const next = getPetGeneration(databaseName) + 1
  petGenerations.set(databaseName, next)
  const nextConv = getPetConversationGeneration(databaseName) + 1
  conversationGenerations.set(databaseName, nextConv)
  notify(conversationClearedListeners, databaseName)
  notify(petResetListeners, databaseName)
  return next
}

export function onPetReset(listener: ScopeListener): () => void {
  petResetListeners.add(listener)
  return () => {
    petResetListeners.delete(listener)
  }
}

export function notifyPetResetCompleted(databaseName = activeDatabaseName()): void {
  notify(petResetCompletedListeners, databaseName)
}

export function onPetResetCompleted(listener: ScopeListener): () => void {
  petResetCompletedListeners.add(listener)
  return () => {
    petResetCompletedListeners.delete(listener)
  }
}

export function onPetConversationCleared(listener: ScopeListener): () => void {
  conversationClearedListeners.add(listener)
  return () => {
    conversationClearedListeners.delete(listener)
  }
}

export { onActiveDatabaseChange }

export function __resetPetScopeForTesting(): void {
  petGenerations.clear()
  conversationGenerations.clear()
}
