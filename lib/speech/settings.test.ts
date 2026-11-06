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
import speechModule from "./module"
import {
  setTtsAutoPlay,
  setTtsEnabled,
  setTtsPitch,
  setTtsProvider,
  setTtsRate,
  setTtsVolume,
  speechSettingsView,
} from "./settings"

const save = () => useSettingsStore.getState().save as jest.Mock

beforeEach(() => save().mockClear())

describe("speech settings", () => {
  it("views exactly the keys the speech manifest claims", () => {
    expect(speechSettingsView.keys).toBe(speechModule.settings.keys)
  })

  it("refuses to write a key speech does not own", async () => {
    await expect(speechSettingsView.update({ theme: "dark" } as never)).rejects.toThrow("theme")
    expect(save()).not.toHaveBeenCalled()
  })

  it.each([
    ["setTtsEnabled", () => setTtsEnabled(true), { ttsEnabled: true }],
    ["setTtsProvider", () => setTtsProvider("openai"), { ttsProvider: "openai" }],
    ["setTtsAutoPlay", () => setTtsAutoPlay(true), { ttsAutoPlay: true }],
  ])("%s saves its value as given", async (_name, call, patch) => {
    await call()
    expect(save()).toHaveBeenCalledWith(patch)
  })

  it("clamps the rate to [0.1, 10]", async () => {
    await setTtsRate(20)
    expect(save()).toHaveBeenLastCalledWith({ ttsRate: 10 })
    await setTtsRate(-5)
    expect(save()).toHaveBeenLastCalledWith({ ttsRate: 0.1 })
    await setTtsRate(1.5)
    expect(save()).toHaveBeenLastCalledWith({ ttsRate: 1.5 })
  })

  it("clamps the pitch to [0, 2] and the volume to [0, 1]", async () => {
    await setTtsPitch(5)
    expect(save()).toHaveBeenLastCalledWith({ ttsPitch: 2 })
    await setTtsPitch(-1)
    expect(save()).toHaveBeenLastCalledWith({ ttsPitch: 0 })
    await setTtsVolume(2)
    expect(save()).toHaveBeenLastCalledWith({ ttsVolume: 1 })
    await setTtsVolume(-3)
    expect(save()).toHaveBeenLastCalledWith({ ttsVolume: 0 })
  })
})
