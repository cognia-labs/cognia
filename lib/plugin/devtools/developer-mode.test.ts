/** @jest-environment jsdom */

jest.mock("@/stores/plugin-runtime/plugin-store", () => {
  const state = {
    pluginSettings: { developerModeEnabled: false },
    updatePluginSettings: jest.fn((updates: Record<string, unknown>) => {
      Object.assign(state.pluginSettings, updates)
    }),
  }
  return { usePluginStore: { getState: () => state } }
})

import {
  applyBootDeveloperMode,
  isDeveloperModeEnabled,
  setDeveloperModeEnabled,
} from "./developer-mode"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

type MockedStore = {
  pluginSettings: { developerModeEnabled: boolean }
  updatePluginSettings: jest.Mock
}

function store(): MockedStore {
  return usePluginStore.getState() as unknown as MockedStore
}

beforeEach(() => {
  store().pluginSettings.developerModeEnabled = false
  store().updatePluginSettings.mockClear()
})

describe("store accessors", () => {
  it("reads the persisted flag", () => {
    expect(isDeveloperModeEnabled()).toBe(false)
    store().pluginSettings.developerModeEnabled = true
    expect(isDeveloperModeEnabled()).toBe(true)
  })

  it("writes through the existing settings action", () => {
    setDeveloperModeEnabled(true)
    expect(store().updatePluginSettings).toHaveBeenCalledWith({ developerModeEnabled: true })
    expect(isDeveloperModeEnabled()).toBe(true)
  })
})

describe("applyBootDeveloperMode", () => {
  it("writes nothing on a production build", () => {
    expect(applyBootDeveloperMode({ developmentBuild: false })).toBe(false)
    expect(store().updatePluginSettings).not.toHaveBeenCalled()
  })

  it("enables on a development build exactly once", () => {
    expect(applyBootDeveloperMode({ developmentBuild: true })).toBe(true)
    expect(isDeveloperModeEnabled()).toBe(true)
    expect(store().updatePluginSettings).toHaveBeenCalledTimes(1)

    // Idempotent: a second boot writes nothing.
    expect(applyBootDeveloperMode({ developmentBuild: true })).toBe(true)
    expect(store().updatePluginSettings).toHaveBeenCalledTimes(1)
  })

  it("never turns a stored yes back off", () => {
    store().pluginSettings.developerModeEnabled = true
    expect(applyBootDeveloperMode({ developmentBuild: false })).toBe(true)
    expect(store().updatePluginSettings).not.toHaveBeenCalled()
  })

  it("falls back to NODE_ENV when the caller says nothing", () => {
    const previous = process.env.NODE_ENV
    Object.defineProperty(process.env, "NODE_ENV", { value: "development", configurable: true })
    expect(applyBootDeveloperMode()).toBe(true)
    Object.defineProperty(process.env, "NODE_ENV", { value: previous, configurable: true })
  })
})
