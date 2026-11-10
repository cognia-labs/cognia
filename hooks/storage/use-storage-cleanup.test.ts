import "fake-indexeddb/auto"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useStorageCleanup } from "./use-storage-cleanup"
import { appendBackupHistory } from "@/lib/db/backup-history"
import {
  activateAccountDatabase,
  clearAccountDatabaseSelection,
  getDb,
  whenSeeded,
  __resetDbForTesting,
} from "@/lib/db/schema"
import { RuntimeTargetRegistry } from "@/lib/runtime/target-registry"
import { isCapacitor } from "@/lib/platform/detect"
import { saveSettings } from "@/lib/db/settings"
import { AccountContentCipher, activateAccountContentCipher } from "@/lib/accounts/content-cipher"
import * as storage from "@/lib/storage"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

// Wrap cleanupCategories so individual tests can override timing (the
// "isRunning" lifecycle test needs a deterministic gate). Other tests fall
// through to the real implementation via the default mock factory below.
jest.mock("@/lib/storage", () => {
  const actual = jest.requireActual("@/lib/storage")
  return {
    ...actual,
    cleanupCategories: jest.fn((...args: unknown[]) => actual.cleanupCategories(...args)),
    getCleanupTargetKey: jest.fn(actual.getCleanupTargetKey),
  }
})
jest.mock("@/lib/db/schema", () => {
  const actual = jest.requireActual("@/lib/db/schema")
  return { ...actual, getDb: jest.fn(actual.getDb) }
})
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isCapacitor: jest.fn(() => false),
}))

function TargetProbe() {
  return createElement("span", null, useStorageCleanup().targetKey)
}

beforeEach(async () => {
  jest.mocked(isCapacitor).mockReturnValue(false)
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useStorageCleanup", () => {
  it("hydrates mobile base ownership from persisted mode and invalidates it when that mode changes", async () => {
    jest.mocked(isCapacitor).mockReturnValue(true)
    const accountId = "storage-mobile-hydration"
    activateAccountDatabase(accountId)
    setActiveRuntimeTargetContext(accountId, "mobile-companion")
    const db = getDb()
    activateAccountContentCipher(await AccountContentCipher.createForTesting(accountId, db.name))
    await saveSettings({ mobileRuntimeMode: "standalone" }, { mirrorToHost: false })
    const { result, unmount } = renderHook(() => useStorageCleanup())
    try {
      await waitFor(() =>
        expect(storage.getCleanupCategoryAvailability("session", ["sessions"])).toBe("cleanable")
      )
      const standaloneTarget = result.current.targetKey
      await db.backupHistory.put({ id: "mode-preview", completedAt: 1 } as never)
      await act(async () => {
        await saveSettings({ mobileRuntimeMode: "paired" }, { mirrorToHost: false })
      })
      await waitFor(() => expect(result.current.targetKey).not.toBe(standaloneTarget))
      expect(storage.getCleanupCategoryAvailability("session", ["sessions"])).toBe("host-managed")
      const response = await storage.cleanupCategories({
        categories: ["backupHistory"],
        targetKey: standaloneTarget,
      })
      expect(response.errors).toEqual([expect.stringContaining("target changed")])
      expect(await db.backupHistory.get("mode-preview")).toBeDefined()
    } finally {
      unmount()
      await db.delete()
      clearAccountDatabaseSelection()
      clearActiveRuntimeTargetContext()
    }
  })

  it.each([true, false])(
    "invalidates changed persisted ownership with subscriber mounted: %s",
    async (subscribed) => {
      const registry = new RuntimeTargetRegistry()
      const accountId = "storage-hydration"
      const id = "host-hydration"
      await registry.addTarget({ accountId, id, kind: "standalone", label: "Local", now: 1 })
      await registry.activateTarget(accountId, id, 2)
      activateAccountDatabase(accountId, id)
      setActiveRuntimeTargetContext(accountId, id)
      const { result, unmount } = renderHook(() => useStorageCleanup())
      try {
        await waitFor(() =>
          expect(storage.getCleanupCategoryAvailability("skill", ["skills"])).toBe("cleanable")
        )
        const previewTarget = result.current.targetKey
        await getDb().backupHistory.put({ id: "stale-owner-history", completedAt: 1 } as never)
        if (!subscribed) unmount()
        await act(async () => {
          await registry.upsertCompanionTarget({
            accountId,
            id,
            label: "Mirror",
            hostKind: "desktop",
            baseUrl: "https://host.example",
            deviceId: "device",
            serverVersion: "1",
            credentialRef: "unavailable",
            now: 3,
          })
        })
        if (subscribed) {
          await waitFor(() => expect(result.current.targetKey).not.toBe(previewTarget))
          expect(storage.getCleanupCategoryAvailability("skill", ["skills"])).toBe("host-managed")
        } else {
          // The stale cached key still matches; only the fresh persisted read
          // inside cleanup can refuse this confirmation.
          expect(storage.getCleanupTargetKey()).toBe(previewTarget)
        }
        const response = await storage.cleanupCategories({
          categories: ["backupHistory"],
          targetKey: previewTarget,
        })
        expect(response.errors).toEqual([expect.stringContaining("target changed")])
        expect(await getDb().backupHistory.get("stale-owner-history")).toBeDefined()
      } finally {
        unmount()
        await getDb().delete()
        clearAccountDatabaseSelection()
        clearActiveRuntimeTargetContext()
        await registry.deleteAccountTargets(accountId)
        registry.close()
      }
    }
  )
  it("uses a constant empty server snapshot without reading the DB or client snapshot", () => {
    const actualGetDb = jest.requireActual("@/lib/db/schema").getDb
    jest
      .mocked(getDb)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("getDb() called on the server")
      })
    jest.mocked(storage.getCleanupTargetKey).mockClear()
    try {
      expect(renderToString(createElement(TargetProbe))).toBe("<span></span>")
      setActiveRuntimeTargetContext("storage-test", "target-server")
      expect(renderToString(createElement(TargetProbe))).toBe("<span></span>")
      expect(getDb).not.toHaveBeenCalled()
      expect(storage.getCleanupTargetKey).not.toHaveBeenCalled()
    } finally {
      clearActiveRuntimeTargetContext()
      jest.mocked(getDb).mockImplementation(actualGetDb)
    }
  })

  it("reads the client render snapshot without opening a database", () => {
    const actualGetDb = jest.requireActual("@/lib/db/schema").getDb
    jest
      .mocked(getDb)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("render must not open Dexie")
      })
    try {
      const { result, unmount } = renderHook(() => useStorageCleanup())
      expect(result.current.targetKey).not.toBe("")
      expect(getDb).not.toHaveBeenCalled()
      unmount()
    } finally {
      jest.mocked(getDb).mockImplementation(actualGetDb)
    }
  })
  it("updates the confirmation binding when the runtime routing generation changes", () => {
    const { result, unmount } = renderHook(() => useStorageCleanup())
    const original = result.current.targetKey
    try {
      act(() => setActiveRuntimeTargetContext("storage-test", "target-one"))
      const first = result.current.targetKey
      expect(first).not.toBe(original)
      act(() => setActiveRuntimeTargetContext("storage-test", "target-two"))
      expect(result.current.targetKey).not.toBe(first)
      act(() => setActiveRuntimeTargetContext("storage-test", "target-one"))
      expect(result.current.targetKey).not.toBe(first)
    } finally {
      unmount()
      clearActiveRuntimeTargetContext()
    }
  })
  it("toggles isRunning around cleanup operations", async () => {
    // Gate the underlying cleanup so isRunning is deterministically observable
    // mid-flight. Without this, cleanupCategories resolves so quickly that
    // setIsRunning(false) can fire before the test re-reads `result.current`.
    let release: (() => void) | null = null
    const gate = new Promise<void>((res) => {
      release = res as () => void
    })
    const cleanupMock = storage.cleanupCategories as jest.Mock
    cleanupMock.mockImplementationOnce(async () => {
      await gate
      return { freedSpace: 0, deletedItems: 0, details: [], errors: [] }
    })

    const { result } = renderHook(() => useStorageCleanup())
    expect(result.current.isRunning).toBe(false)

    let pending: Promise<unknown> | null = null
    await act(async () => {
      pending = result.current.cleanup({ categories: ["backupHistory"] })
    })
    await waitFor(() => expect(result.current.isRunning).toBe(true))
    ;(release as (() => void) | null)?.()
    await act(async () => {
      await pending
    })
    expect(result.current.isRunning).toBe(false)
  })

  it("preview reports counts without writing", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })

    const { result } = renderHook(() => useStorageCleanup())
    let preview: Awaited<ReturnType<typeof result.current.preview>> | null = null
    await act(async () => {
      preview = await result.current.preview({ categories: ["backupHistory"] })
    })
    expect(preview!.deletedItems).toBe(1)
    expect(await getDb().backupHistory.count()).toBe(1)
  })

  it("clearCategory returns the deleted count", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: 2,
      type: "manual",
      success: true,
      encryption: "none",
    })

    const { result } = renderHook(() => useStorageCleanup())
    let n = 0
    await act(async () => {
      n = await result.current.clearCategory("backupHistory")
    })
    expect(n).toBe(2)
  })

  it("quick + deep cleanups complete without error", async () => {
    const { result } = renderHook(() => useStorageCleanup())
    await act(async () => {
      const q = await result.current.quick()
      const d = await result.current.deep()
      expect(q.errors).toEqual([])
      expect(d.errors).toEqual([])
    })
  })
})
