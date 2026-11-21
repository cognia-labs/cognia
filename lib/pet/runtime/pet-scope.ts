// Module-level re-export of the foundation pet scope fences (`lib/db/pet-scope.ts`),
// also bridging reset-completed notifications onto the zero-import `console-request`
// signal so `PetMount` can re-seed fresh eggs without pulling Dexie at module load.

import {
  notifyPetResetCompleted as notifyConsoleResetCompleted,
  onPetResetCompleted as onConsoleResetCompleted,
} from "@/lib/pet/console-request"
import {
  __resetPetScopeForTesting,
  assertPetConversationScopeCurrent,
  assertPetScopeCurrent,
  bumpPetConversationGeneration,
  bumpPetGeneration,
  capturePetScope,
  enqueuePetWork,
  getPetConversationGeneration,
  getPetGeneration,
  isPetConversationScopeCurrent,
  isPetDatabaseCurrent,
  isPetScopeCurrent,
  notifyPetResetCompleted as notifyDbResetCompleted,
  onActiveDatabaseChange,
  onPetConversationCleared,
  onPetReset,
  onPetResetCompleted as onDbPetResetCompleted,
  PetScopeInvalidatedError,
  whenPetEventsSettled,
  type PetScopeToken,
} from "@/lib/db/pet-scope"

// Bridge DB-layer reset completions to the zero-import `PetMount` signal.
onDbPetResetCompleted((databaseName) => {
  notifyConsoleResetCompleted(databaseName)
})

export function notifyPetResetCompleted(databaseName?: string): void {
  notifyDbResetCompleted(databaseName)
}

export function onPetResetCompleted(listener: (databaseName: string) => void): () => void {
  return onConsoleResetCompleted(listener)
}

export {
  __resetPetScopeForTesting,
  assertPetConversationScopeCurrent,
  assertPetScopeCurrent,
  bumpPetConversationGeneration,
  bumpPetGeneration,
  capturePetScope,
  enqueuePetWork,
  getPetConversationGeneration,
  getPetGeneration,
  isPetConversationScopeCurrent,
  isPetDatabaseCurrent,
  isPetScopeCurrent,
  onActiveDatabaseChange,
  onPetConversationCleared,
  onPetReset,
  PetScopeInvalidatedError,
  whenPetEventsSettled,
  type PetScopeToken,
}
