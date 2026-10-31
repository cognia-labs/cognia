/** @jest-environment jsdom */

import Dexie from "dexie"
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"
import {
  __resetAuthRegistryForTesting,
  getProvider,
  registerAuthenticationProvider,
  releaseAuthProviderOwnership,
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
    localStorage.clear()
    __resetAuthRegistryForTesting()
  })
  afterEach(() => __resetAuthRegistryForTesting())

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

  it("retains headless ownership only for the process lifetime", async () => {
    const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!
    const dependencies = { ...Dexie.dependencies }
    try {
      const firstProcess: Record<string, unknown> = {}
      await installFakeIndexedDb(firstProcess)
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: firstProcess.localStorage,
      })
      registerAuthenticationProvider(provider("owner"))()
      __resetAuthRegistryForTesting()
      expect(() => registerAuthenticationProvider(provider("squatter"))).toThrow(
        /owned by another plugin/
      )

      // A new headless process installs fresh in-memory Storage (ES-09 follow-up).
      const nextProcess: Record<string, unknown> = {}
      await installFakeIndexedDb(nextProcess)
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: nextProcess.localStorage,
      })
      __resetAuthRegistryForTesting()
      expect(() => registerAuthenticationProvider(provider("squatter"))).not.toThrow()
      expect(getProvider("acme")?.pluginId).toBe("squatter")
    } finally {
      Object.defineProperty(globalThis, "localStorage", storageDescriptor)
      Object.assign(Dexie.dependencies, dependencies)
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
