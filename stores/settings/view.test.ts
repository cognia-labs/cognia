/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

jest.mock("./settings-store", () => {
  const { create } = jest.requireActual<typeof import("zustand")>("zustand")
  const store = create<{
    settings: AppSettings | null
    loaded: boolean
    save: (patch: Partial<AppSettings>) => Promise<void>
  }>(() => ({ settings: null, loaded: false, save: async () => {} }))
  return { useSettingsStore: store }
})

import { useSettingsStore } from "./settings-store"
import { defineSettingsView } from "./view"

const settings = (extra: Partial<AppSettings> = {}) =>
  ({ id: "singleton", ttsRate: 1, ttsEnabled: false, theme: "dark", ...extra }) as AppSettings

const view = defineSettingsView(["ttsRate", "ttsEnabled"])

beforeEach(() => {
  useSettingsStore.setState({ settings: settings(), loaded: true, save: jest.fn(async () => {}) })
})

describe("defineSettingsView", () => {
  it("keeps the keys it was defined with", () => {
    expect(view.keys).toEqual(["ttsRate", "ttsEnabled"])
  })

  it("reads the whole settings object, including keys it does not own", () => {
    expect(view.get()).toBe(useSettingsStore.getState().settings)
    expect(view.get()?.theme).toBe("dark")
    expect(view.isLoaded()).toBe(true)
    useSettingsStore.setState({ settings: null, loaded: false })
    expect(view.get()).toBeNull()
    expect(view.isLoaded()).toBe(false)
  })

  it("re-renders a selector when the selected value changes", () => {
    const { result } = renderHook(() => view.use((s) => s?.ttsRate))
    expect(result.current).toBe(1)
    act(() => useSettingsStore.setState({ settings: settings({ ttsRate: 2 }) }))
    expect(result.current).toBe(2)
  })

  it("saves a patch of its own keys through the store", async () => {
    await view.update({ ttsRate: 1.5 })
    expect(useSettingsStore.getState().save).toHaveBeenCalledWith({ ttsRate: 1.5 })
  })

  it("refuses to write a key it does not own, before saving anything", async () => {
    await expect(view.update({ theme: "light" } as never)).rejects.toThrow(
      'settings key "theme" is not one of this view\'s own keys'
    )
    expect(() => view.applyLocal({ theme: "light" } as never)).toThrow("theme")
    expect(useSettingsStore.getState().save).not.toHaveBeenCalled()
    expect(view.get()?.theme).toBe("dark")
  })

  it("applies another window's value locally, and leaves the state alone when nothing changes", () => {
    const before = useSettingsStore.getState().settings
    view.applyLocal({ ttsRate: 1 })
    expect(useSettingsStore.getState().settings).toBe(before)
    view.applyLocal({ ttsRate: 3 })
    expect(useSettingsStore.getState().settings).toMatchObject({ ttsRate: 3, theme: "dark" })
    expect(useSettingsStore.getState().save).not.toHaveBeenCalled()
  })

  it("does nothing locally before the settings load", () => {
    useSettingsStore.setState({ settings: null })
    view.applyLocal({ ttsRate: 3 })
    expect(view.get()).toBeNull()
  })

  it("hears changes of the settings object only", () => {
    const listener = jest.fn()
    const stop = view.subscribe(listener)
    useSettingsStore.setState({ loaded: false })
    expect(listener).not.toHaveBeenCalled()
    const previous = useSettingsStore.getState().settings
    const next = settings({ ttsEnabled: true })
    useSettingsStore.setState({ settings: next })
    expect(listener).toHaveBeenCalledWith(next, previous)
    stop()
    useSettingsStore.setState({ settings: settings() })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
