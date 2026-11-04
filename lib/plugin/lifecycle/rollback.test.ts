/**
 * Tests for Plugin Rollback Manager
 */

import {
  PluginRollbackManager,
  getPluginRollbackManager,
  resetPluginRollbackManager,
} from "./rollback"

const mockInvoke = jest.fn()
const mockGetBackups = jest.fn()
const mockCreateBackup = jest.fn()
const mockRestoreToVersion = jest.fn()
const mockGetVersions = jest.fn()
const mockInstallPlugin = jest.fn()
const mockStoreGetState = jest.fn()
const mockStoreSetState = jest.fn()
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
    manager = new PluginRollbackManager()
    jest.clearAllMocks()

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
    mockGetVersions.mockResolvedValue([])
    mockInstallPlugin.mockResolvedValue({ success: true })
    mockInvoke.mockResolvedValue(null)
    for (const mock of Object.values(mockManager)) mock.mockReset()
    mockManager.reservePluginRuntimeGraph.mockReturnValue({ pluginId: "plugin-a" })
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

  describe("getRollbackInfo", () => {
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
  })

  describe("createRollbackPlan", () => {
    it("does not plan to load or enable a disabled plugin", async () => {
      storeState.plugins["plugin-a"].status = "disabled"
      mockGetBackups.mockReturnValue([{ version: "1.0.0", createdAt: new Date() }])
      const plan = await manager.createRollbackPlan("plugin-a", "1.0.0")
      expect(plan.steps.map((step) => step.action)).not.toContain("enable")
      expect(plan.steps.map((step) => step.action)).not.toContain("load")
    })
    it("should create a rollback plan with steps", async () => {
      mockGetBackups.mockReturnValue([
        { pluginId: "plugin-a", version: "1.0.0", createdAt: new Date(), size: 1000 },
      ])

      const plan = await manager.createRollbackPlan("plugin-a", "1.0.0")

      expect(plan.pluginId).toBe("plugin-a")
      expect(plan.targetVersion).toBe("1.0.0")
      expect(plan.steps.length).toBeGreaterThan(0)
    })

    it("should throw for unavailable target version", async () => {
      await expect(manager.createRollbackPlan("plugin-a", "1.0.0")).rejects.toThrow(
        "Version 1.0.0 is not available for rollback"
      )
    })
  })

  describe("rollback", () => {
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
      expect(mockManager.enablePlugin).toHaveBeenCalledWith("plugin-a")
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

    it("reports a failed down migration and does not reactivate", async () => {
      storeState.plugins["plugin-a"].config = { nested: { value: "keep" } }
      manager.registerMigration("plugin-a", {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        up: (data) => data,
        down: (data) => {
          ;(data.nested as { value: string }).value = "changed"
          throw new Error("down migration rejected")
        },
      })
      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result).toMatchObject({
        success: false,
        migrationApplied: false,
        error: "down migration rejected",
      })
      expect(mockManager.enablePlugin).not.toHaveBeenCalled()
      expect(storeState.plugins["plugin-a"].config).toEqual({ nested: { value: "keep" } })
      expect(mockManager.releasePluginRuntimeGraph).toHaveBeenCalled()
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

  describe("rollbackToLatestBackup", () => {
    it("should rollback to latest backup version", async () => {
      mockGetBackups.mockReturnValue([
        {
          pluginId: "plugin-a",
          version: "1.5.0",
          createdAt: new Date(),
          size: 1200,
          path: "/backup/1.5.0",
        },
        {
          pluginId: "plugin-a",
          version: "1.0.0",
          createdAt: new Date(Date.now() - 10000),
          size: 1000,
          path: "/backup/1.0.0",
        },
      ])

      mockManager.scanPlugins.mockImplementationOnce(async () => {
        storeState.plugins["plugin-a"].manifest.version = "1.5.0"
      })

      const result = await manager.rollbackToLatestBackup("plugin-a")
      expect(result.success).toBe(true)
      expect(result.toVersion).toBe("1.5.0")
    })

    it("should fail if no backups available", async () => {
      mockGetBackups.mockReturnValue([])
      const result = await manager.rollbackToLatestBackup("plugin-a")
      expect(result.success).toBe(false)
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
