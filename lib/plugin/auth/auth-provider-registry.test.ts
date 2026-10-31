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
import {
  __resetAuthRegistryForTesting,
  getProvider,
  registerAuthenticationProvider,
  releaseAuthProviderOwnership,
  setAuthProviderOwnershipStore,
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
    registerAuthenticationProvider(provider("other", "other-provider"))()
    __resetAuthRegistryForTesting()
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
