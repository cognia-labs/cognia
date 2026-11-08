/**
 * What the pet contributes to companion sync (ADR-0250 §14 `syncHandlers`):
 * the five mirrored tables, each with its pull and, because every row crosses
 * as the pet's own projection, its host-side reader (`./pet-sync.ts`).
 */

import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"
import {
  readPetAchievementsDelta,
  readPetActivityLogDelta,
  readPetCharacterBindingsDelta,
  readPetInventoryDelta,
  readPetProfileDelta,
  syncPetAchievements,
  syncPetActivityLog,
  syncPetCharacterBindings,
  syncPetInventory,
  syncPetProfile,
} from "./pet-sync"

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  petProfile: { pull: syncPetProfile, serve: readPetProfileDelta },
  petAchievements: { pull: syncPetAchievements, serve: readPetAchievementsDelta },
  petInventory: { pull: syncPetInventory, serve: readPetInventoryDelta },
  petCharacterBindings: { pull: syncPetCharacterBindings, serve: readPetCharacterBindingsDelta },
  petActivityLog: { pull: syncPetActivityLog, serve: readPetActivityLogDelta },
}
