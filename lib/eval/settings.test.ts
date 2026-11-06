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
import evalModule from "./module"
import { evalSettingsView } from "./settings"

const save = () => useSettingsStore.getState().save as jest.Mock

describe("eval settings", () => {
  it("views exactly the keys the eval manifest claims", () => {
    expect(evalSettingsView.keys).toBe(evalModule.settings.keys)
  })

  it("saves its own key and refuses any other", async () => {
    await evalSettingsView.update({ evalSettings: {} as never })
    expect(save()).toHaveBeenCalledWith({ evalSettings: {} })
    await expect(evalSettingsView.update({ theme: "dark" } as never)).rejects.toThrow("theme")
    expect(save()).toHaveBeenCalledTimes(1)
  })
})
