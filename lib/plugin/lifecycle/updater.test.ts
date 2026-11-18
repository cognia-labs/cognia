/**
 * @jest-environment jsdom
 *
 * Tests for Plugin Updater
 */

import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { runPluginMigrations } from "@/lib/plugin/dexie/migration-runner"
import { invoke } from "@tauri-apps/api/core"

import {
  PLUGIN_UPDATES_AVAILABLE_EVENT,
  PluginUpdater,
  getPluginUpdater,
  resetPluginUpdater,
} from "./updater"
import type { PluginInstallOrigin } from "@/types/plugin/plugin-cogset"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
    setState: jest.fn(),
  },
}))

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

// Defined inside the factory (jest.mock factories hit the TDZ otherwise) and
// re-imported below so assertions can reach the spy.
jest.mock("../package/marketplace", () => {
  const getPlugin = jest.fn().mockResolvedValue({
    id: "plugin-a",
    latestVersion: "2.0.0",
    updatedAt: new Date(),
  })
  const installPlugin = jest.fn().mockResolvedValue({ success: true })
  const getVersions = jest.fn().mockResolvedValue([
    {
      version: "2.0.0",
      publishedAt: new Date(),
      downloadUrl: "https://example.com/plugin-a-2.0.0.zip",
    },
  ])
  const stagePluginUpdate = jest.fn().mockResolvedValue({
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    pluginId: "plugin-a",
    version: "2.0.0",
    stagedPath: "/host-state/update-transactions/plugin-a/package",
    manifest: {
      id: "plugin-a",
      name: "Plugin A",
      version: "2.0.0",
      description: "Plugin A",
      type: "frontend",
      capabilities: [],
      main: "index.js",
    },
    sizeBytes: 1024,
  })
  const commitStagedPluginUpdate = jest.fn().mockResolvedValue(undefined)
  const discardStagedPluginUpdate = jest.fn().mockResolvedValue(undefined)
  const finalizeStagedPluginUpdate = jest.fn().mockResolvedValue(undefined)
  return {
    __getPluginSpy: getPlugin,
    __getVersionsSpy: getVersions,
    __installPluginSpy: installPlugin,
    __stagePluginUpdateSpy: stagePluginUpdate,
    __commitStagedPluginUpdateSpy: commitStagedPluginUpdate,
    __discardStagedPluginUpdateSpy: discardStagedPluginUpdate,
    __finalizeStagedPluginUpdateSpy: finalizeStagedPluginUpdate,
    getPluginMarketplace: () => ({
      getRegistryUrl: () => "https://plugins.example.test/api/v1",
      getPlugin,
      getVersions,
      installPlugin,
      stagePluginUpdate,
      commitStagedPluginUpdate,
      discardStagedPluginUpdate,
      finalizeStagedPluginUpdate,
    }),
  }
})

jest.mock("@/lib/plugin/vscode-shim/openvsx-client", () => ({
  getOpenVsxClient: jest.fn(),
}))

jest.mock("@/lib/plugin/vscode-shim/openvsx-cache", () => ({
  getCached: jest.fn(),
  putCached: jest.fn(async () => undefined),
  cacheRowFromQueryEntry: jest.fn((entry: unknown) => entry),
}))

jest.mock("./backup", () => ({
  __createBackupSpy: jest.fn().mockResolvedValue({
    success: true,
    backup: { id: "plugin-a-before-update", pluginId: "plugin-a", version: "1.0.0" },
  }),
  __restoreBackupSpy: jest.fn().mockResolvedValue({ success: true }),
  __beginRecoverySpy: jest.fn(),
  __completeRecoverySpy: jest.fn(),
  __endRecoveryAttemptSpy: jest.fn(),
  getPluginBackupManager() {
    const mockedBackup = jest.requireMock("./backup") as {
      __createBackupSpy: jest.Mock
      __restoreBackupSpy: jest.Mock
      __beginRecoverySpy: jest.Mock
      __completeRecoverySpy: jest.Mock
      __endRecoveryAttemptSpy: jest.Mock
    }
    return {
      createBackup: mockedBackup.__createBackupSpy,
      restore: mockedBackup.__restoreBackupSpy,
      beginUpdateRecovery: mockedBackup.__beginRecoverySpy,
      completeUpdateRecovery: mockedBackup.__completeRecoverySpy,
      endUpdateRecoveryAttempt: mockedBackup.__endRecoveryAttemptSpy,
      getPendingUpdateRestore: () => undefined,
    }
  },
}))

jest.mock("../core/manager", () => ({
  __disablePluginSpy: jest.fn().mockResolvedValue(undefined),
  __unloadPluginSpy: jest.fn().mockResolvedValue(undefined),
  __scanPluginsSpy: jest.fn().mockResolvedValue([]),
  __syncRuntimeStateSpy: jest.fn().mockResolvedValue(undefined),
  __enablePluginSpy: jest.fn().mockResolvedValue(undefined),
  __loadPluginSpy: jest.fn().mockResolvedValue(undefined),
  __suspendPluginSpy: jest.fn().mockResolvedValue(undefined),
  __hasUnresolvedActivationResourcesSpy: jest.fn(() => false),
  __reservePluginRuntimeGraphSpy: jest.fn(() => ({
    managerId: "manager",
    pluginId: "plugin-a",
    token: 1,
  })),
  __releasePluginRuntimeGraphSpy: jest.fn(() => true),
  getPluginManager() {
    const mockedManager = jest.requireMock("../core/manager") as Record<string, jest.Mock>
    return {
      disablePlugin: mockedManager.__disablePluginSpy,
      unloadPlugin: mockedManager.__unloadPluginSpy,
      scanPlugins: mockedManager.__scanPluginsSpy,
      syncRuntimeState: mockedManager.__syncRuntimeStateSpy,
      enablePlugin: mockedManager.__enablePluginSpy,
      loadPlugin: mockedManager.__loadPluginSpy,
      suspendPlugin: mockedManager.__suspendPluginSpy,
      hasUnresolvedActivationResources: mockedManager.__hasUnresolvedActivationResourcesSpy,
      withPluginPackageMutation: (_id: string, operation: () => Promise<unknown>) => operation(),
      getPluginLifecycleState: async () => ({ actual: "inactive" }),
      reservePluginRuntimeGraph: mockedManager.__reservePluginRuntimeGraphSpy,
      releasePluginRuntimeGraph: mockedManager.__releasePluginRuntimeGraphSpy,
    }
  },
}))

jest.mock("../ide/proxy-manager", () => ({
  __stageManagedIdeProxySpy: jest.fn().mockResolvedValue(null),
  stageManagedIdeProxy(plugin: unknown) {
    const mocked = jest.requireMock("../ide/proxy-manager") as {
      __stageManagedIdeProxySpy: jest.Mock
    }
    return mocked.__stageManagedIdeProxySpy(plugin)
  },
}))

jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    activateProxy: jest.fn().mockResolvedValue(true),
  },
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import { codeServerClient } from "@/lib/codeserver/client"
import { getOpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"
import { getCached, putCached } from "@/lib/plugin/vscode-shim/openvsx-cache"

const marketplaceModule = jest.requireMock("../package/marketplace") as {
  __getPluginSpy: jest.Mock
  __getVersionsSpy: jest.Mock
  __installPluginSpy: jest.Mock
  __stagePluginUpdateSpy: jest.Mock
  __commitStagedPluginUpdateSpy: jest.Mock
  __discardStagedPluginUpdateSpy: jest.Mock
  __finalizeStagedPluginUpdateSpy: jest.Mock
}
const cogniaGetPlugin = marketplaceModule.__getPluginSpy
const cogniaGetVersions = marketplaceModule.__getVersionsSpy
const cogniaInstallPlugin = marketplaceModule.__installPluginSpy
const stagePluginUpdate = marketplaceModule.__stagePluginUpdateSpy
const commitStagedPluginUpdate = marketplaceModule.__commitStagedPluginUpdateSpy
const discardStagedPluginUpdate = marketplaceModule.__discardStagedPluginUpdateSpy
const finalizeStagedPluginUpdate = marketplaceModule.__finalizeStagedPluginUpdateSpy
const proxyManagerModule = jest.requireMock("../ide/proxy-manager") as {
  __stageManagedIdeProxySpy: jest.Mock
}
const backupModule = jest.requireMock("./backup") as {
  __createBackupSpy: jest.Mock
  __restoreBackupSpy: jest.Mock
  __beginRecoverySpy: jest.Mock
  __completeRecoverySpy: jest.Mock
  __endRecoveryAttemptSpy: jest.Mock
}
const managerModule = jest.requireMock("../core/manager") as {
  __disablePluginSpy: jest.Mock
  __unloadPluginSpy: jest.Mock
  __scanPluginsSpy: jest.Mock
  __syncRuntimeStateSpy: jest.Mock
  __enablePluginSpy: jest.Mock
  __loadPluginSpy: jest.Mock
  __suspendPluginSpy: jest.Mock
  __hasUnresolvedActivationResourcesSpy: jest.Mock
  __reservePluginRuntimeGraphSpy: jest.Mock
  __releasePluginRuntimeGraphSpy: jest.Mock
}
const getOpenVsxClientMock = getOpenVsxClient as jest.Mock
const getCachedMock = getCached as jest.Mock
const putCachedMock = putCached as jest.Mock

const mockGetStoreState = usePluginStore.getState as jest.MockedFunction<
  typeof usePluginStore.getState
>
const mockSetStoreState = usePluginStore.setState as jest.Mock

/** A store entry shaped like the runtime's `PluginRegistration`. */
function storePlugin(manifest: Record<string, unknown>) {
  return { manifest, status: "installed" }
}

const REGISTRY_URL = "https://plugins.example.test/api/v1"
/** Per-test origin overrides; absent ids get the origin their type implies. */
const originOverrides = new Map<string, PluginInstallOrigin | undefined>()
const recordOriginSpy = jest.fn(async () => undefined)

/** A registry plugin came from the registry; an extension from Open VSX. */
async function testInstallOrigin(id: string): Promise<PluginInstallOrigin | undefined> {
  if (originOverrides.has(id)) return originOverrides.get(id)
  const manifest = (
    mockGetStoreState().plugins as Record<string, { manifest: { type?: string; version: string } }>
  )[id]?.manifest
  if (manifest?.type === "vscode-extension") {
    const [namespace, ...name] = id.split(".")
    return {
      kind: "openvsx",
      namespace,
      name: name.join("."),
      version: manifest.version,
      sha256: "0".repeat(64),
    }
  }
  return { kind: "registry", registryUrl: REGISTRY_URL, version: manifest?.version ?? "1.0.0" }
}

function makeUpdater(deps: ConstructorParameters<typeof PluginUpdater>[1] = {}): PluginUpdater {
  return new PluginUpdater(
    {},
    { resolveInstallOrigin: testInstallOrigin, recordOrigin: recordOriginSpy, ...deps }
  )
}

describe("PluginUpdater", () => {
  let updater: PluginUpdater

  beforeEach(() => {
    resetPluginUpdater()
    updater = makeUpdater()
    jest.clearAllMocks()
    originOverrides.clear()
    cogniaGetPlugin.mockResolvedValue({
      id: "plugin-a",
      latestVersion: "2.0.0",
      updatedAt: new Date(),
    })
    cogniaGetVersions.mockReset().mockResolvedValue([
      {
        version: "2.0.0",
        publishedAt: new Date(),
        downloadUrl: "https://example.com/plugin-a-2.0.0.zip",
      },
    ])
    getCachedMock.mockResolvedValue(undefined)
    const runtimeState = {
      plugins: {
        "plugin-a": {
          manifest: { id: "plugin-a", version: "1.0.0" },
          status: "installed",
        },
      },
    }
    mockGetStoreState.mockImplementation(() => runtimeState as never)
    mockSetStoreState.mockImplementation((updater) => {
      const patch = typeof updater === "function" ? updater(runtimeState) : updater
      if (patch && typeof patch === "object") Object.assign(runtimeState, patch)
    })
    backupModule.__createBackupSpy.mockResolvedValue({
      success: true,
      backup: {
        id: "plugin-a-before-update",
        pluginId: "plugin-a",
        version: "1.0.0",
      },
    })
    backupModule.__restoreBackupSpy.mockReset().mockResolvedValue({ success: true })
    backupModule.__beginRecoverySpy.mockReset()
    backupModule.__completeRecoverySpy.mockReset()
    backupModule.__endRecoveryAttemptSpy.mockReset()
    managerModule.__enablePluginSpy.mockReset().mockResolvedValue(undefined)
    managerModule.__hasUnresolvedActivationResourcesSpy.mockReset().mockReturnValue(false)
    managerModule.__unloadPluginSpy.mockReset().mockImplementation(async () => {
      const state = mockGetStoreState()
      state.plugins["plugin-a"].status = "installed"
    })
    managerModule.__reservePluginRuntimeGraphSpy.mockImplementation(() => ({
      managerId: "manager",
      pluginId: "plugin-a",
      token: 1,
    }))
    managerModule.__releasePluginRuntimeGraphSpy.mockReturnValue(true)
    cogniaInstallPlugin.mockResolvedValue({ success: true })
    stagePluginUpdate.mockResolvedValue({
      transactionId: "123e4567-e89b-42d3-a456-426614174000",
      pluginId: "plugin-a",
      version: "2.0.0",
      stagedPath: "/host-state/update-transactions/plugin-a/package",
      manifest: {
        id: "plugin-a",
        name: "Plugin A",
        version: "2.0.0",
        description: "Plugin A",
        type: "frontend",
        capabilities: [],
        main: "index.js",
      },
      sizeBytes: 1024,
    })
    commitStagedPluginUpdate.mockResolvedValue(undefined)
    discardStagedPluginUpdate.mockResolvedValue(undefined)
    finalizeStagedPluginUpdate.mockResolvedValue(undefined)
    proxyManagerModule.__stageManagedIdeProxySpy.mockResolvedValue(null)
  })

  describe("Update Checking", () => {
    const configurePrerelease = (allowPrerelease: boolean) => {
      updater.configureAutoUpdate({
        enabled: false,
        checkInterval: 3600000,
        autoInstall: true,
        notifyOnly: false,
        excludePlugins: [],
        allowPrerelease,
      })
    }

    it.each([
      ["1.0.0-beta.1", "1.0.0", true],
      ["1.0.0-beta.1", "1.0.0-beta.2", true],
      ["1.0.0-beta.2", "1.0.0-beta.11", true],
      ["1.0.0-alpha", "1.0.0-beta", true],
      ["1.0.0-1", "1.0.0-alpha", true],
      ["1.0.0-beta", "1.0.0-beta.1", true],
      ["1.0.0-beta.11", "1.0.0-beta.2", false],
      ["1.0.0", "1.0.0-rc.1", false],
      ["1.0.0+build.1", "1.0.0+build.2", false],
      ["1.0.0-rc.1+build.1", "1.0.0-rc.1+build.2", false],
      ["1.9.9", "1.10.0", true],
    ])("uses SemVer precedence for %s → %s (B20)", async (current, latest, expected) => {
      configurePrerelease(true)
      mockGetStoreState().plugins["plugin-a"].manifest.version = current
      cogniaGetPlugin.mockResolvedValueOnce({ latestVersion: latest })

      expect(await updater.checkForUpdates()).toHaveLength(expected ? 1 : 0)
    })

    it.each([undefined, false, true])(
      "honours Cognia prerelease policy %s (B21)",
      async (allow) => {
        if (allow !== undefined) configurePrerelease(allow)
        cogniaGetPlugin.mockResolvedValue({ latestVersion: "1.1.0-beta.1" })
        cogniaGetVersions.mockResolvedValue([{ version: "1.1.0-beta.1" }])

        const updates = await updater.checkForUpdates()

        expect(updates).toHaveLength(allow ? 1 : 0)
        expect(updater.getPendingUpdates()).toEqual(updates)
      }
    )

    it("finds the newest stable Cognia fallback when latest is a beta (B21)", async () => {
      configurePrerelease(false)
      cogniaGetPlugin.mockResolvedValueOnce({ latestVersion: "1.2.0-beta.1" })
      cogniaGetVersions.mockResolvedValueOnce([
        { version: "1.0.1" },
        { version: "1.2.0-beta.1" },
        { version: "1.1.0", publishedAt: new Date("2026-11-01") },
      ])

      expect(await updater.checkForUpdates()).toEqual([
        expect.objectContaining({ latestVersion: "1.1.0", releaseDate: new Date("2026-11-01") }),
      ])
    })

    it("does not auto-install a Cognia beta without opt-in (B21)", async () => {
      configurePrerelease(false)
      cogniaGetPlugin.mockResolvedValueOnce({ latestVersion: "1.1.0-beta.1" })
      cogniaGetVersions.mockResolvedValueOnce([{ version: "1.1.0-beta.1" }])
      const install = jest.spyOn(updater, "update")

      await updater.runAutoUpdateOnce()

      expect(install).not.toHaveBeenCalled()
    })

    it("removes a pending beta after prerelease opt-out and rechecking (B21)", async () => {
      cogniaGetPlugin.mockResolvedValue({ latestVersion: "1.1.0-beta.1" })
      cogniaGetVersions.mockResolvedValue([{ version: "1.1.0-beta.1" }])
      configurePrerelease(true)
      expect(await updater.checkForUpdates()).toHaveLength(1)
      configurePrerelease(false)

      expect(await updater.checkForUpdates()).toEqual([])
      expect(updater.getPendingUpdates()).toEqual([])
    })

    it("includes suspended plugins in general and automatic checks (B22)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "suspended"
      const explicit = await updater.checkForUpdates(["plugin-a"])

      expect(explicit).toHaveLength(1)
      expect(await updater.checkForUpdates()).toEqual(explicit)
      configurePrerelease(false)
      const install = jest.spyOn(updater, "update").mockResolvedValue({
        success: true,
        pluginId: "plugin-a",
        previousVersion: "1.0.0",
        newVersion: "1.1.0",
        duration: 0,
      })
      cogniaGetPlugin.mockResolvedValueOnce({ latestVersion: "1.1.0" })
      await updater.runAutoUpdateOnce()
      expect(install).toHaveBeenCalledWith("plugin-a")
    })

    it("should check for updates for specific plugins", async () => {
      const updates = await updater.checkForUpdates(["plugin-a"])

      expect(Array.isArray(updates)).toBe(true)
    })

    it("should check update for a single plugin", async () => {
      const update = await updater.checkPluginUpdate("plugin-a")

      // May return null or UpdateInfo depending on marketplace response
      expect(update === null || typeof update === "object").toBe(true)
    })

    it("should get pending updates", () => {
      const pending = updater.getPendingUpdates()
      expect(Array.isArray(pending)).toBe(true)
    })

    it("should clear pending updates", () => {
      updater.clearPendingUpdate("plugin-a")
      // No error means success
    })
  })

  describe("Open VSX routing", () => {
    it.each([false, true])(
      "honours Open VSX prerelease opt-in %s (B21)",
      async (allowPrerelease) => {
        updater.configureAutoUpdate({
          enabled: false,
          checkInterval: 3600000,
          autoInstall: false,
          notifyOnly: true,
          excludePlugins: [],
          allowPrerelease,
        })
        mockGetStoreState.mockReturnValue({
          plugins: {
            "ns.ext": storePlugin({ id: "ns.ext", version: "1.0.0", type: "vscode-extension" }),
          },
        } as never)
        getOpenVsxClientMock.mockReturnValue({
          queryExtension: jest.fn().mockResolvedValue({
            extensions: [
              { namespace: "ns", name: "ext", version: "1.1.0", preRelease: true, files: {} },
            ],
          }),
        })

        expect(await updater.checkForUpdates()).toHaveLength(allowPrerelease ? 1 : 0)
        // The shared cache cannot record a prerelease as the stable selection.
        expect(putCachedMock).not.toHaveBeenCalled()
      }
    )

    it.each([
      [true, { latestVersion: "1.0.0", payload: { preRelease: false } }, "1.1.0", true],
      [false, { latestVersion: "1.2.0", payload: { preRelease: true } }, "1.1.0", false],
      [false, { latestVersion: "1.2.0-beta.1" }, "1.1.0", false],
    ])(
      "reselects cached metadata for policy %s (B21)",
      async (allowPrerelease, cached, version, preRelease) => {
        updater.configureAutoUpdate({
          enabled: false,
          checkInterval: 3600000,
          autoInstall: false,
          notifyOnly: true,
          excludePlugins: [],
          allowPrerelease,
        })
        mockGetStoreState.mockReturnValue({
          plugins: {
            "ns.ext": storePlugin({ id: "ns.ext", version: "1.0.0", type: "vscode-extension" }),
          },
        } as never)
        getCachedMock.mockResolvedValue(cached)
        const queryExtension = jest.fn().mockResolvedValue({
          extensions: [{ namespace: "ns", name: "ext", version, preRelease, files: {} }],
        })
        getOpenVsxClientMock.mockReturnValue({ queryExtension })

        expect(await updater.checkForUpdates()).toEqual([
          expect.objectContaining({ pluginId: "ns.ext", latestVersion: version }),
        ])
        expect(queryExtension).toHaveBeenCalledTimes(1)
      }
    )

    /**
     * A query client returning one stable version. The parameter is typed so
     * `mock.calls[0][0]` is reachable — an untyped `jest.fn(async () => …)`
     * infers a zero-length tuple and the assertions won't compile.
     */
    function fakeOpenVsxClient(version = "2.0.0") {
      const queryExtension = jest.fn(
        async (_opts: { extensionId: string; targetPlatform?: string }) => ({
          offset: 0,
          totalSize: 1,
          extensions: [{ namespace: "esbenp", name: "prettier-vscode", version, files: {} }],
        })
      )
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      return queryExtension
    }

    it("vscode_extensions_are_not_queried_against_cognia_registry", async () => {
      // The bug this fixes: the old loop called marketplace.getPlugin() for
      // every installed plugin regardless of type, so Open VSX extension ids
      // were being sent to cognia's registry — an information leak that also
      // never returned anything.
      const queryExtension = fakeOpenVsxClient("2.0.0")
      mockGetStoreState.mockReturnValue({
        plugins: {
          "plugin-a": storePlugin({ id: "plugin-a", version: "1.0.0", type: "frontend" }),
          "esbenp.prettier-vscode": storePlugin({
            id: "esbenp.prettier-vscode",
            version: "1.0.0",
            type: "vscode-extension",
            vscodeExtension: { identifier: "esbenp.prettier-vscode", targetPlatform: "universal" },
          }),
        },
      } as never)

      const updates = await updater.checkForUpdates()

      // The extension id never reaches the cognia registry...
      const cogniaIds = cogniaGetPlugin.mock.calls.map((c) => c[0])
      expect(cogniaIds).not.toContain("esbenp.prettier-vscode")
      expect(cogniaIds).toEqual(["plugin-a"])
      // ...and it does reach Open VSX instead.
      expect(queryExtension).toHaveBeenCalledTimes(1)
      expect(queryExtension.mock.calls[0][0]).toMatchObject({
        extensionId: "esbenp.prettier-vscode",
      })
      // Both registries produced their update.
      expect(updates.map((u) => u.pluginId).sort()).toEqual(["esbenp.prettier-vscode", "plugin-a"])
    })

    it("re-queries with the recorded targetPlatform, not the current machine's", async () => {
      // A `universal` fallback install must keep being checked as `universal`.
      // Deriving the platform from the asking machine would offer a
      // platform-specific build as an "update" for a universal install.
      const queryExtension = fakeOpenVsxClient()
      mockGetStoreState.mockReturnValue({
        plugins: {
          "rust-lang.rust-analyzer": storePlugin({
            id: "rust-lang.rust-analyzer",
            version: "1.0.0",
            type: "vscode-extension",
            vscodeExtension: { targetPlatform: "universal" },
          }),
        },
      } as never)

      await updater.checkForUpdates()

      expect(queryExtension.mock.calls[0][0]).toMatchObject({ targetPlatform: "universal" })
    })

    it("update_check_respects_cache_ttl", async () => {
      // getCached() is TTL-aware: it returns undefined for a row past 24h, so
      // a fresh hit must short-circuit the network entirely...
      const queryExtension = fakeOpenVsxClient()
      mockGetStoreState.mockReturnValue({
        plugins: {
          "esbenp.prettier-vscode": storePlugin({
            id: "esbenp.prettier-vscode",
            version: "1.0.0",
            type: "vscode-extension",
          }),
        },
      } as never)
      getCachedMock.mockResolvedValue({
        extensionId: "esbenp.prettier-vscode",
        latestVersion: "3.0.0",
        fetchedAt: Date.now(),
      })

      const fromCache = await updater.checkForUpdates()

      expect(getCachedMock).toHaveBeenCalledWith("esbenp.prettier-vscode")
      expect(queryExtension).not.toHaveBeenCalled()
      expect(fromCache[0]).toMatchObject({ latestVersion: "3.0.0" })

      // ...and a stale row (which getCached reports as absent) must fall
      // through to a real query, and re-populate the cache.
      updater.clearPendingUpdate("esbenp.prettier-vscode")
      getCachedMock.mockResolvedValue(undefined)

      const fromNetwork = await updater.checkForUpdates()

      expect(queryExtension).toHaveBeenCalledTimes(1)
      expect(putCachedMock).toHaveBeenCalled()
      expect(fromNetwork[0]).toMatchObject({ latestVersion: "2.0.0" })
    })

    it("update_check_bounds_concurrency", async () => {
      // The old loop was serial and unbounded (N+1). Bounded at 4: never more
      // than 4 lookups in flight, and never serialised down to 1 either.
      let inFlight = 0
      let peak = 0
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const queryExtension = jest.fn(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await gate
        inFlight--
        return {
          offset: 0,
          totalSize: 1,
          extensions: [{ namespace: "ns", name: "ext", version: "2.0.0", files: {} }],
        }
      })
      getOpenVsxClientMock.mockReturnValue({ queryExtension })

      const plugins: Record<string, unknown> = {}
      for (let i = 0; i < 12; i++) {
        plugins[`ns.ext-${i}`] = storePlugin({
          id: `ns.ext-${i}`,
          version: "1.0.0",
          type: "vscode-extension",
        })
      }
      mockGetStoreState.mockReturnValue({ plugins } as never)

      const pending = updater.checkForUpdates()

      // Wait on the condition, not on a guessed number of microtask ticks —
      // checkOpenVsxUpdates dynamic-imports the client first, so tick counting
      // is a race. Settle once the first wave has parked on the gate.
      const tick = () => new Promise((r) => setTimeout(r, 0))
      for (let i = 0; i < 100 && inFlight === 0; i++) await tick()
      for (let i = 0; i < 20; i++) await tick()

      // 12 extensions, limit 4, every worker blocked: exactly 4 in flight.
      // Not "<= 4" — that would also pass if the loop had gone back to serial.
      expect(peak).toBe(4)
      expect(queryExtension).toHaveBeenCalledTimes(4)

      release()
      await pending
      expect(queryExtension).toHaveBeenCalledTimes(12)
      expect(peak).toBe(4)
    })

    it("one failing extension does not sink the rest of the check", async () => {
      const queryExtension = jest.fn(async (opts: { extensionId: string }) => {
        if (opts.extensionId === "ns.broken") throw new Error("registry down")
        return {
          offset: 0,
          totalSize: 1,
          extensions: [{ namespace: "ns", name: "ok", version: "2.0.0", files: {} }],
        }
      })
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      mockGetStoreState.mockReturnValue({
        plugins: {
          "ns.broken": storePlugin({ id: "ns.broken", version: "1.0.0", type: "vscode-extension" }),
          "ns.ok": storePlugin({ id: "ns.ok", version: "1.0.0", type: "vscode-extension" }),
        },
      } as never)

      const updates = await updater.checkForUpdates()

      expect(updates.map((u) => u.pluginId)).toEqual(["ns.ok"])
    })

    it("never offers a pre-release as an update", async () => {
      // Open VSX's "latest" means newest *published* — rust-analyzer's latest
      // is literally a pre-release. Selection reads `preRelease`, not the alias.
      const queryExtension = jest.fn(async () => ({
        offset: 0,
        totalSize: 2,
        extensions: [
          {
            namespace: "rust-lang",
            name: "rust-analyzer",
            version: "3.0.0",
            preRelease: true,
            versionAlias: ["latest", "pre-release"],
            files: {},
          },
          { namespace: "rust-lang", name: "rust-analyzer", version: "2.0.0", files: {} },
        ],
      }))
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      mockGetStoreState.mockReturnValue({
        plugins: {
          "rust-lang.rust-analyzer": storePlugin({
            id: "rust-lang.rust-analyzer",
            version: "1.0.0",
            type: "vscode-extension",
          }),
        },
      } as never)

      const updates = await updater.checkForUpdates()

      expect(updates[0].latestVersion).toBe("2.0.0")
    })

    it("skips the Open VSX modules entirely when no extension is installed", async () => {
      // The client/cache are desktop-install concerns; a user with no
      // extensions should never load them.
      getOpenVsxClientMock.mockReturnValue({ queryExtension: jest.fn() })
      await updater.checkForUpdates()
      expect(getOpenVsxClientMock).not.toHaveBeenCalled()
    })

    it("refuses to headlessly update a VS Code extension", async () => {
      // A new version may request new permissions and update() has no consent
      // callbacks — so this refuses rather than silently installing, and
      // rather than falling through to the cognia registry.
      mockGetStoreState.mockReturnValue({
        plugins: {
          "esbenp.prettier-vscode": storePlugin({
            id: "esbenp.prettier-vscode",
            version: "1.0.0",
            type: "vscode-extension",
          }),
        },
      } as never)

      const result = await updater.update("esbenp.prettier-vscode", {
        force: true,
        version: "2.0.0",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("VS Code extension")
      expect(cogniaGetPlugin).not.toHaveBeenCalled()
    })
  })

  describe("Update Installation", () => {
    it.each(["domain-only", "literal-credentials"])(
      "requires review for %s authority widening with unchanged request rules",
      async (kind) => {
        const current = mockGetStoreState().plugins["plugin-a"].manifest
        current.networkAccess = {
          allowedDomains: ["api.example.com"],
          literalCredentials: "inspect",
          rules: [{ domain: "api.example.com", methods: ["GET"], paths: ["/v1/*"] }],
        }
        stagePluginUpdate.mockResolvedValueOnce({
          transactionId: "authority-update",
          pluginId: "plugin-a",
          version: "2.0.0",
          stagedPath: "/staged",
          manifest: {
            ...current,
            version: "2.0.0",
            networkAccess: {
              ...current.networkAccess,
              ...(kind === "domain-only"
                ? { allowedDomains: ["*"] }
                : { literalCredentials: undefined }),
            },
          },
        })
        expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
          success: false,
          error: expect.stringContaining("PLUGIN_UPDATE_PERMISSION_REVIEW_REQUIRED"),
        })
        expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
      }
    )
    it("refuses package mutation if the durable recovery obligation cannot be armed", async () => {
      backupModule.__beginRecoverySpy.mockImplementationOnce(() => {
        throw new Error("recovery record unavailable")
      })
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
        success: false,
        error: expect.stringContaining("recovery record unavailable"),
      })
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
    })

    it("arms recovery before commit and clears it only after finalization", async () => {
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        mockGetStoreState().plugins["plugin-a"].manifest.version = "2.0.0"
      })
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: true })
      expect(backupModule.__beginRecoverySpy).toHaveBeenCalledWith("plugin-a-before-update")
      expect(backupModule.__beginRecoverySpy.mock.invocationCallOrder[0]).toBeLessThan(
        commitStagedPluginUpdate.mock.invocationCallOrder[0]
      )
      expect(finalizeStagedPluginUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        backupModule.__completeRecoverySpy.mock.invocationCallOrder[0]
      )
    })
    it("refuses network widening before backup or mutation (U15)", async () => {
      const state = mockGetStoreState()
      state.plugins["plugin-a"].manifest.networkAccess = { allowedDomains: ["api.example.com"] }
      stagePluginUpdate.mockImplementationOnce(async () => ({
        transactionId: "network-update",
        pluginId: "plugin-a",
        version: "2.0.0",
        stagedPath: "/staged",
        manifest: {
          ...state.plugins["plugin-a"].manifest,
          version: "2.0.0",
          networkAccess: { allowedDomains: ["*"] },
        },
      }))
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
        success: false,
        error: expect.stringContaining("PLUGIN_UPDATE_PERMISSION_REVIEW_REQUIRED"),
      })
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
      expect(backupModule.__createBackupSpy).not.toHaveBeenCalled()
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
    })

    it.each(["enabled", "disabled", "error"] as const)(
      "never commits over a dirty %s runtime (U16)",
      async (status) => {
        mockGetStoreState().plugins["plugin-a"].status = status
        managerModule.__hasUnresolvedActivationResourcesSpy.mockReturnValue(true)
        const result = await updater.installUpdate("plugin-a", "2.0.0")
        expect(result).toMatchObject({
          success: false,
          requiresRestart: true,
          error: expect.stringMatching(/restart/i),
        })
        expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
        expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
        expect(backupModule.__restoreBackupSpy).not.toHaveBeenCalled()
      }
    )

    it("checks unresolved resources after a resolved teardown (U16)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "enabled"
      managerModule.__unloadPluginSpy.mockImplementationOnce(async () => {
        mockGetStoreState().plugins["plugin-a"].status = "disabled"
        managerModule.__hasUnresolvedActivationResourcesSpy.mockReturnValue(true)
      })
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
        success: false,
        requiresRestart: true,
      })
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
    })

    it("tears down a plugin enabled during staging before committing (U18)", async () => {
      const state = mockGetStoreState()
      backupModule.__createBackupSpy.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].status = "enabled"
        return { success: true, backup: { id: "before-enable" } }
      })
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        expect(state.plugins["plugin-a"].status).toBe("installed")
        state.plugins["plugin-a"].manifest.version = "2.0.0"
      })
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: true })
      expect(managerModule.__unloadPluginSpy).toHaveBeenCalledTimes(1)
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledTimes(1)
    })

    it("aborts if activation moved back to a live state before commit (U18)", async () => {
      managerModule.__unloadPluginSpy.mockImplementationOnce(async () => {
        mockGetStoreState().plugins["plugin-a"].status = "enabling"
      })
      mockGetStoreState().plugins["plugin-a"].status = "enabled"
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
        success: false,
        requiresRestart: true,
      })
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
    })

    it("leaves a dirty rollback pending with its transaction and backup intact (U17)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        mockGetStoreState().plugins["plugin-a"].manifest.version = "2.0.0"
      })
      managerModule.__enablePluginSpy.mockImplementationOnce(async () => {
        managerModule.__hasUnresolvedActivationResourcesSpy.mockReturnValue(true)
        throw new Error("Activation left a worker alive")
      })
      const result = await updater.installUpdate("plugin-a", "2.0.0")
      expect(result).toMatchObject({
        success: false,
        requiresRestart: true,
        rollback: {
          attempted: true,
          succeeded: false,
          error: expect.stringMatching(/pending restore.*plugin-a-before-update/i),
        },
      })
      expect(backupModule.__restoreBackupSpy).not.toHaveBeenCalled()
      expect(finalizeStagedPluginUpdate).not.toHaveBeenCalled()
      expect(discardStagedPluginUpdate).not.toHaveBeenCalled()
    })

    it("fails an unavailable explicit version instead of substituting the new pending version (U19)", async () => {
      await updater.checkForUpdates(["plugin-a"])
      expect(await updater.update("plugin-a", { version: "1.5.0" })).toMatchObject({
        success: false,
        newVersion: "1.5.0",
        error: expect.stringContaining("Version 1.5.0 is not available"),
      })
      expect(stagePluginUpdate).not.toHaveBeenCalled()
    })

    it("keeps the requested version when the pending offer changes from A to B (U19)", async () => {
      const [reviewed] = await updater.checkForUpdates(["plugin-a"])
      cogniaGetPlugin.mockResolvedValueOnce({ latestVersion: "3.0.0" })
      await updater.checkForUpdates(["plugin-a"])
      expect(updater.getPendingUpdates()[0].latestVersion).toBe("3.0.0")
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        mockGetStoreState().plugins["plugin-a"].manifest.version = "2.0.0"
      })
      expect(await updater.update("plugin-a", { version: reviewed.latestVersion })).toMatchObject({
        success: true,
        newVersion: "2.0.0",
      })
      expect(stagePluginUpdate).toHaveBeenCalledWith(
        "plugin-a",
        expect.objectContaining({ version: "2.0.0" })
      )
    })

    it("rejects staged bytes labeled with a different version (U19)", async () => {
      stagePluginUpdate.mockResolvedValueOnce({ version: "3.0.0", manifest: { version: "3.0.0" } })
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
        success: false,
        error: expect.stringContaining("requested version 2.0.0"),
      })
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
    })
    it("should attempt to update a plugin", async () => {
      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.pluginId).toBe("plugin-a")
      expect(typeof result.success).toBe("boolean")
    })

    it("should return error for non-pending updates without force", async () => {
      const result = await updater.update("plugin-a")

      expect(result.success).toBe(false)
      expect(result.error).toBe("No pending update found")
    })

    it("should update all pending plugins", async () => {
      const results = await updater.updateAll()

      expect(Array.isArray(results)).toBe(true)
    })

    it("installUpdate installs the requested version via update()", async () => {
      const result = await updater.installUpdate("plugin-a", "2.0.0")

      expect(result.pluginId).toBe("plugin-a")
      expect(result.newVersion).toBe("2.0.0")
    })

    it("unloads an active plugin before commit and re-enables it after verification", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.success).toBe(true)
      expect(managerModule.__disablePluginSpy).toHaveBeenCalledWith(
        "plugin-a",
        "transactional-update"
      )
      expect(managerModule.__unloadPluginSpy).toHaveBeenCalledWith("plugin-a")
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledWith(
        "plugin-a",
        "transactional-update"
      )
      expect(managerModule.__reservePluginRuntimeGraphSpy).toHaveBeenCalledWith("plugin-a")
      expect(managerModule.__releasePluginRuntimeGraphSpy).toHaveBeenCalledTimes(1)
      expect(managerModule.__unloadPluginSpy.mock.invocationCallOrder[0]).toBeLessThan(
        commitStagedPluginUpdate.mock.invocationCallOrder[0]
      )
      expect(stagePluginUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        backupModule.__createBackupSpy.mock.invocationCallOrder[0]
      )
      expect(proxyManagerModule.__stageManagedIdeProxySpy.mock.invocationCallOrder[0]).toBeLessThan(
        backupModule.__createBackupSpy.mock.invocationCallOrder[0]
      )
      expect(finalizeStagedPluginUpdate).toHaveBeenCalledTimes(1)
    })

    it("requires permission review before snapshot or commit when an update expands authority", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: Record<string, unknown>; status: string }>
      }
      state.plugins["plugin-a"].manifest.permissions = ["storage:read"]
      stagePluginUpdate.mockResolvedValueOnce({
        transactionId: "123e4567-e89b-42d3-a456-426614174000",
        pluginId: "plugin-a",
        version: "2.0.0",
        stagedPath: "/host-state/update-transactions/plugin-a/package",
        manifest: {
          id: "plugin-a",
          name: "Plugin A",
          version: "2.0.0",
          description: "Plugin A",
          type: "frontend",
          capabilities: [],
          main: "index.js",
          permissions: ["storage:read", "shell:execute"],
        },
        sizeBytes: 1024,
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("PLUGIN_UPDATE_PERMISSION_REVIEW_REQUIRED"),
      })
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
      expect(backupModule.__createBackupSpy).not.toHaveBeenCalled()
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
    })

    it("baselines legacy data at the installed version before committing an update", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<
          string,
          { manifest: import("@/types/plugin").PluginManifest; status: string }
        >
      }
      const dexie = {
        tables: [{ name: "items", schema: "id" }],
        migrations: [
          { toVersion: 1, upgrade: "old" },
          { toVersion: 2, upgrade: "upgrade" },
        ],
      }
      state.plugins["plugin-a"].manifest = { ...state.plugins["plugin-a"].manifest, dexie }
      state.plugins["plugin-a"].status = "enabled"
      const next = { ...state.plugins["plugin-a"].manifest, version: "2.0.0" }
      stagePluginUpdate.mockResolvedValueOnce({
        pluginId: "plugin-a",
        version: "2.0.0",
        manifest: next,
        transactionId: "legacy-update",
        stagedPath: "/staging/plugin-a",
        sizeBytes: 10,
      })
      const db = getDb()
      await db.pluginDexieMeta.put({
        pluginId: "plugin-a",
        tableNames: [],
        dexieVersion: 1,
        appliedAt: 1,
      })
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        expect((await db.table("pluginDexieMeta").get("plugin-a")).appliedMigrationVersion).toBe(1)
        state.plugins["plugin-a"].manifest = next
      })
      const old = jest.fn(async () => {
        throw new Error("Historical migration replayed")
      })
      const upgrade = jest.fn(async () => undefined)
      managerModule.__enablePluginSpy.mockImplementationOnce(async () => {
        await runPluginMigrations(db, "plugin-a", 2, dexie.migrations, { old, upgrade })
      })
      try {
        expect(await updater.update("plugin-a", { force: true, version: "2.0.0" })).toMatchObject({
          success: true,
        })
        expect(old).not.toHaveBeenCalled()
        expect(upgrade).toHaveBeenCalledTimes(1)
        expect((await db.table("pluginDexieMeta").get("plugin-a")).appliedMigrationVersion).toBe(2)
      } finally {
        await db.pluginDexieMeta.delete("plugin-a")
      }
    })

    it("review regression: surfaces migrated data incompatibility after restoring the old package", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<
          string,
          { manifest: import("@/types/plugin").PluginManifest; status: string; error?: string }
        >
      }
      const previous = state.plugins["plugin-a"].manifest
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest = { ...previous, version: "2.0.0" }
      })
      const db = getDb()
      managerModule.__enablePluginSpy.mockImplementationOnce(async () => {
        await db
          .table("pluginDexieMeta")
          .put({ pluginId: "plugin-a", tableNames: [], appliedMigrationVersion: 1 })
        await runPluginMigrations(db, "plugin-a", 2, [], {})
        throw new Error("v2 activation failed")
      })
      backupModule.__restoreBackupSpy.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest = previous
        return { success: true }
      })
      try {
        const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })
        expect(result).toMatchObject({
          success: false,
          requiresRestart: false,
          error: expect.stringMatching(
            /data was migrated to v2.*update to v2 or later.*clear plugin data/i
          ),
          rollback: {
            attempted: true,
            succeeded: false,
            error: expect.stringContaining("PluginDataVersionError"),
          },
        })
        // The bare message, so the plugin error classifier can localize it.
        expect(state.plugins["plugin-a"]).toMatchObject({
          status: "error",
          error: expect.stringMatching(/^Plugin "plugin-a" data was migrated to v2;/),
        })
        expect(managerModule.__enablePluginSpy).toHaveBeenCalledTimes(1)
      } finally {
        await db.pluginDexieMeta.delete("plugin-a")
      }
    })

    it("dry-runs the migration declaration before snapshotting a destructive schema change", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: Record<string, unknown>; status: string }>
      }
      state.plugins["plugin-a"].manifest.dexie = {
        tables: [{ name: "records", schema: "++id, createdAt" }],
      }
      stagePluginUpdate.mockResolvedValueOnce({
        transactionId: "123e4567-e89b-42d3-a456-426614174000",
        pluginId: "plugin-a",
        version: "2.0.0",
        stagedPath: "/host-state/update-transactions/plugin-a/package",
        manifest: {
          id: "plugin-a",
          name: "Plugin A",
          version: "2.0.0",
          description: "Plugin A",
          type: "frontend",
          capabilities: [],
          main: "index.js",
          dexie: {
            tables: [{ name: "records", schema: "++id, &externalId" }],
          },
        },
        sizeBytes: 1024,
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.error).toContain("PLUGIN_UPDATE_MIGRATION_REQUIRED")
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
      expect(backupModule.__createBackupSpy).not.toHaveBeenCalled()
    })

    it("activates the exact staged proxy after package commit", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
      })
      const artifact = { pluginId: "plugin-a", sha256: "proxy-v2" }
      proxyManagerModule.__stageManagedIdeProxySpy.mockResolvedValueOnce(artifact)

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.success).toBe(true)
      expect(codeServerClient.activateProxy).toHaveBeenCalledWith(artifact)
      expect(commitStagedPluginUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        (codeServerClient.activateProxy as jest.Mock).mock.invocationCallOrder[0]
      )
    })

    it("discards native ownership before backup restore after a committed update fails (B17)", async () => {
      const { PluginBackupManager } = jest.requireActual<typeof import("./backup")>("./backup")
      const backupPath = "/audit-b17-backups"
      const backups = new PluginBackupManager({ backupPath })
      const backupGetter = jest
        .spyOn(jest.requireMock("./backup"), "getPluginBackupManager")
        .mockReturnValue(backups)
      const state = mockGetStoreState()
      state.plugins["plugin-a"].path = "/plugins/plugin-a"
      state.plugins["plugin-a"].status = "enabled"
      const nativeInvoke = invoke as jest.Mock
      let ownedByTransaction = false
      nativeInvoke.mockImplementation(async (command) => {
        if (command === "plugin_backup_create") {
          return {
            backupId: "plugin-a-before-update",
            pluginId: "plugin-a",
            createdAt: "2026-11-10T00:00:00Z",
            sizeBytes: 1,
            path: "/backups/plugin-a-before-update",
          }
        }
        if (command === "plugin_commit_staged_update") ownedByTransaction = true
        if (command === "plugin_discard_staged_update") {
          expect(ownedByTransaction).toBe(true)
          ownedByTransaction = false
        }
        if (command === "plugin_backup_restore") {
          expect(ownedByTransaction).toBe(false)
          state.plugins["plugin-a"].manifest.version = "1.0.0"
        }
        if (command === "plugin_finalize_staged_update" && !ownedByTransaction) {
          throw new Error("installed package does not belong to this transaction")
        }
      })
      commitStagedPluginUpdate.mockImplementationOnce(async (staged) => {
        await invoke("plugin_commit_staged_update", {
          pluginId: staged.pluginId,
          transactionId: staged.transactionId,
        })
        state.plugins["plugin-a"].manifest.version = "2.0.0"
      })
      finalizeStagedPluginUpdate.mockImplementationOnce((staged) =>
        invoke("plugin_finalize_staged_update", {
          pluginId: staged.pluginId,
          transactionId: staged.transactionId,
        })
      )
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("proxy handshake failed"))

      try {
        const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })
        expect(result.error).toBe("proxy handshake failed")
        expect(result).toMatchObject({
          success: false,
          rollback: { attempted: true, succeeded: true },
        })
        expect(nativeInvoke.mock.calls.map(([command]) => command)).toEqual([
          "plugin_backup_create",
          "plugin_commit_staged_update",
          "plugin_discard_staged_update",
          "plugin_backup_restore",
        ])
        expect(nativeInvoke).toHaveBeenNthCalledWith(3, "plugin_discard_staged_update", {
          pluginId: "plugin-a",
          transactionId: "123e4567-e89b-42d3-a456-426614174000",
        })
        expect(backups.getPendingUpdateRestore("plugin-a", true)).toBeUndefined()
        expect(state.plugins["plugin-a"].manifest.version).toBe("1.0.0")
      } finally {
        backupGetter.mockRestore()
        nativeInvoke.mockReset()
        // The one-shot finalize implementation was deliberately never reached.
        finalizeStagedPluginUpdate.mockReset().mockResolvedValue(undefined)
        localStorage.removeItem(`plugin:backup:index:${backupPath}`)
      }
    })

    it("restores package and host state when live activation rejects the update", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })
      backupModule.__restoreBackupSpy.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "1.0.0"
        return { success: true }
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("proxy handshake failed"))

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: true, succeeded: true },
        requiresRestart: true,
      })
      expect(backupModule.__restoreBackupSpy).toHaveBeenCalledWith(
        "plugin-a-before-update",
        expect.objectContaining({ withPluginPackageMutation: expect.any(Function) })
      )
      // Native journal/backup ordering is covered by backup.test.ts; the
      // updater retains the durable obligation until restoration succeeds.
      expect(backupModule.__beginRecoverySpy).toHaveBeenCalledWith("plugin-a-before-update")
      expect(finalizeStagedPluginUpdate).not.toHaveBeenCalled()
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledTimes(1)
      expect(state.plugins["plugin-a"].manifest.version).toBe("1.0.0")
    })

    it("does not request a restart when the old package could not be restored", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("proxy handshake failed"))
      backupModule.__restoreBackupSpy.mockResolvedValueOnce({
        success: false,
        error: "backup checksum mismatch",
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        requiresRestart: false,
        rollback: {
          attempted: true,
          succeeded: false,
          error: expect.stringContaining("backup checksum mismatch"),
        },
      })
    })

    it("keeps the restored package inactive instead of resurrecting the old runtime", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })
      backupModule.__restoreBackupSpy.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "1.0.0"
        return { success: true }
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("new proxy rejected"))

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        requiresRestart: true,
        rollback: {
          attempted: true,
          succeeded: true,
        },
      })
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledTimes(1)
      expect(state.plugins["plugin-a"].manifest.version).toBe("1.0.0")
    })

    it("cancelUpdate clears a queued pending update", async () => {
      await updater.checkForUpdates(["plugin-a"])
      expect(updater.getPendingUpdates().map((u) => u.pluginId)).toContain("plugin-a")

      updater.cancelUpdate("plugin-a")
      expect(updater.getPendingUpdates().map((u) => u.pluginId)).not.toContain("plugin-a")
    })
  })

  describe("Install origin, runtime state and provenance (PL06–PL10)", () => {
    function commitBumpsVersion() {
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        mockGetStoreState().plugins["plugin-a"].manifest.version = "2.0.0"
      })
    }

    it.each<[string, PluginInstallOrigin | undefined]>([
      ["git", { kind: "git", url: "https://git.example/p.git", commit: "a".repeat(40) }],
      ["github", { kind: "github", owner: "o", repo: "r", commit: "b".repeat(40) }],
      ["local directory", { kind: "local", via: "directory" }],
      ["builtin", { kind: "builtin" }],
      ["unrecorded", undefined],
      [
        "another registry",
        { kind: "registry", registryUrl: "https://other.test/api", version: "1.0.0" },
      ],
    ])(
      "never asks this registry about a plugin installed from %s (PL06)",
      async (_label, origin) => {
        originOverrides.set("plugin-a", origin)
        expect(await updater.checkForUpdates()).toEqual([])
        expect(cogniaGetPlugin).not.toHaveBeenCalled()
      }
    )

    it("treats a trailing slash on the same registry as the same source (PL06)", async () => {
      originOverrides.set("plugin-a", {
        kind: "registry",
        registryUrl: `${REGISTRY_URL}/`,
        version: "1.0.0",
      })
      expect(await updater.checkForUpdates()).toEqual([
        expect.objectContaining({ pluginId: "plugin-a", latestVersion: "2.0.0" }),
      ])
    })

    it("refuses to replace a Git-installed plugin with a same-id registry release (PL06)", async () => {
      originOverrides.set("plugin-a", {
        kind: "git",
        url: "https://git.example/p.git",
        commit: "c".repeat(40),
      })
      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("installed from git"),
      })
      expect(stagePluginUpdate).not.toHaveBeenCalled()
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
    })

    it("auto-install leaves a Git-installed plugin alone (PL06)", async () => {
      originOverrides.set("plugin-a", {
        kind: "git",
        url: "https://git.example/p.git",
        commit: "d".repeat(40),
      })
      updater.configureAutoUpdate({
        enabled: false,
        checkInterval: 3600000,
        autoInstall: true,
        notifyOnly: false,
        excludePlugins: [],
        allowPrerelease: false,
      })
      await updater.runAutoUpdateOnce()
      expect(stagePluginUpdate).not.toHaveBeenCalled()
    })

    it("does not check a sideloaded .vsix against Open VSX (PL06)", async () => {
      mockGetStoreState.mockReturnValue({
        plugins: {
          "ns.ext": storePlugin({ id: "ns.ext", version: "1.0.0", type: "vscode-extension" }),
        },
      } as never)
      originOverrides.set("ns.ext", { kind: "local", via: "vsix" })
      const queryExtension = jest.fn()
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      expect(await updater.checkForUpdates()).toEqual([])
      expect(queryExtension).not.toHaveBeenCalled()
    })

    it("returns a loaded plugin to loaded, not enabled (PL07)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "loaded"
      commitBumpsVersion()
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: true })
      expect(managerModule.__unloadPluginSpy).toHaveBeenCalledTimes(1)
      expect(managerModule.__disablePluginSpy).not.toHaveBeenCalled()
      expect(managerModule.__loadPluginSpy).toHaveBeenCalledWith("plugin-a")
      expect(managerModule.__enablePluginSpy).not.toHaveBeenCalled()
    })

    it("returns an idle-suspended plugin to suspended (PL07)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "suspended"
      commitBumpsVersion()
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: true })
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledWith(
        "plugin-a",
        "transactional-update"
      )
      expect(managerModule.__suspendPluginSpy).toHaveBeenCalledWith(
        "plugin-a",
        "transactional-update"
      )
      expect(managerModule.__suspendPluginSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
        managerModule.__enablePluginSpy.mock.invocationCallOrder[0]
      )
    })

    it("does not activate a plugin that was installed but stopped (PL07)", async () => {
      commitBumpsVersion()
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: true })
      expect(managerModule.__enablePluginSpy).not.toHaveBeenCalled()
      expect(managerModule.__loadPluginSpy).not.toHaveBeenCalled()
    })

    it("restarts the old runtime when the update fails before the package changed (PL08)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "enabled"
      backupModule.__beginRecoverySpy.mockImplementationOnce(() => {
        throw new Error("recovery record unavailable")
      })
      const result = await updater.installUpdate("plugin-a", "2.0.0")
      expect(result).toMatchObject({ success: false, requiresRestart: false })
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
      expect(managerModule.__disablePluginSpy).toHaveBeenCalledTimes(1)
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledWith(
        "plugin-a",
        "transactional-update-restore"
      )
      expect(managerModule.__enablePluginSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
        discardStagedPluginUpdate.mock.invocationCallOrder[0]
      )
    })

    it("asks for a restart when the untouched old runtime cannot be restarted (PL08)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "enabled"
      backupModule.__beginRecoverySpy.mockImplementationOnce(() => {
        throw new Error("recovery record unavailable")
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("activation refused"))
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({
        success: false,
        requiresRestart: true,
        error: expect.stringContaining("restore previous runtime: activation refused"),
      })
    })

    it("records the registry release it installed as the plugin's origin (PL10)", async () => {
      cogniaGetVersions.mockResolvedValue([
        { version: "2.0.0", publishedAt: new Date(), downloadUrl: "https://x", checksum: "abc" },
      ])
      commitBumpsVersion()
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: true })
      expect(recordOriginSpy).toHaveBeenCalledWith({
        pluginId: "plugin-a",
        version: "2.0.0",
        origin: {
          kind: "registry",
          registryUrl: REGISTRY_URL,
          version: "2.0.0",
          checksum: "abc",
        },
      })
      expect(recordOriginSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
        finalizeStagedPluginUpdate.mock.invocationCallOrder[0]
      )
    })

    it("keeps the old origin when the update is rolled back (PL10)", async () => {
      mockGetStoreState().plugins["plugin-a"].status = "enabled"
      commitBumpsVersion()
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("activation rejected"))
      expect(await updater.installUpdate("plugin-a", "2.0.0")).toMatchObject({ success: false })
      expect(recordOriginSpy).not.toHaveBeenCalled()
    })
  })

  describe("Progress Handlers", () => {
    it("should add progress handler", () => {
      const handler = jest.fn()
      const unsubscribe = updater.onProgress(handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should remove progress handler", () => {
      const handler = jest.fn()
      const unsubscribe = updater.onProgress(handler)

      unsubscribe()
      // No error means success
    })
  })

  describe("Update History", () => {
    it("should get update history", () => {
      const history = updater.getUpdateHistory()
      expect(Array.isArray(history)).toBe(true)
    })

    it("should get update history for specific plugin", () => {
      const history = updater.getUpdateHistory("plugin-a")
      expect(Array.isArray(history)).toBe(true)
    })

    it("should clear update history", () => {
      updater.clearHistory()
      expect(updater.getUpdateHistory().length).toBe(0)
    })
  })

  describe("Auto Update", () => {
    it("should configure auto update", () => {
      updater.configureAutoUpdate({
        enabled: true,
        checkInterval: 3600000,
        autoInstall: false,
        notifyOnly: true,
        excludePlugins: [],
        allowPrerelease: false,
      })
      // No error means success
      updater.stopAutoUpdate()
    })

    it("should stop auto update", () => {
      updater.configureAutoUpdate({
        enabled: true,
        checkInterval: 3600000,
        autoInstall: false,
        notifyOnly: true,
        excludePlugins: [],
        allowPrerelease: false,
      })
      updater.stopAutoUpdate()
      // No error means success
    })
  })

  describe("Auto Update and cogset pins (ADR-0209)", () => {
    const updates = [
      { pluginId: "pinned", currentVersion: "1.0.0", latestVersion: "1.1.0" },
      { pluginId: "free", currentVersion: "1.0.0", latestVersion: "1.1.0" },
      { pluginId: "pinned-to-latest", currentVersion: "1.0.0", latestVersion: "2.0.0" },
    ]
    const pins = new Map([
      ["pinned", { cogsetId: "c", cogsetName: "Writing", pinnedVersion: "1.0.0" }],
      ["pinned-to-latest", { cogsetId: "c", cogsetName: "Writing", pinnedVersion: "2.0.0" }],
    ])

    function pinnedUpdater(resolve = async () => pins) {
      const u = makeUpdater({ resolveCogsetPins: resolve })
      jest.spyOn(u, "checkForUpdates").mockResolvedValue(updates)
      const install = jest.spyOn(u, "update").mockResolvedValue({ success: true } as never)
      const events: Array<{ pluginId: string; pinned: boolean }[]> = []
      const listener = (event: Event) =>
        events.push(
          (
            event as CustomEvent<{ updates: Array<{ pluginId: string; pinnedByCogset?: unknown }> }>
          ).detail.updates.map((x) => ({ pluginId: x.pluginId, pinned: !!x.pinnedByCogset }))
        )
      window.addEventListener(PLUGIN_UPDATES_AVAILABLE_EVENT, listener)
      return {
        u,
        install,
        events,
        done: () => window.removeEventListener(PLUGIN_UPDATES_AVAILABLE_EVENT, listener),
      }
    }

    const config = (autoInstall: boolean) => ({
      enabled: false,
      checkInterval: 3600000,
      autoInstall,
      notifyOnly: !autoInstall,
      excludePlugins: [],
      allowPrerelease: false,
    })

    it("auto-install skips an update that would break a pin and offers it instead", async () => {
      const t = pinnedUpdater()
      t.u.configureAutoUpdate(config(true))
      await t.u.runAutoUpdateOnce()
      expect(t.install.mock.calls.map((call) => call[0])).toEqual(["free", "pinned-to-latest"])
      expect(t.events).toEqual([[{ pluginId: "pinned", pinned: true }]])
      t.done()
    })

    it("notify-only marks pinned updates in the notification", async () => {
      const t = pinnedUpdater()
      t.u.configureAutoUpdate(config(false))
      await t.u.runAutoUpdateOnce()
      expect(t.install).not.toHaveBeenCalled()
      expect(t.events).toEqual([
        [
          { pluginId: "pinned", pinned: true },
          { pluginId: "free", pinned: false },
          { pluginId: "pinned-to-latest", pinned: false },
        ],
      ])
      t.done()
    })

    it("holds everything when the pins cannot be read", async () => {
      const t = pinnedUpdater(async () => {
        throw new Error("db closed")
      })
      t.u.configureAutoUpdate(config(true))
      await t.u.runAutoUpdateOnce()
      expect(t.install).not.toHaveBeenCalled()
      expect(t.events[0]).toHaveLength(3)
      t.done()
    })
  })

  describe("Configuration", () => {
    it("should have default configuration", () => {
      const newUpdater = new PluginUpdater()
      expect(newUpdater).toBeDefined()
    })

    it("should accept custom configuration", () => {
      const newUpdater = new PluginUpdater({
        autoCheck: true,
        checkIntervalMs: 60000,
      })
      expect(newUpdater).toBeDefined()
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginUpdater()
    const instance1 = getPluginUpdater()
    const instance2 = getPluginUpdater()
    expect(instance1).toBe(instance2)
  })
})
