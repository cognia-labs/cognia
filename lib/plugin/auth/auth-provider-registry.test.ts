/** @jest-environment jsdom */

import Dexie from "dexie"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"
import {
  __resetPluginRuntimeForTesting,
  installPluginRuntimeShims,
} from "@/cli/src/plugin/plugin-runtime"
import { uninstallHostPlugin } from "@/cli/src/plugin/host"
import { isValidPluginId } from "@/lib/plugin/core/validation"
import {
  __resetAuthRegistryForTesting,
  claimAuthProviderOwnership,
  getProvider,
  getAuthProviderOwner,
  hasAuthProviderOwnership,
  registerAuthenticationProvider,
  releaseAuthProviderOwnership,
  setAuthProviderOwnershipStore,
  subscribeAuthProviders,
  getAuthProviderRevision,
  unregisterAuthenticationProvider,
  unregisterProvidersByPlugin,
  type AuthenticationProvider,
} from "./auth-provider-registry"

const provider = (pluginId: string | null, id = "acme"): AuthenticationProvider => ({
  id,
  label: "Acme",
  pluginId,
  getSessions: async () => [],
  createSession: async () => {
    throw new Error("No interactive session in this fixture")
  },
  removeSession: async () => {},
})

it("notifies Settings of provider registration and removal even without connections", () => {
  setAuthProviderOwnershipStore({ read: () => null, write: () => {} })
  __resetAuthRegistryForTesting()
  const listener = jest.fn()
  const stop = subscribeAuthProviders(listener)
  const before = getAuthProviderRevision()
  const dispose = registerAuthenticationProvider(provider("owner", "settings"))
  expect(getAuthProviderRevision()).toBe(before + 1)
  dispose()
  expect(getAuthProviderRevision()).toBe(before + 2)
  expect(listener).toHaveBeenCalledTimes(2)
  stop()
  unregisterAuthenticationProvider("settings")
  expect(listener).toHaveBeenCalledTimes(2)
  setAuthProviderOwnershipStore(null)
})

describe("host auth provider ownership", () => {
  beforeEach(() => {
    setAuthProviderOwnershipStore(null)
    localStorage.clear()
    __resetAuthRegistryForTesting()
  })
  afterEach(() => {
    __resetAuthRegistryForTesting()
    setAuthProviderOwnershipStore(null)
  })

  it("survives registry restarts and protects unrelated owners during uninstall", () => {
    registerAuthenticationProvider(provider("owner"))()
    expect(hasAuthProviderOwnership("owner")).toBe(true)
    expect(hasAuthProviderOwnership("unrelated")).toBe(false)
    registerAuthenticationProvider(provider("other", "other-provider"))()
    __resetAuthRegistryForTesting()
    expect(getAuthProviderOwner("acme")).toBe("owner")
    expect(getAuthProviderOwner("other-provider")).toBe("other")
    expect(getAuthProviderOwner("missing")).toBeUndefined()
    expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
      /owned by another plugin/
    )
    releaseAuthProviderOwnership("owner")
    expect(() => registerAuthenticationProvider(provider("squatter"))).not.toThrow()
    expect(() => registerAuthenticationProvider(provider("squatter", "other-provider"))).toThrow(
      /owned by another plugin/
    )
  })

  it("fails closed when ownership cannot be persisted", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full")
    })
    try {
      expect(() => registerAuthenticationProvider(provider("owner"))).toThrow("Storage full")
      expect(getProvider("acme")).toBeUndefined()
    } finally {
      setItem.mockRestore()
    }
  })

  it("runs complete ownership claims and release inside a durable store transaction", () => {
    let raw: string | null = null
    const read = jest.fn(() => {
      throw new Error("unlocked read")
    })
    const write = jest.fn(() => {
      throw new Error("unlocked write")
    })
    const update = jest.fn((transform: (raw: string | null) => string | null) => {
      raw = transform(raw)
    })
    setAuthProviderOwnershipStore({ read, write, update })
    claimAuthProviderOwnership("acme", "owner")
    claimAuthProviderOwnership("other", "other-owner")
    expect(() => claimAuthProviderOwnership("acme", "squatter")).toThrow("owned by another plugin")
    releaseAuthProviderOwnership("owner")
    expect(JSON.parse(raw!)).toEqual([["other", "other-owner"]])
    expect(update).toHaveBeenCalledTimes(4)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it("fails closed when the durable index assigns one provider conflicting owners", () => {
    const write = jest.fn()
    setAuthProviderOwnershipStore({
      read: () =>
        JSON.stringify([
          ["acme", "owner"],
          ["acme", "other-owner"],
        ]),
      write,
    })

    expect(() => registerAuthenticationProvider(provider("owner"))).toThrow(
      "has conflicting owners"
    )
    expect(getProvider("acme")).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it("does not persist host ownership and refuses a plugin while the host provider is live", () => {
    const read = jest.fn(() => null)
    const write = jest.fn()
    setAuthProviderOwnershipStore({ read, write })
    const host = provider(null)
    const dispose = registerAuthenticationProvider(host)
    try {
      expect(read).toHaveBeenCalledTimes(1)
      expect(write).not.toHaveBeenCalled()
      expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
        "owned by another plugin"
      )
      expect(getProvider("acme")).toBe(host)
      expect(write).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it("fails closed without an injected store or localStorage", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined })
    try {
      expect(() => registerAuthenticationProvider(provider("owner"))).toThrow(
        "storage is unavailable"
      )
      expect(getProvider("acme")).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor)
    }
  })

  it("uses the injected store synchronously and restores the browser default", () => {
    let owners: string | null = null
    setAuthProviderOwnershipStore({
      read: () => owners,
      write: (value) => {
        owners = value
      },
    })
    registerAuthenticationProvider(provider("owner"))()
    expect(owners).toBe(JSON.stringify([["acme", "owner"]]))
    expect(localStorage.length).toBe(0)
    __resetAuthRegistryForTesting()
    expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
      /owned by another plugin/
    )

    setAuthProviderOwnershipStore(null)
    registerAuthenticationProvider(provider("browser-owner"))()
    expect(localStorage.length).toBe(1)
  })

  it.each(["read", "write"])("fails closed if the injected store cannot %s", (operation) => {
    setAuthProviderOwnershipStore({
      read: () => {
        if (operation === "read") throw new Error("Disk unavailable")
        return null
      },
      write: () => {
        throw new Error("Disk unavailable")
      },
    })
    expect(() => registerAuthenticationProvider(provider("owner"))).toThrow("Disk unavailable")
    expect(getProvider("acme")).toBeUndefined()
    expect(localStorage.length).toBe(0)
  })

  it("restores headless ownership from disk until the CLI uninstalls the owner", async () => {
    const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!
    const dependencies = { ...Dexie.dependencies }
    const previousHome = process.env.COGNIA_HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-auth-owners-"))
    process.env.COGNIA_HOME = home
    try {
      const firstProcess: Record<string, unknown> = {}
      await installFakeIndexedDb(firstProcess)
      installPluginRuntimeShims(firstProcess)
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: firstProcess.localStorage,
      })
      registerAuthenticationProvider(provider("owner"))()
      __resetAuthRegistryForTesting()
      expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
        /owned by another plugin/
      )

      // Fresh process globals and registry; only plugin-state.json is shared.
      __resetPluginRuntimeForTesting()
      const nextProcess: Record<string, unknown> = {}
      await installFakeIndexedDb(nextProcess)
      installPluginRuntimeShims(nextProcess)
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: nextProcess.localStorage,
      })
      __resetAuthRegistryForTesting()
      expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
        /owned by another plugin/
      )
      expect(getProvider("acme")).toBeUndefined()

      const dir = path.join(home, "plugins", "owner")
      fs.mkdirSync(dir, { recursive: true })
      await uninstallHostPlugin("owner", dir, {
        manager: { unloadPlugin: async () => {} },
      })
      expect(fs.existsSync(dir)).toBe(false)
      __resetPluginRuntimeForTesting()
      installPluginRuntimeShims({})
      expect(() => registerAuthenticationProvider(provider("squatter"))).not.toThrow()
      expect(getProvider("acme")?.pluginId).toBe("squatter")
    } finally {
      __resetPluginRuntimeForTesting()
      Object.defineProperty(globalThis, "localStorage", storageDescriptor)
      Object.assign(Dexie.dependencies, dependencies)
      if (previousHome === undefined) delete process.env.COGNIA_HOME
      else process.env.COGNIA_HOME = previousHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("keeps the ownership index out of every plugin's ctx.storage key", () => {
    registerAuthenticationProvider(provider("owner"))()
    const key = localStorage.key(0)!
    const suffix = key.slice("cognia-plugin-storage:".length)
    expect(key.startsWith("cognia-plugin-storage:")).toBe(true)
    expect(isValidPluginId(suffix)).toBe(false)
  })

  it("fails closed on a corrupt durable index", () => {
    registerAuthenticationProvider(provider("owner"))()
    const key = localStorage.key(0)!
    localStorage.setItem(key, JSON.stringify([["acme", 123]]))
    expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
      /ownership storage is invalid/
    )
    expect(getProvider("acme")).toBeUndefined()
  })
})

jest.mock("./connection-manager", () => ({
  getConnectionManager: () => ({
    restoreProvider: mockRestoreProvider,
    markProviderUnavailable: mockMarkProviderUnavailable,
  }),
}))
const mockRestoreProvider = jest.fn(async (_id: string) => {})
const mockMarkProviderUnavailable = jest.fn(async (_id: string) => {})

it("coordinates registration, returned disposer and both explicit teardown APIs", async () => {
  setAuthProviderOwnershipStore({ read: () => null, write: () => {} })
  __resetAuthRegistryForTesting()
  mockRestoreProvider.mockClear()
  mockMarkProviderUnavailable.mockClear()
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const dispose = registerAuthenticationProvider(provider("owner", "lifecycle"))
  await flush()
  expect(mockRestoreProvider).toHaveBeenCalledWith("lifecycle")
  dispose()
  await flush()
  expect(mockMarkProviderUnavailable).toHaveBeenCalledWith("lifecycle")
  registerAuthenticationProvider(provider("owner", "explicit"))
  await flush()
  unregisterAuthenticationProvider("explicit")
  await flush()
  expect(mockMarkProviderUnavailable).toHaveBeenCalledWith("explicit")
  registerAuthenticationProvider(provider("owner", "by-plugin"))
  await flush()
  unregisterProvidersByPlugin("owner")
  await flush()
  expect(mockMarkProviderUnavailable).toHaveBeenCalledWith("by-plugin")
  __resetAuthRegistryForTesting()
  setAuthProviderOwnershipStore(null)
})

it("serializes a pending unregister before a provider replacement restore", async () => {
  setAuthProviderOwnershipStore({ read: () => null, write: () => {} })
  __resetAuthRegistryForTesting()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  mockMarkProviderUnavailable.mockImplementation(async (id) => {
    if (id === "serialized") {
      entered()
      await barrier
    }
  })
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  registerAuthenticationProvider(provider("owner", "serialized"))
  await flush()
  const previous = mockRestoreProvider.mock.calls.filter(([id]) => id === "serialized").length
  unregisterAuthenticationProvider("serialized")
  await started
  registerAuthenticationProvider(provider("owner", "serialized"))
  await flush()
  expect(mockRestoreProvider.mock.calls.filter(([id]) => id === "serialized")).toHaveLength(
    previous
  )
  release()
  await flush()
  expect(mockRestoreProvider.mock.calls.filter(([id]) => id === "serialized")).toHaveLength(
    previous + 1
  )
  mockMarkProviderUnavailable.mockImplementation(async () => {})
  __resetAuthRegistryForTesting()
  setAuthProviderOwnershipStore(null)
})
