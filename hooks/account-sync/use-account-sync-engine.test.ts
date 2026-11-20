/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import type {
  AccountSyncEngine,
  AccountSyncEngineDeps,
  EngineStatus,
} from "@/lib/account-sync/data/engine"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import type { CogniaDB } from "@/lib/db/schema"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { useAccountSyncEngine } from "./use-account-sync-engine"
import { subscribeRemoteChanges } from "@/lib/account-sync/data/remote-changes"

const context = { session: { localAccountId: "acct_1" } } as unknown as AccountSyncContext
const db = { name: "own-db" } as CogniaDB
const enrolled = (deviceId: string) =>
  ({ kind: "enrolled", device: { deviceId }, registry: {} }) as never

function harness(initialDb: CogniaDB | null = db) {
  let current = initialDb
  let notify: (() => void) | null = null
  const started: AccountSyncEngineDeps[] = []
  const engines: (AccountSyncEngine & { stop: jest.Mock })[] = []
  const start = jest.fn((deps: AccountSyncEngineDeps) => {
    started.push(deps)
    const engine = { stop: jest.fn() } as unknown as AccountSyncEngine & { stop: jest.Mock }
    engines.push(engine)
    return engine
  })
  const options = {
    enabled: true,
    start,
    ownDatabase: jest.fn(() => current),
    subscribeAuthority: (listener: () => void) => {
      notify = listener
      return () => {
        notify = null
      }
    },
    locks: null,
    openSocket: null,
  }
  return {
    options,
    start,
    started,
    engines,
    switchDatabase(next: CogniaDB | null) {
      current = next
      act(() => notify?.())
    },
  }
}

function signIn(view: unknown = enrolled("dev_1")) {
  act(() => {
    useAccountSyncStore.getState().applyPoll({ view: view as never, incoming: [] }, context, 1)
  })
}

beforeEach(() => useAccountSyncStore.getState().reset())

describe("useAccountSyncEngine", () => {
  it("resolves, arms and contacts nothing when disabled", () => {
    const h = harness()
    signIn()
    renderHook(() => useAccountSyncEngine({ ...h.options, enabled: false }))
    expect(h.options.ownDatabase).not.toHaveBeenCalled()
    expect(h.start).not.toHaveBeenCalled()
  })

  it("starts on the profile's own database once enrolled, and stops on unmount", () => {
    const h = harness()
    const { unmount } = renderHook(() => useAccountSyncEngine(h.options))
    expect(h.start).not.toHaveBeenCalled()
    signIn()
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.started[0]).toMatchObject({ context, db, device: { deviceId: "dev_1" }, locks: null })
    expect(useAccountSyncStore.getState().engine).toBe(h.engines[0])
    unmount()
    expect(h.engines[0]!.stop).toHaveBeenCalled()
    expect(useAccountSyncStore.getState().engine).toBeNull()
  })

  it("follows the database: none on a mirror, a new engine on the own one", () => {
    const h = harness(null)
    renderHook(() => useAccountSyncEngine(h.options))
    signIn()
    expect(h.start).not.toHaveBeenCalled()
    h.switchDatabase(db)
    expect(h.start).toHaveBeenCalledTimes(1)
    h.switchDatabase(null)
    expect(h.engines[0]!.stop).toHaveBeenCalled()
    expect(useAccountSyncStore.getState().engine).toBeNull()
  })

  it("keeps one engine across polls of the same device, and restarts for another", () => {
    const h = harness()
    renderHook(() => useAccountSyncEngine(h.options))
    signIn()
    signIn()
    expect(h.start).toHaveBeenCalledTimes(1)
    signIn(enrolled("dev_2"))
    expect(h.engines[0]!.stop).toHaveBeenCalled()
    expect(h.started[1]!.device.deviceId).toBe("dev_2")
  })

  it("passes status, applied tables and list changes on", () => {
    const h = harness()
    renderHook(() => useAccountSyncEngine(h.options))
    signIn()
    const deps = h.started[0]!
    const removed: EngineStatus = { kind: "removed", removal: { at: 1, seq: 2, by: "dev_x" } }
    act(() => deps.onStatus?.(removed))
    expect(useAccountSyncStore.getState().engineStatus).toEqual(removed)
    expect(useAccountSyncStore.getState().refreshNonce).toBe(1)

    const heard: string[][] = []
    const stop = subscribeRemoteChanges((tables) => heard.push([...tables]))
    act(() => deps.onApplied?.(new Set(["sessions"])))
    act(() => deps.onApplied?.(new Set(["settings"])))
    stop()
    expect(heard).toEqual([["sessions"], ["settings"]])

    act(() => deps.onRegistryChanged?.())
    expect(useAccountSyncStore.getState().refreshNonce).toBe(2)
  })

  it("starts over when the database it runs on was replaced", () => {
    const h = harness()
    renderHook(() => useAccountSyncEngine(h.options))
    signIn()
    const replacement = { name: "own-db" } as CogniaDB
    h.options.ownDatabase.mockImplementation(() => replacement)
    act(() =>
      h.started[0]!.onStatus?.({
        kind: "running",
        live: "poll",
        pending: 0,
        parked: { schema: 0, key: 0 },
        lastSyncedAt: null,
        tooLarge: [],
        error: "DatabaseClosedError",
        classes: { content: true, settings: true },
      })
    )
    expect(h.engines[0]!.stop).toHaveBeenCalled()
    expect(h.started[1]!.db).toBe(replacement)
  })
})
