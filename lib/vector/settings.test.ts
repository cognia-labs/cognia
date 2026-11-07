jest.mock("@/stores/settings/settings-store", () => {
  const { create } = jest.requireActual<typeof import("zustand")>("zustand")
  return {
    useSettingsStore: create(() => ({
      settings: { id: "singleton", providerSettings: { openai: { apiKey: "k" } } },
      loaded: true,
      save: jest.fn(async () => {}),
    })),
  }
})

import vectorModule from "./module"
import { vectorSettingsView } from "./settings"

describe("vector settings", () => {
  it("views exactly the keys the vector manifest claims, which are none", () => {
    expect(vectorSettingsView.keys).toBe(vectorModule.settings.keys)
    expect(vectorSettingsView.keys).toEqual([])
  })

  it("reads the kernel's provider settings and writes nothing", async () => {
    expect(vectorSettingsView.get()?.providerSettings).toEqual({ openai: { apiKey: "k" } })
    await expect(vectorSettingsView.update({ theme: "dark" } as never)).rejects.toThrow("theme")
  })
})
