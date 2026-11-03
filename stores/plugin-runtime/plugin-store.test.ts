/**
 * @jest-environment jsdom
 */

import { invoke } from "@tauri-apps/api/core"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn().mockResolvedValue(undefined) }))

const applyPolicyMock = jest.fn()
jest.mock("@/lib/plugin/core/policy-runtime", () => ({
  applyPluginPolicyToRuntime: (...args: unknown[]) => applyPolicyMock(...args),
}))

import {
  activatePluginAccountStorage,
  clearPluginAccountStorage,
  flushPluginPersistence,
  normalizePersistedPluginStatus,
  pluginAccountStorageKey,
  purgePluginAccountStorage,
  usePluginStore,
} from "./plugin-store"
import { PERSIST_COALESCE_MAX_WAIT_MS } from "@/stores/persist-storage"
import * as barrel from "./"
import type { PluginStatus } from "@/types/plugin/plugin"

it("barrel re-exports usePluginStore", () => {
  expect(barrel.usePluginStore).toBe(usePluginStore)
})

describe("normalizePersistedPluginStatus", () => {
  // Only `installed` / `disabled` are recoverable by the
  // rehydrate → rediscover → activate path. Persisting any transient or error
  // status verbatim leaves a built-in plugin permanently stuck after restart
  // ("cannot be loaded from status: error"). User-disabled intent is preserved;
  // everything else collapses to `installed`.
  it("preserves the explicit user-disabled resting state", () => {
    expect(normalizePersistedPluginStatus("disabled")).toBe("disabled")
  })

  it("keeps an already-installed plugin installed", () => {
    expect(normalizePersistedPluginStatus("installed")).toBe("installed")
  })

  it("collapses the error status to installed so the plugin can recover", () => {
    expect(normalizePersistedPluginStatus("error")).toBe("installed")
  })

  it.each<PluginStatus>([
    "discovered",
    "loading",
    "loaded",
    "enabling",
    "enabled",
    "disabling",
    "suspended",
    "unloading",
    "updating",
  ])("collapses the transient %s status to installed", (status) => {
    expect(normalizePersistedPluginStatus(status)).toBe("installed")
  })
})

describe("persist migration (v1 -> v2)", () => {
  // Regression: a built-in plugin persisted in `status: "error"` by an older
  // build could never recover — every restart re-threw
  // "cannot be loaded from status: error". The v2 migration heals it back to a
  // loadable resting state on rehydrate.
  it("heals a non-recoverable persisted status on rehydrate", async () => {
    window.localStorage.setItem(
      "cognia-plugins",
      JSON.stringify({
        version: 1,
        state: {
          plugins: {
            "cognia-clipboard-tools": {
              manifest: { id: "cognia-clipboard-tools", name: "Clipboard Tools" },
              status: "error",
              source: "builtin",
              path: "builtin://cognia-clipboard-tools",
              config: {},
            },
            "user-disabled-plugin": {
              manifest: { id: "user-disabled-plugin", name: "Disabled" },
              status: "disabled",
              source: "local",
              path: "/tmp/disabled",
              config: {},
            },
          },
        },
      })
    )

    await usePluginStore.persist.rehydrate()

    const plugins = usePluginStore.getState().plugins
    expect(plugins["cognia-clipboard-tools"].status).toBe("installed")
    // User-disabled intent must be preserved through the migration.
    expect(plugins["user-disabled-plugin"].status).toBe("disabled")

    window.localStorage.clear()
  })
})

describe("LocalProfile persistence", () => {
  afterEach(() => {
    clearPluginAccountStorage()
    // Land the clear's coalesced write before wiping, as the old synchronous
    // write did; otherwise it lands on the next test's planted snapshot.
    flushPluginPersistence()
    window.localStorage.clear()
  })

  it("does not carry remembered permissions between accounts", () => {
    window.localStorage.setItem(
      pluginAccountStorageKey("acct_a"),
      JSON.stringify({ version: 2, state: { rememberedPermissions: { demo: { shell: "allow" } } } })
    )
    window.localStorage.setItem(
      pluginAccountStorageKey("acct_b"),
      JSON.stringify({ version: 2, state: { rememberedPermissions: {} } })
    )

    activatePluginAccountStorage("acct_a")
    expect(usePluginStore.getState().rememberedPermissions.demo).toBeDefined()
    activatePluginAccountStorage("acct_b")
    expect(usePluginStore.getState().rememberedPermissions.demo).toBeUndefined()
  })

  it("revokes global grants and disables third-party plugins during legacy adoption", () => {
    window.localStorage.setItem(
      "cognia-plugins",
      JSON.stringify({
        version: 2,
        state: {
          rememberedPermissions: { demo: { "shell:execute": "allow" } },
          plugins: {
            builtin: { manifest: { id: "builtin" }, source: "builtin", status: "enabled" },
            demo: { manifest: { id: "demo" }, source: "local", status: "enabled" },
          },
        },
      })
    )

    activatePluginAccountStorage("acct_a")

    expect(usePluginStore.getState().rememberedPermissions).toEqual({})
    expect(usePluginStore.getState().plugins.builtin.status).toBe("installed")
    expect(usePluginStore.getState().plugins.demo.status).toBe("disabled")
    expect(window.localStorage.getItem("cognia-plugins")).toBeNull()
  })
})

describe("coalesced persistence", () => {
  const writesTo = (spy: jest.SpyInstance, key: string) =>
    spy.mock.calls.filter(([name]) => name === key).length
  const persistedPolicy = (key: string) =>
    JSON.parse(window.localStorage.getItem(key) ?? "null")?.state?.globalPermissionPolicy
  let setItem: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    window.localStorage.clear()
    setItem = jest.spyOn(Storage.prototype, "setItem")
  })

  afterEach(() => {
    clearPluginAccountStorage()
    flushPluginPersistence()
    setItem.mockRestore()
    jest.useRealTimers()
    window.localStorage.clear()
  })

  it("writes a burst of store changes as one snapshot", () => {
    activatePluginAccountStorage("acct_burst")
    const key = pluginAccountStorageKey("acct_burst")
    jest.advanceTimersByTime(PERSIST_COALESCE_MAX_WAIT_MS)
    setItem.mockClear()

    for (const policy of ["allow", "deny", "ask", "allow", "deny"] as const) {
      usePluginStore.setState({ globalPermissionPolicy: policy })
    }
    expect(writesTo(setItem, key)).toBe(0)

    jest.advanceTimersByTime(PERSIST_COALESCE_MAX_WAIT_MS)
    expect(writesTo(setItem, key)).toBe(1)
    expect(persistedPolicy(key)).toBe("deny")
  })

  it("lands the outgoing account's pending change under its own key when switching", () => {
    activatePluginAccountStorage("acct_from")
    usePluginStore.setState({ globalPermissionPolicy: "deny" })

    activatePluginAccountStorage("acct_to")

    expect(persistedPolicy(pluginAccountStorageKey("acct_from"))).toBe("deny")
    // The incoming account starts from its own (empty) snapshot, not the
    // outgoing account's pending state.
    expect(usePluginStore.getState().globalPermissionPolicy).toBe("ask")
  })

  it("keeps the signed-out account's latest change on disk when clearing", () => {
    activatePluginAccountStorage("acct_out")
    usePluginStore.setState({ globalPermissionPolicy: "allow" })

    clearPluginAccountStorage()

    expect(persistedPolicy(pluginAccountStorageKey("acct_out"))).toBe("allow")
  })

  it("does not resurrect a purged account's key from a pending write", () => {
    activatePluginAccountStorage("acct_purge")
    const key = pluginAccountStorageKey("acct_purge")
    usePluginStore.setState({ globalPermissionPolicy: "deny" })

    purgePluginAccountStorage("acct_purge")
    jest.advanceTimersByTime(PERSIST_COALESCE_MAX_WAIT_MS)

    expect(window.localStorage.getItem(key)).toBeNull()
  })
})

describe("usePluginStore", () => {
  it("exposes getAllModes() returning an empty list (stub)", () => {
    const fn = usePluginStore.getState().getAllModes
    expect(typeof fn).toBe("function")
    expect(fn()).toEqual([])
  })

  it("returns the same empty array shape on repeated calls", () => {
    const first = usePluginStore.getState().getAllModes()
    const second = usePluginStore.getState().getAllModes()
    expect(first).toEqual([])
    expect(second).toEqual([])
  })

  it("initialize() hydrates the persisted policy into the runtime", async () => {
    applyPolicyMock.mockClear()
    window.localStorage.setItem(
      "cognia.plugins.policy",
      JSON.stringify({ governance: "block", signatureRequired: true, autoUpdate: true })
    )

    await usePluginStore.getState().initialize("/tmp/plugins")

    expect(applyPolicyMock).toHaveBeenCalledWith({
      governance: "block",
      signatureRequired: true,
      autoUpdate: true,
    })

    window.localStorage.clear()
  })

  it("initialize() defaults policy flags when localStorage has no blob", async () => {
    applyPolicyMock.mockClear()
    window.localStorage.clear()

    await usePluginStore.getState().initialize("/tmp/plugins")

    // ADR 0016 P0-3: signatureRequired is default-on; autoUpdate stays off.
    expect(applyPolicyMock).toHaveBeenCalledWith({
      governance: "warn",
      signatureRequired: true,
      autoUpdate: false,
    })
  })
})

describe("independent plugin identity", () => {
  const manifest = {
    id: "independent-demo",
    name: "Demo",
    description: "Independent plugin fixture",
    version: "1.0.0",
    type: "frontend",
    main: "dist/index.js",
    capabilities: [],
    author: { name: "Test" },
  } as import("@/types/plugin").PluginManifest
  beforeEach(() => usePluginStore.getState().reset())

  it("keeps an independently installed version when the bundled fallback is rediscovered", () => {
    const store = usePluginStore.getState()
    store.discoverPlugin({ ...manifest, version: "2.0.0" }, "local", "/plugins/independent-demo")
    store.discoverPlugin(manifest, "builtin", "builtin://independent-demo")
    expect(usePluginStore.getState().plugins[manifest.id]).toMatchObject({
      source: "local",
      manifest: { version: "2.0.0" },
    })
  })

  it("uninstalls by canonical plugin id without sending the stored path", async () => {
    const store = usePluginStore.getState()
    store.discoverPlugin(manifest, "local", "/external/install/location")
    const mockInvoke = jest.mocked(invoke)
    mockInvoke.mockClear()

    await store.uninstallPlugin(manifest.id, { viaManager: false })

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith("plugin_uninstall", {
      pluginId: manifest.id,
    })
    expect(usePluginStore.getState().plugins[manifest.id]).toBeUndefined()
  })

  it("keeps a removed builtin absent across discovery and allows explicit reinstall", async () => {
    const store = usePluginStore.getState()
    store.discoverPlugin(manifest, "builtin", "builtin://independent-demo")
    await store.installPlugin(manifest.id)
    await store.uninstallPlugin(manifest.id, { viaManager: false, skipFileRemoval: true })
    const key = usePluginStore.persist.getOptions().name
    if (!key) throw new Error("Plugin persistence must have a storage key")
    // Writes are coalesced; read the key straight from disk only after a flush.
    flushPluginPersistence()
    const saved = window.localStorage.getItem(key)
    expect(saved).toContain('"removedPlugins":{"independent-demo":true}')
    usePluginStore.setState({ removedPlugins: {} })
    // Land that write first, then put the saved snapshot back on disk.
    flushPluginPersistence()
    window.localStorage.setItem(key, saved!)
    await usePluginStore.persist.rehydrate()
    store.discoverPlugin(manifest, "builtin", "builtin://independent-demo")
    expect(usePluginStore.getState().plugins[manifest.id]).toBeUndefined()
    store.discoverPlugin(manifest, "local", "/plugins/independent-demo")
    await store.installPlugin(manifest.id)
    expect(usePluginStore.getState().plugins[manifest.id].status).toBe("installed")
    expect(usePluginStore.getState().removedPlugins[manifest.id]).toBeUndefined()
  })
})
