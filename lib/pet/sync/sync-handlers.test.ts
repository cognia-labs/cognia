jest.mock("./pet-sync", () => {
  const fn = (name: string) => Object.assign(jest.fn(), { marker: name })
  return {
    readPetAchievementsDelta: fn("readPetAchievementsDelta"),
    readPetActivityLogDelta: fn("readPetActivityLogDelta"),
    readPetCharacterBindingsDelta: fn("readPetCharacterBindingsDelta"),
    readPetInventoryDelta: fn("readPetInventoryDelta"),
    readPetProfileDelta: fn("readPetProfileDelta"),
    syncPetAchievements: fn("syncPetAchievements"),
    syncPetActivityLog: fn("syncPetActivityLog"),
    syncPetCharacterBindings: fn("syncPetCharacterBindings"),
    syncPetInventory: fn("syncPetInventory"),
    syncPetProfile: fn("syncPetProfile"),
  }
})

import * as petSync from "./pet-sync"
import { syncHandlers } from "./sync-handlers"

describe("pet sync handlers", () => {
  it("pairs each mirrored table's pull with the reader that projects its rows", () => {
    expect(syncHandlers).toEqual({
      petProfile: { pull: petSync.syncPetProfile, serve: petSync.readPetProfileDelta },
      petAchievements: {
        pull: petSync.syncPetAchievements,
        serve: petSync.readPetAchievementsDelta,
      },
      petInventory: { pull: petSync.syncPetInventory, serve: petSync.readPetInventoryDelta },
      petCharacterBindings: {
        pull: petSync.syncPetCharacterBindings,
        serve: petSync.readPetCharacterBindingsDelta,
      },
      petActivityLog: {
        pull: petSync.syncPetActivityLog,
        serve: petSync.readPetActivityLogDelta,
      },
    })
  })
})
