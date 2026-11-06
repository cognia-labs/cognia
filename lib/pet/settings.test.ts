jest.mock("@/stores/settings/settings-store", () => {
  const { create } = jest.requireActual<typeof import("zustand")>("zustand")
  return {
    useSettingsStore: create(() => ({
      settings: { id: "singleton" },
      loaded: true,
      save: jest.fn(async () => {}),
    })),
  }
})

import { useSettingsStore } from "@/stores/settings/settings-store"
import petModule from "./module"
import { petSettingsView } from "./settings"

const save = () => useSettingsStore.getState().save as jest.Mock

describe("pet settings", () => {
  it("views exactly the keys the pet manifest claims", () => {
    expect(petSettingsView.keys).toBe(petModule.settings.keys)
  })

  it("saves its own key and refuses any other", async () => {
    await petSettingsView.update({ petSettings: {} as never })
    expect(save()).toHaveBeenCalledWith({ petSettings: {} })
    await expect(petSettingsView.update({ theme: "dark" } as never)).rejects.toThrow("theme")
    expect(save()).toHaveBeenCalledTimes(1)
  })
})
