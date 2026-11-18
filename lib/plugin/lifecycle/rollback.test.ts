/**
 * Tests for Plugin Rollback Manager
 */

import {
  PluginRollbackManager,
  getPluginRollbackManager,
  resetPluginRollbackManager,
} from "./rollback"
import { PluginServiceRegistry } from "../core/service-registry"
import {
  contractViolations,
  scenariosFor,
  type ReplacementObservation,
  type ReplacementScenario,
} from "./contract"
import { runtimeResumeStateOf } from "./runtime-state"
import { InMemoryPluginLifecycleStateAdapter } from "../core/lifecycle-state"

const mockInvoke = jest.fn()
const mockGetBackups = jest.fn()
const mockCreateBackup = jest.fn()
const mockRestoreToVersion = jest.fn()
const mockRestore = jest.fn()
const mockGetVersions = jest.fn()
const mockInstallPlugin = jest.fn()
const mockStoreGetState = jest.fn()
const mockStoreSetState = jest.fn()
const mockReadOrigin = jest.fn()
const mockRecordOrigin = jest.fn()
const mockManager = {
  scanPlugins: jest.fn(),
  syncRuntimeState: jest.fn(),
  disablePlugin: jest.fn(),
  unloadPlugin: jest.fn(),
  loadPlugin: jest.fn(),
  enablePlugin: jest.fn(),
  suspendPlugin: jest.fn(),
  reservePluginRuntimeGraph: jest.fn(),
  releasePluginRuntimeGraph: jest.fn(),
  hasUnresolvedActivationResources: jest.fn(),
  getPluginLifecycleState: jest.fn(),
  withPluginPackageMutation: jest.fn(),
}

jest.mock("../core/manager", () => ({ getPluginManager: () => mockManager }))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

jest.mock("./backup", () => ({
  getPluginBackupManager: () => ({
    getBackups: (...args: unknown[]) => mockGetBackups(...args),
    createBackup: (...args: unknown[]) => mockCreateBackup(...args),
    restoreToVersion: (...args: unknown[]) => mockRestoreToVersion(...args),
    restore: (...args: unknown[]) => mockRestore(...args),
    getBackup: (id: string) => mockGetBackups().find((backup: { id: string }) => backup.id === id),
    cleanupOldBackups: jest.fn(async () => 0),
    getPendingUpdateRestore: () => undefined,
  }),
}))

jest.mock("../package/marketplace", () => ({
  getPluginMarketplace: () => ({
    getVersions: (...args: unknown[]) => mockGetVersions(...args),
    installPlugin: (...args: unknown[]) => mockInstallPlugin(...args),
  }),
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: (...args: unknown[]) => mockStoreGetState(...args),
    setState: (...args: unknown[]) => mockStoreSetState(...args),
  },
}))

// What the rollback does to the plugin's data (ADR-0258).
const mockDescribeDataRollback = jest.fn()
const mockRestoreDataSnapshot = jest.fn()
jest.mock("../dexie/data-rollback", () => ({
  ...jest.requireActual("../dexie/data-rollback"),
  describePluginDataRollback: (...args: unknown[]) => mockDescribeDataRollback(...args),
}))
jest.mock("../dexie/bridge", () => ({
  restorePluginDataSnapshot: (...args: unknown[]) => mockRestoreDataSnapshot(...args),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "test-db" }) }))

jest.mock("../core/logger", () => ({
  loggers: {
    manager: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
}))

type MockStoreState = {
  plugins: Record<
    string,
    {
      manifest: { id: string; version: string }
      status: string
      config: Record<string, unknown>
    }
  >
  setPluginConfig: jest.Mock
}

describe("PluginRollbackManager", () => {
  let manager: PluginRollbackManager
  let storeState: MockStoreState

  beforeEach(() => {
    resetPluginRollbackManager()
    manager = new PluginRollbackManager(
      {},
      { readOrigin: mockReadOrigin, recordOrigin: mockRecordOrigin }
    )
    jest.clearAllMocks()
    mockReadOrigin.mockResolvedValue(undefined)
    mockRecordOrigin.mockResolvedValue(undefined)

    storeState = {
      plugins: {
        "plugin-a": {
          manifest: { id: "plugin-a", version: "2.0.0" },
          status: "enabled",
          config: {},
        },
      },
      setPluginConfig: jest.fn(),
    }

    mockStoreGetState.mockImplementation(() => storeState)
    mockStoreSetState.mockImplementation((next) => {
      if (typeof next === "function") {
        const patch = next(storeState)
        if (patch && typeof patch === "object") {
          Object.assign(storeState, patch)
        }
      } else if (next && typeof next === "object") {
        Object.assign(storeState, next)
      }
    })

    mockGetBackups.mockReturnValue([])
    mockCreateBackup.mockResolvedValue({ success: true })
    mockRestoreToVersion.mockResolvedValue({ success: true })
    mockRestore.mockReset().mockResolvedValue({ success: true, requiresRestart: false })
    mockGetVersions.mockResolvedValue([])
    mockInstallPlugin.mockResolvedValue({ success: true })
    mockInvoke.mockResolvedValue(null)
    mockDescribeDataRollback.mockReset().mockResolvedValue({ kind: "none" })
    mockRestoreDataSnapshot.mockReset().mockResolvedValue({ dataVersion: 1, rows: 2 })
    for (const mock of Object.values(mockManager)) mock.mockReset()
    mockManager.reservePluginRuntimeGraph.mockReturnValue({ pluginId: "plugin-a" })
    mockManager.hasUnresolvedActivationResources.mockReturnValue(false)
    mockManager.getPluginLifecycleState.mockResolvedValue({ actual: "inactive" })
    mockManager.withPluginPackageMutation.mockImplementation((_id, operation) => operation())
    mockManager.scanPlugins.mockImplementation(async () => {
      storeState.plugins["plugin-a"].manifest.version = "1.0.0"
    })
    for (const status of [
      "disablePlugin",
      "unloadPlugin",
      "loadPlugin",
      "enablePlugin",
      "suspendPlugin",
    ] as const) {
      mockManager[status].mockImplementation(async () => {
        storeState.plugins["plugin-a"].status = {
          disablePlugin: "disabled",
          unloadPlugin: "installed",
          loadPlugin: "loaded",
          enablePlugin: "enabled",
          suspendPlugin: "suspended",
        }[status]
      })
    }
  })

  it("B18 quiesces, restores the exact snapshot, rescans and reactivates", async () => {
    mockGetBackups.mockReturnValue([
      { id: "newer", pluginId: "plugin-a", version: "1.0.0" },
      { id: "selected", pluginId: "plugin-a", version: "1.0.0" },
    ])
    mockRestore.mockImplementation(async () => {
      expect(storeState.plugins["plugin-a"].status).toBe("installed")
      expect(mockManager.unloadPlugin).toHaveBeenCalledWith("plugin-a")
      return { success: true, requiresRestart: false }
    })
    const result = await manager.restoreBackup("selected")
    expect(result).toMatchObject({ success: true, requiresRestart: false })
    expect(mockRestore).toHaveBeenCalledWith("selected", mockManager)
    expect(mockRestoreToVersion).not.toHaveBeenCalled()
    expect(mockCreateBackup).toHaveBeenCalledWith(
      "plugin-a",
      expect.objectContaining({
        preserveBackupId: "selected",
      })
    )
    expect(mockManager.scanPlugins).toHaveBeenCalled()
    expect(storeState.plugins["plugin-a"].status).toBe("enabled")
    expect(mockManager.reservePluginRuntimeGraph).toHaveBeenCalledWith("plugin-a")
    expect(mockManager.releasePluginRuntimeGraph).toHaveBeenCalled()
  })

  describe("getRollbackInfo", () => {
    it("offers an owed host-state restore even after boot already restored the package version", async () => {
      storeState.plugins["plugin-a"].manifest.version = "1.0.0"
      mockGetBackups.mockReturnValue([
        {
          id: "owed",
          pluginId: "plugin-a",
          version: "1.0.0",
          metadata: { hostStateRestorePending: true },
        },
      ])
      expect((await manager.getRollbackInfo("plugin-a")).availableVersions[0].canRollback).toBe(
        true
      )
    })
    it("should get rollback info with backups", async () => {
      mockGetBackups.mockReturnValue([
        { pluginId: "plugin-a", version: "1.0.0", createdAt: new Date(), size: 1000 },
        { pluginId: "plugin-a", version: "1.5.0", createdAt: new Date(), size: 1200 },
      ])

      const info = await manager.getRollbackInfo("plugin-a")

      expect(info.pluginId).toBe("plugin-a")
      expect(info.currentVersion).toBe("2.0.0")
      expect(info.availableVersions.length).toBe(2)
      expect(info.hasBackups).toBe(true)
    })

    it("should indicate when no backups available", async () => {
      mockGetBackups.mockReturnValue([])
      const info = await manager.getRollbackInfo("plugin-a")
      expect(info.hasBackups).toBe(false)
      expect(info.availableVersions.length).toBe(0)
    })

    it("should fall back to unknown when plugin is not in store", async () => {
      storeState.plugins = {}
      const info = await manager.getRollbackInfo("missing-plugin")
      expect(info.currentVersion).toBe("unknown")
    })

    it("says what each version does to the data, and does not offer one that cannot read it", async () => {
      mockGetBackups.mockReturnValue([
        { pluginId: "plugin-a", version: "1.5.0", createdAt: new Date(), size: 1 },
        { pluginId: "plugin-a", version: "0.9.0", createdAt: new Date(), size: 1 },
      ])
      const restore = { kind: "restore", snapshotId: "s1", capturedAt: 1, dataVersion: 1 }
      mockDescribeDataRollback.mockImplementation(async (_db, _id, version: string) =>
        version === "1.5.0"
          ? restore
          : { kind: "unavailable", currentDataVersion: 2, targetDataVersion: 0 }
      )
      const [newer, older] = (await manager.getRollbackInfo("plugin-a")).availableVersions
      expect(newer).toMatchObject({ version: "1.5.0", canRollback: true, data: restore })
      expect(older).toMatchObject({
        version: "0.9.0",
        canRollback: false,
        data: { kind: "unavailable" },
      })
    })
  })

  describe("rollback", () => {
    it("reinstalls a service provider dependency without re-entering the consumer mutation queue", async () => {
      const { PluginManager } = jest.requireActual(
        "../core/manager"
      ) as typeof import("../core/manager")
      const consumer = {
        ...storeState.plugins["plugin-a"].manifest,
        requiresServices: { "rollback.service": "^1.0.0" },
      }
      storeState.plugins["plugin-a"].manifest = consumer
      storeState.plugins.provider = {
        manifest: {
          id: "provider",
          version: "1.0.0",
          providesServices: { "rollback.service": "1.0.0" },
        } as unknown as typeof consumer,
        status: "installed",
        config: {},
      }
      const serviceRegistry = new PluginServiceRegistry()
      serviceRegistry.beginProvider("provider", 1, { "rollback.service": "1.0.0" })
      serviceRegistry.publishProvider("provider", 1)
      const runtime = new PluginManager({
        pluginDirectory: "/plugins",
        lifecycleFeatures: { runtimeServices: true },
        serviceRegistry,
        lifecycleStateAdapter: new InMemoryPluginLifecycleStateAdapter(),
      })
      mockManager.withPluginPackageMutation.mockImplementation((id, operation) =>
        runtime.withPluginPackageMutation(id, operation)
      )
      const internals = runtime as unknown as {
        quiesceServiceConsumers(id: string): Promise<void>
        disablePluginInner(id: string): Promise<void>
      }
      jest.spyOn(internals, "disablePluginInner").mockResolvedValue(undefined)
      mockInstallPlugin.mockImplementationOnce(async () => {
        await internals.quiesceServiceConsumers("provider")
        return { success: true }
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          manager.rollback("plugin-a", "1.0.0"),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("deadlocked"), 500)
          }),
        ])
        expect(result).toMatchObject({ success: true })
        await expect(
          runtime.withPluginPackageMutation("plugin-a", async () => "queue usable")
        ).resolves.toBe("queue usable")
        expect(internals.disablePluginInner).toHaveBeenCalledWith("plugin-a", "service-draining")
      } finally {
        clearTimeout(timer)
      }
    })
    it("keeps a dirty restore pending and allows explicit retry after cleanup (U17)", async () => {
      mockGetBackups.mockReturnValue([
        { id: "old-backup", version: "1.0.0", createdAt: new Date() },
      ])
      mockManager.hasUnresolvedActivationResources.mockReturnValue(true)
      expect(await manager.rollback("plugin-a", "1.0.0")).toMatchObject({
        success: false,
        requiresRestart: true,
        error: expect.stringMatching(/pending restore.*1.0.0/i),
        rollback: { attempted: true, succeeded: false },
      })
      expect(mockRestoreToVersion).not.toHaveBeenCalled()
      expect(mockInstallPlugin).not.toHaveBeenCalled()
      mockManager.hasUnresolvedActivationResources.mockReturnValue(false)
      expect(await manager.rollback("plugin-a", "1.0.0")).toMatchObject({ success: true })
      expect(mockRestoreToVersion).toHaveBeenCalledWith("plugin-a", "1.0.0", mockManager)
    })
    it("should attempt rollback with backup available", async () => {
      mockGetBackups.mockReturnValue([
        {
          pluginId: "plugin-a",
          version: "1.0.0",
          createdAt: new Date(),
          size: 1000,
          path: "/backup/1.0.0",
        },
      ])

      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result.success).toBe(true)
      expect(result.toVersion).toBe("1.0.0")
    })

    it("should handle rollback failure", async () => {
      mockInstallPlugin.mockResolvedValueOnce({ success: false, error: "install failed" })
      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    // Regression guard. `plugin_load(plugin_id, manifest)` declares the manifest
    // required and refuses one whose `id` disagrees with `plugin_id`, so the old
    // `{ pluginId }` call rejected on a missing argument -- every rollback died
    // at step 5, AFTER the target version had already been restored to disk,
    // leaving the plugin unloaded rather than rolled back. The version asserted
    // here is the target, not the original: the manifest handed to the host has
    // to be the restored one.
    it("loads the restored plugin with the manifest the host requires", async () => {
      mockGetBackups.mockReturnValue([
        {
          pluginId: "plugin-a",
          version: "1.0.0",
          createdAt: new Date(),
          size: 1000,
          path: "/backup/1.0.0",
        },
      ])

      const result = await manager.rollback("plugin-a", "1.0.0")

      expect(result.success).toBe(true)
      expect(mockManager.enablePlugin).toHaveBeenCalledWith("plugin-a", "rollback")
      expect(mockManager.unloadPlugin).toHaveBeenCalledWith("plugin-a")
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it("keeps a disabled plugin inactive and preserves its config", async () => {
      storeState.plugins["plugin-a"].status = "disabled"
      storeState.plugins["plugin-a"].config = { userChoice: "keep" }
      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result.success).toBe(true)
      expect(mockManager.enablePlugin).not.toHaveBeenCalled()
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_enable", expect.anything())
      expect(storeState.plugins["plugin-a"].status).toBe("disabled")
      expect(storeState.plugins["plugin-a"].config).toEqual({ userChoice: "keep" })
    })

    it("restores suspended intent instead of leaving the plugin active", async () => {
      storeState.plugins["plugin-a"].status = "suspended"
      expect((await manager.rollback("plugin-a", "1.0.0")).success).toBe(true)
      expect(mockManager.suspendPlugin).toHaveBeenCalledWith("plugin-a", "rollback")
      expect(storeState.plugins["plugin-a"].status).toBe("suspended")
    })

    it("refuses, before touching anything, when the data cannot be brought back", async () => {
      mockDescribeDataRollback.mockResolvedValue({
        kind: "unavailable",
        currentDataVersion: 2,
        targetDataVersion: 1,
      })
      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result).toMatchObject({
        success: false,
        dataRestored: false,
        error:
          'Plugin "plugin-a" data was migrated to v2; update to v2 or later, or clear plugin data before activating v1',
      })
      expect(result.rollback).toBeUndefined()
      expect(mockCreateBackup).not.toHaveBeenCalled()
      expect(mockManager.disablePlugin).not.toHaveBeenCalled()
      expect(mockInstallPlugin).not.toHaveBeenCalled()
      expect(storeState.plugins["plugin-a"].status).toBe("enabled")
    })

    it("refuses a data restore nobody confirmed, before touching anything", async () => {
      mockDescribeDataRollback.mockResolvedValue({ kind: "restore", snapshotId: "s1" })
      for (const confirmed of [undefined, "another"]) {
        const result = await manager.rollback("plugin-a", "1.0.0", {
          ...(confirmed ? { confirmedDataSnapshot: confirmed } : {}),
        })
        expect(result).toMatchObject({
          success: false,
          error: expect.stringContaining("restores its data from snapshot s1"),
        })
      }
      expect(mockCreateBackup).not.toHaveBeenCalled()
      expect(mockInstallPlugin).not.toHaveBeenCalled()
      expect(mockRestoreDataSnapshot).not.toHaveBeenCalled()
    })

    it("restores the confirmed data snapshot after the package and before reactivating", async () => {
      mockDescribeDataRollback.mockResolvedValue({ kind: "restore", snapshotId: "s1" })
      const order: string[] = []
      mockInstallPlugin.mockImplementation(async () => {
        order.push("install")
        return { success: true }
      })
      mockRestoreDataSnapshot.mockImplementation(async () => {
        order.push("data")
        return { dataVersion: 1, rows: 2 }
      })
      mockManager.enablePlugin.mockImplementation(async () => {
        order.push("enable")
        storeState.plugins["plugin-a"].status = "enabled"
      })
      const result = await manager.rollback("plugin-a", "1.0.0", { confirmedDataSnapshot: "s1" })
      expect(result).toMatchObject({ success: true, dataRestored: true })
      expect(mockRestoreDataSnapshot).toHaveBeenCalledWith(expect.any(Function), "plugin-a", "s1")
      expect(order).toEqual(["install", "data", "enable"])
    })

    it("passes the confirmation through a backup restore", async () => {
      mockGetBackups.mockReturnValue([{ id: "old", pluginId: "plugin-a", version: "1.0.0" }])
      mockDescribeDataRollback.mockResolvedValue({ kind: "restore", snapshotId: "s1" })
      expect(await manager.restoreBackup("old", { confirmedDataSnapshot: "s1" })).toMatchObject({
        success: true,
        dataRestored: true,
      })
      expect(mockRestore).toHaveBeenCalledWith("old", mockManager)
    })

    it("does not manufacture the target version when scanning fails", async () => {
      mockManager.scanPlugins.mockRejectedValueOnce(new Error("scan failed"))
      expect(await manager.rollback("plugin-a", "1.0.0")).toMatchObject({
        success: false,
        error: "scan failed",
      })
      expect(storeState.plugins["plugin-a"].manifest.version).toBe("2.0.0")
      expect(mockManager.enablePlugin).not.toHaveBeenCalled()
    })

    it("rejects an installed version different from the requested rollback", async () => {
      mockManager.scanPlugins.mockResolvedValueOnce([])
      expect((await manager.rollback("plugin-a", "1.0.0")).success).toBe(false)
      expect(mockManager.enablePlugin).not.toHaveBeenCalled()
    })
  })

  describe("failure compensation (PL09)", () => {
    const registryOrigin = {
      pluginId: "plugin-a",
      version: "2.0.0",
      origin: { kind: "registry", registryUrl: "https://r.test", version: "2.0.0" },
      recordedAt: 1,
    }
    let safetyRestored: boolean

    beforeEach(() => {
      safetyRestored = false
      mockCreateBackup.mockResolvedValue({ success: true, backup: { id: "safety" } })
      mockReadOrigin.mockResolvedValue(registryOrigin)
      mockRestore.mockImplementation(async (id: string) => {
        if (id === "safety") safetyRestored = true
        return { success: true, requiresRestart: false }
      })
      mockManager.scanPlugins.mockImplementation(async () => {
        storeState.plugins["plugin-a"].manifest.version = safetyRestored ? "2.0.0" : "1.0.0"
      })
    })

    it("restarts the untouched old runtime when the download fails", async () => {
      mockInstallPlugin.mockResolvedValueOnce({ success: false, error: "network down" })
      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result).toMatchObject({
        success: false,
        error: "network down",
        requiresRestart: false,
        rollback: { attempted: true, succeeded: true },
      })
      expect(mockManager.enablePlugin).toHaveBeenCalledWith("plugin-a", "rollback-restore")
      expect(mockRestore).not.toHaveBeenCalled()
      expect(storeState.plugins["plugin-a"].status).toBe("enabled")
    })

    it("restores the safety snapshot when restoring the data throws after installing", async () => {
      mockDescribeDataRollback.mockResolvedValue({ kind: "restore", snapshotId: "s1" })
      mockRestoreDataSnapshot.mockRejectedValueOnce(new Error("missing chunk 0"))
      const result = await manager.rollback("plugin-a", "1.0.0", { confirmedDataSnapshot: "s1" })
      expect(result).toMatchObject({
        success: false,
        dataRestored: false,
        error: "missing chunk 0",
        requiresRestart: true,
        rollback: { attempted: true, succeeded: true },
      })
      expect(mockRestore).toHaveBeenCalledWith("safety", mockManager)
      expect(storeState.plugins["plugin-a"].manifest.version).toBe("2.0.0")
      // The restored package stays inactive until a restart, like a failed update.
      expect(mockManager.enablePlugin).not.toHaveBeenCalled()
      expect(mockRecordOrigin).toHaveBeenCalledWith({
        pluginId: "plugin-a",
        version: "2.0.0",
        origin: registryOrigin.origin,
      })
    })

    it("says the data stayed restored when a later step fails", async () => {
      mockDescribeDataRollback.mockResolvedValue({ kind: "restore", snapshotId: "s1" })
      mockManager.enablePlugin.mockRejectedValueOnce(new Error("activation failed"))
      const result = await manager.rollback("plugin-a", "1.0.0", { confirmedDataSnapshot: "s1" })
      expect(result).toMatchObject({
        success: false,
        dataRestored: true,
        error: "activation failed; the plugin's data was already restored from its snapshot",
        rollback: { attempted: true, succeeded: true },
      })
      expect(mockRestore).toHaveBeenCalledWith("safety", mockManager)
    })

    it("reports, without pretending, when there is no safety snapshot to restore", async () => {
      mockCreateBackup.mockResolvedValue({ success: true })
      mockManager.scanPlugins.mockRejectedValueOnce(new Error("scan failed"))
      expect(await manager.rollback("plugin-a", "1.0.0")).toMatchObject({
        success: false,
        error: "scan failed",
        requiresRestart: true,
        rollback: { attempted: false, succeeded: false },
      })
    })

    it("asks for a restart when the safety snapshot itself cannot be restored", async () => {
      mockManager.enablePlugin.mockRejectedValueOnce(new Error("activation failed"))
      mockRestore.mockResolvedValueOnce({ success: false, error: "disk full" })
      expect(await manager.rollback("plugin-a", "1.0.0")).toMatchObject({
        success: false,
        requiresRestart: true,
        rollback: {
          attempted: true,
          succeeded: false,
          error: expect.stringContaining("disk full"),
        },
      })
    })

    it("records a restored snapshot as a restored origin, not the replaced version's", async () => {
      mockGetBackups.mockReturnValue([{ id: "old", pluginId: "plugin-a", version: "1.0.0" }])
      expect(await manager.restoreBackup("old")).toMatchObject({ success: true })
      expect(mockRecordOrigin).toHaveBeenCalledWith({
        pluginId: "plugin-a",
        version: "1.0.0",
        origin: { kind: "local", via: "restored" },
      })
    })
  })

  describe("lifecycle contract (ADR-0258)", () => {
    const VERSIONS = { from: "2.0.0", to: "1.0.0" }
    const STATUS_OF = {
      enabled: "enabled",
      suspended: "suspended",
      loaded: "loaded",
      stopped: "installed",
    } as const

    /** Roll the installed v2.0.0 (data at v2) back to v1.0.0, with `scenario`'s fault. */
    async function run(scenario: ReplacementScenario): Promise<ReplacementObservation> {
      const plugin = storeState.plugins["plugin-a"]
      plugin.status = STATUS_OF[scenario.before]
      // The store's manifest stands for the package on disk.
      let disk = VERSIONS.from
      let recorded = VERSIONS.from
      let dataVersion = 2
      const project = () => void (plugin.manifest.version = disk)
      mockCreateBackup.mockResolvedValue({ success: true, backup: { id: "safety" } })
      mockReadOrigin.mockResolvedValue({
        pluginId: "plugin-a",
        version: VERSIONS.from,
        origin: { kind: "registry", registryUrl: "https://r.test", version: VERSIONS.from },
      })
      mockRecordOrigin.mockImplementation(async (record: { version: string }) => {
        recorded = record.version
      })
      // The registry install records its own origin, as the marketplace does.
      mockInstallPlugin.mockImplementation(async () => {
        if (scenario.fault === "before-commit") return { success: false, error: "network down" }
        disk = VERSIONS.to
        recorded = VERSIONS.to
        return { success: true }
      })
      mockRestore.mockImplementation(async (id: string) => {
        if (id === "safety") disk = VERSIONS.from
        return { success: true, requiresRestart: false }
      })
      mockManager.scanPlugins.mockImplementation(async () => project())
      mockDescribeDataRollback.mockResolvedValue({ kind: "restore", snapshotId: "s1" })
      mockRestoreDataSnapshot.mockImplementation(async () => {
        dataVersion = 1
        return { dataVersion: 1, rows: 2 }
      })
      if (scenario.fault === "after-commit") {
        const fail = async () => {
          throw new Error("v1 activation failed")
        }
        mockManager.enablePlugin.mockImplementationOnce(fail)
        mockManager.loadPlugin.mockImplementationOnce(fail)
      }

      const result = await manager.rollback("plugin-a", VERSIONS.to, {
        confirmedDataSnapshot: "s1",
      })
      return {
        outcome: result.success ? "succeeded" : "failed",
        restartRequired: result.requiresRestart,
        packageVersion: disk,
        recordedVersion: recorded,
        runtime: runtimeResumeStateOf(plugin.status),
        dataVersion,
      }
    }

    it.each(scenariosFor("desktop-rollback"))("$id", async (scenario) => {
      expect(contractViolations(scenario, VERSIONS, await run(scenario))).toEqual([])
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginRollbackManager()
    const instance1 = getPluginRollbackManager()
    const instance2 = getPluginRollbackManager()
    expect(instance1).toBe(instance2)
  })
})
