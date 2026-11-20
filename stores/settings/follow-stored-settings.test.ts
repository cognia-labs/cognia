/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { waitFor } from "@testing-library/react"

import { CogniaDB, __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { DEFAULTS } from "@/lib/db/settings"

import { followStoredSettings } from "./follow-stored-settings"
import { useSettingsStore } from "./settings-store"

let stop: (() => void) | null = null

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().settings.put({ ...DEFAULTS, theme: "dark", accentColor: "#0077ff", updatedAt: 1 })
  useSettingsStore.setState({ settings: null, loaded: false, loadFailed: false })
  await useSettingsStore.getState().load()
})

afterEach(() => {
  stop?.()
  stop = null
})

/** A write that is not the store's own, as the account sync applier makes. */
async function writeBehindTheStore(db: CogniaDB, patch: Record<string, unknown>) {
  await db.transaction("rw", db.settings, async () => {
    const row = await db.settings.get("singleton")
    await db.settings.put({ ...row!, ...patch, updatedAt: Date.now() + 10 })
  })
}

describe("followStoredSettings", () => {
  it("reads the row back into a loaded store after another writer changed it", async () => {
    // A Companion pull wrote the row while the store, already loaded, kept the
    // values it read at boot, and a plain `load()` returns early once loaded.
    stop = followStoredSettings()
    expect(useSettingsStore.getState().settings?.theme).toBe("dark")
    await writeBehindTheStore(getDb(), { theme: "light", accentColor: "#aa2277" })
    await waitFor(() => expect(useSettingsStore.getState().settings?.theme).toBe("light"))
    // The derived appearance fields move with it.
    expect(useSettingsStore.getState().accentColor).toBe("#aa2277")
  })

  it("leaves the store alone once it already holds the stored row", async () => {
    const refresh = jest.spyOn(useSettingsStore.getState(), "refreshFromDatabase")
    stop = followStoredSettings()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(refresh).not.toHaveBeenCalled()
    refresh.mockRestore()
  })

  it("never applies a database that is not the active one", async () => {
    // A late answer from a database the window just switched away from must
    // not replace the current one's settings.
    const other = new CogniaDB(`follow-other-${Date.now()}`, "follow-test")
    await other.open()
    await other.settings.put({ ...DEFAULTS, theme: "light", updatedAt: 99 })
    stop = followStoredSettings({ activeDb: () => other, subscribeScope: () => () => {} })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useSettingsStore.getState().settings?.theme).toBe("dark")
    other.close()
  })

  it("moves to the database that is active after a scope change", async () => {
    let active: CogniaDB = new CogniaDB(`follow-old-${Date.now()}`, "follow-test")
    let notify: () => void = () => {}
    stop = followStoredSettings({
      activeDb: () => active,
      subscribeScope: (listener) => {
        notify = listener
        return () => {}
      },
    })
    // The real active database becomes current again: the watch follows it.
    active = getDb()
    notify()
    await writeBehindTheStore(getDb(), { fontScale: "lg" })
    await waitFor(() => expect(useSettingsStore.getState().settings?.fontScale).toBe("lg"))
  })

  it("stops following when disposed", async () => {
    stop = followStoredSettings()
    stop()
    stop = null
    await writeBehindTheStore(getDb(), { theme: "light" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useSettingsStore.getState().settings?.theme).toBe("dark")
  })
})

describe("useSettingsStore.setState", () => {
  it("keeps the derived appearance fields in step with nested settings", () => {
    // `useSettingsStore.setState({ settings })` from outside the store used to
    // skip the projection, so `accentColor` stayed stale while
    // `settings.accentColor` changed.
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings!, accentColor: "#123456" },
    })
    expect(useSettingsStore.getState().accentColor).toBe("#123456")
  })
})
