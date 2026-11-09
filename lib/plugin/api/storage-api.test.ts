/** @jest-environment jsdom */
/**
 * Plugin Storage API Tests
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { upsertPlugin } from "@/lib/db/plugins"
import {
  serializeSources,
  restoreMultiSnapshot,
  type DbLike,
  type SnapshotSource,
} from "@/cli/src/db/snapshot"
let headless = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isHeadlessHost: () => headless,
}))

// Mock crypto-helpers to avoid Web Crypto API dependency in jsdom
jest.mock("./crypto-helpers", () => {
  // Simple XOR-based mock encryption for testing (not real crypto)
  const keys = new Map<string, string>()
  return {
    deriveKey: jest.fn(async (pluginId: string) => {
      const key = `mock-key-${pluginId}`
      keys.set(key, pluginId)
      return key
    }),
    deriveInstallKey: jest.fn(async (pluginId: string) => {
      const key = `mock-install-key-${pluginId}`
      keys.set(key, pluginId)
      return key
    }),
    encrypt: jest.fn(async (data: string, _key: string) => {
      return Buffer.from(data).toString("base64")
    }),
    decrypt: jest.fn(async (encrypted: string, _key: string) => {
      return Buffer.from(encrypted, "base64").toString("utf-8")
    }),
  }
})

import {
  createStorageAPI,
  clearPluginStorage,
  getAllPluginStorageUsage,
  purgePluginAccountData,
} from "./storage-api"
import {
  activatePluginRuntimeAccount,
  clearPluginRuntimeAccount,
} from "../security/account-runtime-gate"

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length
    },
  }
})()

Object.defineProperty(global, "localStorage", { value: localStorageMock })

describe("PluginStorageAPI", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    localStorageMock.clear()
    headless = false
    activatePluginRuntimeAccount("acct_storage_a")
  })

  describe("basic operations", () => {
    it("should set and get a value", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("key1", "value1")
      expect(await api.get("key1")).toBe("value1")
    })

    it("should return undefined for missing keys", async () => {
      const api = createStorageAPI("test-plugin")
      expect(await api.get("nonexistent")).toBeUndefined()
    })

    it("should support getOrDefault", async () => {
      const api = createStorageAPI("test-plugin")
      expect(await api.getOrDefault("missing", 42)).toBe(42)
      await api.set("exists", 99)
      expect(await api.getOrDefault("exists", 42)).toBe(99)
    })

    it("should handle complex objects", async () => {
      const api = createStorageAPI("test-plugin")
      const obj = { nested: { array: [1, 2, 3] }, flag: true }
      await api.set("complex", obj)
      expect(await api.get("complex")).toEqual(obj)
    })

    it("should remove a key", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("key1", "value1")
      expect(await api.has("key1")).toBe(true)
      await api.remove("key1")
      expect(await api.has("key1")).toBe(false)
      expect(await api.get("key1")).toBeUndefined()
    })

    it("should check key existence", async () => {
      const api = createStorageAPI("test-plugin")
      expect(await api.has("key1")).toBe(false)
      await api.set("key1", "value1")
      expect(await api.has("key1")).toBe(true)
    })

    it("should list all keys", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("a", 1)
      await api.set("b", 2)
      await api.set("c", 3)
      const keys = await api.keys()
      expect(keys).toHaveLength(3)
      expect(keys.sort()).toEqual(["a", "b", "c"])
    })

    it("should clear all storage for the plugin", async () => {
      const api = createStorageAPI("test-plugin")
      await api.set("a", 1)
      await api.set("b", 2)
      await api.clear()
      expect(await api.keys()).toHaveLength(0)
      expect(await api.get("a")).toBeUndefined()
    })
  })

  describe("browser storage failures", () => {
    it.each([
      new DOMException("Browser storage is full", "QuotaExceededError"),
      new DOMException("Browser storage is blocked", "SecurityError"),
      new Error("Browser write failed"),
    ])("rejects set with the original %s from setItem", async (error) => {
      const api = createStorageAPI("test-plugin")
      await api.set("checkpoint", { cursor: "previous" })
      jest.spyOn(localStorageMock, "setItem").mockImplementationOnce(() => {
        throw error
      })

      await expect(api.set("checkpoint", { cursor: "next" })).rejects.toBe(error)
      expect(await api.get("checkpoint")).toEqual({ cursor: "previous" })
    })

    it("rejects setSecure when the browser refuses the encrypted write", async () => {
      const api = createStorageAPI("test-plugin")
      const error = new DOMException("Browser storage is full", "QuotaExceededError")
      jest.spyOn(localStorageMock, "setItem").mockImplementationOnce(() => {
        throw error
      })

      await expect(api.setSecure("secret", "value")).rejects.toBe(error)
      expect(await api.has("secret")).toBe(false)
    })

    it.each(["remove", "delete"] as const)(
      "rejects %s with the original removeItem failure and retains the value",
      async (method) => {
        const api = createStorageAPI("test-plugin")
        await api.set("checkpoint", "previous")
        const error = new DOMException("Browser storage is blocked", "SecurityError")
        jest.spyOn(localStorageMock, "removeItem").mockImplementationOnce(() => {
          throw error
        })

        await expect(api[method]("checkpoint")).rejects.toBe(error)
        expect(await api.get("checkpoint")).toBe("previous")
      }
    )
  })

  describe("namespace isolation", () => {
    it.each(["get", "has", "keys", "remove", "delete", "clear", "uninstall"] as const)(
      "R2: %s works on adopted legacy values when migration runs out of origin quota",
      async (operation) => {
        const prefix = "cognia:plugin:storage:quota-legacy:"
        localStorageMock.setItem("cognia:plugin:storage-adoption:quota-legacy", "acct_storage_a")
        localStorageMock.setItem(prefix + "value", JSON.stringify("legacy"))
        jest.spyOn(localStorageMock, "setItem").mockImplementation(() => {
          throw new DOMException("Browser storage is full", "QuotaExceededError")
        })
        const api = createStorageAPI("quota-legacy")

        if (operation === "get") await expect(api.get("value")).resolves.toBe("legacy")
        else if (operation === "has") await expect(api.has("value")).resolves.toBe(true)
        else if (operation === "keys") await expect(api.keys()).resolves.toEqual(["value"])
        else {
          if (operation === "uninstall") clearPluginStorage("quota-legacy")
          else if (operation === "clear") await api.clear()
          else await api[operation]("value")
          expect(localStorageMock.getItem(prefix + "value")).toBeNull()
          await expect(api.get("value")).resolves.toBeUndefined()
        }
      }
    )

    it("R3: purges adopted legacy payloads and retains their ownership marker", async () => {
      const adoptionKey = "cognia:plugin:storage-adoption:purged%3Aplugin"
      const legacyPrefix = "cognia:plugin:storage:purged:plugin:"
      localStorageMock.setItem(adoptionKey, "acct_storage_a")
      localStorageMock.setItem(legacyPrefix + "plain", JSON.stringify("private"))
      localStorageMock.setItem(legacyPrefix + "secure", JSON.stringify("__encrypted:ciphertext"))
      localStorageMock.setItem(
        "cognia:plugin:account-storage:acct_storage_a:purged%3Aplugin:moved",
        "1"
      )
      localStorageMock.setItem("cognia:plugin:storage-adoption:other", "acct_storage_b")
      localStorageMock.setItem("cognia:plugin:storage:other:value", "2")
      localStorageMock.setItem("cognia:plugin:storage:unclaimed:value", "3")

      purgePluginAccountData("acct_storage_a")

      expect(localStorageMock.getItem(legacyPrefix + "plain")).toBeNull()
      expect(localStorageMock.getItem(legacyPrefix + "secure")).toBeNull()
      expect(
        localStorageMock.getItem(
          "cognia:plugin:account-storage:acct_storage_a:purged%3Aplugin:moved"
        )
      ).toBeNull()
      expect(localStorageMock.getItem(adoptionKey)).toBe("acct_storage_a")
      expect(localStorageMock.getItem("cognia:plugin:storage:other:value")).toBe("2")
      expect(localStorageMock.getItem("cognia:plugin:storage:unclaimed:value")).toBe("3")
      localStorageMock.setItem(legacyPrefix + "late", "4")
      activatePluginRuntimeAccount("acct_storage_b")
      await expect(createStorageAPI("purged:plugin").get("late")).resolves.toBeUndefined()
    })

    it("R2: accounts for unmoved data in quota checks and replaces legacy values without resurrection", async () => {
      const legacyPrefix = "cognia:plugin:storage:quota-replacement:"
      const scopedPrefix = "cognia:plugin:account-storage:acct_storage_a:quota-replacement:"
      const adoptionKey = "cognia:plugin:storage-adoption:quota-replacement"
      localStorageMock.setItem(adoptionKey, "acct_storage_a")
      localStorageMock.setItem(legacyPrefix + "large", JSON.stringify("x".repeat(2_000_000)))
      const api = createStorageAPI("quota-replacement")
      expect(await api.getUsage()).toBeGreaterThan(4_000_000)
      expect(getAllPluginStorageUsage()["quota-replacement"]).toBe(await api.getUsage())
      await expect(api.set("extra", "y".repeat(700_000))).rejects.toThrow(/storage limit/i)
      await api.set("large", "replacement")
      expect(localStorageMock.getItem(legacyPrefix + "large")).toBeNull()

      localStorageMock.setItem(legacyPrefix + "large", JSON.stringify("stale"))
      expect(await api.keys()).toEqual(["large"])
      expect(await api.get("large")).toBe("replacement")
      await api.remove("large")
      expect(localStorageMock.getItem(legacyPrefix + "large")).toBeNull()
      expect(localStorageMock.getItem(scopedPrefix + "large")).toBeNull()
      await expect(api.get("large")).resolves.toBeUndefined()
    })

    it("B01: isolates reads, keys, usage and clear across active LocalProfiles", async () => {
      const api = createStorageAPI("profile-plugin")
      await api.set("private", "profile-a")
      const usage = await api.getUsage()
      clearPluginRuntimeAccount()
      activatePluginRuntimeAccount("acct_storage_b")
      expect(await api.get("private")).toBeUndefined()
      expect(await api.keys()).toEqual([])
      expect(await api.getUsage()).toBe(0)
      expect(getAllPluginStorageUsage()).toEqual({})
      await api.set("other", "profile-b")
      clearPluginStorage("profile-plugin")
      activatePluginRuntimeAccount("acct_storage_a")
      expect(await api.get("private")).toBe("profile-a")
      expect(await api.getUsage()).toBe(usage)
      expect(await api.keys()).toEqual(["private"])
    })

    it("B01: adopts unscoped legacy data only into the first profile", async () => {
      const legacy = "cognia:plugin:storage:legacy-plugin:value"
      localStorageMock.setItem(legacy, JSON.stringify("legacy"))
      const api = createStorageAPI("legacy-plugin")
      expect(await api.get("value")).toBe("legacy")
      expect(localStorageMock.getItem(legacy)).toBeNull()
      activatePluginRuntimeAccount("acct_storage_b")
      expect(await api.get("value")).toBeUndefined()
      activatePluginRuntimeAccount("acct_storage_a")
      await api.clear()
      expect(await api.get("value")).toBeUndefined()
    })

    it("B01: every browser storage operation fails closed without an active account", async () => {
      const api = createStorageAPI("profile-plugin")
      clearPluginRuntimeAccount()
      const operations = [
        () => api.get("key"),
        () => api.getOrDefault("key", 1),
        () => api.set("key", 1),
        () => api.remove("key"),
        () => api.delete("key"),
        () => api.has("key"),
        () => api.keys(),
        () => api.clear(),
        () => api.getUsage(),
        () => api.setSecure("key", 1),
        () => api.getSecure("key"),
        () => api.isEncrypted("key"),
      ]
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow(/account/i)
      }
    })

    it("should isolate storage between plugins", async () => {
      const api1 = createStorageAPI("plugin-a")
      const api2 = createStorageAPI("plugin-b")

      await api1.set("shared-key", "from-a")
      await api2.set("shared-key", "from-b")

      expect(await api1.get("shared-key")).toBe("from-a")
      expect(await api2.get("shared-key")).toBe("from-b")
    })

    it("should not clear other plugin storage", async () => {
      const api1 = createStorageAPI("plugin-a")
      const api2 = createStorageAPI("plugin-b")

      await api1.set("key", "a")
      await api2.set("key", "b")

      await api1.clear()
      expect(await api1.get("key")).toBeUndefined()
      expect(await api2.get("key")).toBe("b")
    })

    it("should list only own keys", async () => {
      const api1 = createStorageAPI("plugin-a")
      const api2 = createStorageAPI("plugin-b")

      await api1.set("k1", 1)
      await api1.set("k2", 2)
      await api2.set("k3", 3)

      expect(await api1.keys()).toHaveLength(2)
      expect(await api2.keys()).toHaveLength(1)
    })
  })

  describe("storage limit", () => {
    it("B23: counts new values and replacements in UTF-16 bytes", async () => {
      const api = createStorageAPI("byte-quota")
      await expect(api.set("oversize", "x".repeat(2_700_000))).rejects.toThrow(/storage limit/i)
      await api.set("large", "x".repeat(2_000_000))
      await expect(api.set("extra", "y".repeat(700_000))).rejects.toThrow(/storage limit/i)
      await api.set("large", "small")
      await api.set("extra", "y".repeat(700_000))
      expect(await api.getUsage()).toBeLessThanOrEqual(5 * 1024 * 1024)
    })

    it("B24: serializes quota checks across API instances of the same namespace", async () => {
      const first = createStorageAPI("concurrent-quota")
      const second = createStorageAPI("concurrent-quota")
      const results = await Promise.allSettled([
        first.set("one", "x".repeat(2 * 1024 * 1024)),
        second.set("two", "y".repeat(2 * 1024 * 1024)),
      ])
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
      expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/storage limit/i)
      expect(await first.keys()).toEqual(["one"])
      await first.remove("one")
      await second.set("two", "y".repeat(2 * 1024 * 1024))
    })

    it("should throw when exceeding 5MB limit", async () => {
      const api = createStorageAPI("big-plugin")
      // Create a string that's close to 5MB (each char = 2 bytes in UTF-16)
      // 5MB = 5 * 1024 * 1024 = 5242880 bytes = ~2621440 chars
      const bigValue = "x".repeat(2_600_000)
      await api.set("big", bigValue)

      // A second large value should exceed the limit
      await expect(api.set("big2", bigValue)).rejects.toThrow(/storage limit/i)
    })
  })

  describe("getUsage", () => {
    it("should report approximate usage in bytes", async () => {
      const api = createStorageAPI("usage-plugin")
      expect(await api.getUsage()).toBe(0)

      await api.set("test", "hello")
      const usage = await api.getUsage()
      expect(usage).toBeGreaterThan(0)
    })
  })

  describe("clearPluginStorage", () => {
    it("should remove all storage for a specific plugin", async () => {
      const api = createStorageAPI("doomed")
      await api.set("a", 1)
      await api.set("b", 2)

      clearPluginStorage("doomed")
      expect(await api.keys()).toHaveLength(0)
    })

    it("should not affect other plugins", async () => {
      const api1 = createStorageAPI("safe")
      const api2 = createStorageAPI("doomed")
      await api1.set("key", "safe-value")
      await api2.set("key", "doomed-value")

      clearPluginStorage("doomed")
      expect(await api1.get("key")).toBe("safe-value")
    })
  })

  describe("getAllPluginStorageUsage", () => {
    it("should return usage per plugin", async () => {
      const api1 = createStorageAPI("plugin-x")
      const api2 = createStorageAPI("plugin-y")
      await api1.set("data", "some-data")
      await api2.set("data", "other-data")

      const usage = getAllPluginStorageUsage()
      expect(usage["plugin-x"]).toBeGreaterThan(0)
      expect(usage["plugin-y"]).toBeGreaterThan(0)
    })

    it("should return empty object when no plugins have storage", () => {
      const usage = getAllPluginStorageUsage()
      expect(Object.keys(usage)).toHaveLength(0)
    })
  })

  describe("secure storage (encryption)", () => {
    it("should setSecure and getSecure a value", async () => {
      const api = createStorageAPI("secure-plugin")
      await api.setSecure("secret", { token: "abc123" })

      const result = await api.getSecure<{ token: string }>("secret")
      expect(result).toEqual({ token: "abc123" })
    })

    it("should return undefined for missing secure keys", async () => {
      const api = createStorageAPI("secure-plugin")
      const result = await api.getSecure("nonexistent")
      expect(result).toBeUndefined()
    })

    it("should encrypt the stored value", async () => {
      const api = createStorageAPI("secure-plugin")
      await api.setSecure("secret", "my-password")

      // The raw stored value should be encrypted (prefixed)
      const raw = await api.get<string>("secret")
      expect(typeof raw).toBe("string")
      expect(raw).toMatch(/^__encrypted:/)
      expect(raw).not.toContain("my-password")
    })

    it("should isolate encrypted data between plugins", async () => {
      const api1 = createStorageAPI("plugin-secure-a")
      const api2 = createStorageAPI("plugin-secure-b")

      await api1.setSecure("key", "secret-a")
      await api2.setSecure("key", "secret-b")

      expect(await api1.getSecure("key")).toBe("secret-a")
      expect(await api2.getSecure("key")).toBe("secret-b")
    })

    it("should handle complex objects", async () => {
      const api = createStorageAPI("secure-plugin")
      const data = { items: [1, 2], nested: { deep: true } }
      await api.setSecure("complex", data)
      expect(await api.getSecure("complex")).toEqual(data)
    })

    it("should return undefined when getSecure is called on a non-encrypted key", async () => {
      const api = createStorageAPI("secure-plugin")
      await api.set("plain", "not-encrypted")
      const result = await api.getSecure("plain")
      expect(result).toBeUndefined()
    })
  })

  describe("isEncrypted", () => {
    it("should return true for encrypted values", async () => {
      const api = createStorageAPI("enc-check")
      await api.setSecure("encrypted-key", "secret")
      expect(await api.isEncrypted("encrypted-key")).toBe(true)
    })

    it("should return false for plain values", async () => {
      const api = createStorageAPI("enc-check")
      await api.set("plain-key", "not-secret")
      expect(await api.isEncrypted("plain-key")).toBe(false)
    })

    it("should return false for missing keys", async () => {
      const api = createStorageAPI("enc-check")
      expect(await api.isEncrypted("nonexistent")).toBe(false)
    })
  })
})

describe("Headless durable plugin storage", () => {
  beforeEach(async () => {
    headless = true
    localStorageMock.clear()
    __resetDbForTesting()
    await getDb().plugins.clear()
    for (const id of ["owner", "other"])
      await upsertPlugin({
        id,
        name: id,
        version: "1",
        type: "frontend",
        source: "builtin",
        path: id,
        manifest: { id },
      })
  })

  it("restores values through the existing CLI table snapshot after losing all Storage shims", async () => {
    const api = createStorageAPI("owner")
    await api.set("published:v1:installation:repo:26", {
      headSha: "a".repeat(40),
      parentNumber: 25,
    })
    await api.setSecure("encrypted", { sensitive: "fixture" })
    const db = getDb()
    // Dexie's `Table` overloads don't satisfy `DbTableLike`'s `unknown[]` params —
    // production makes the same runtime-honest cast in `resolveSourcesFactory`.
    const sources: SnapshotSource[] = [
      {
        name: "CogniaDB",
        db: { verno: db.verno, tables: [db.plugins] } as unknown as DbLike,
      },
    ]
    const snapshot = JSON.parse(JSON.stringify(await serializeSources(sources)))
    await db.plugins.clear()
    localStorageMock.clear()
    await restoreMultiSnapshot(sources, snapshot)
    await upsertPlugin({
      id: "owner",
      name: "Updated",
      version: "2",
      type: "frontend",
      source: "builtin",
      path: "owner",
      manifest: { id: "owner" },
    })
    const restored = createStorageAPI("owner")
    expect(await restored.get("published:v1:installation:repo:26")).toEqual({
      headSha: "a".repeat(40),
      parentNumber: 25,
    })
    expect(await restored.getSecure("encrypted")).toEqual({ sensitive: "fixture" })
    expect(await restored.isEncrypted("encrypted")).toBe(true)
    expect(JSON.stringify((await db.plugins.get("owner"))?.storage)).not.toContain("fixture")
    expect(await createStorageAPI("other").keys()).toEqual([])
  })

  it("migrates only the owner's legacy namespace once and does not resurrect deleted values", async () => {
    localStorageMock.setItem("cognia:plugin:storage:owner:legacy", "7")
    localStorageMock.setItem("cognia:plugin:storage:other:legacy", "9")
    localStorageMock.setItem("unrelated-credential", "never copied")
    const api = createStorageAPI("owner")
    expect(await api.get("legacy")).toBe(7)
    await api.delete("legacy")
    expect(await api.has("legacy")).toBe(false)
    expect(await api.getOrDefault("legacy", 42)).toBe(42)
    await api.set("__proto__", { safe: true })
    expect(await api.keys()).toEqual(["__proto__"])
    expect(await api.getUsage()).toBeGreaterThan(0)
    await api.clear()
    expect(await createStorageAPI("owner").keys()).toEqual([])
    expect(JSON.stringify((await getDb().plugins.get("owner"))?.storage)).not.toContain(
      "never copied"
    )
    expect(await createStorageAPI("other").get("legacy")).toBe(9)
  })

  it("serializes quota and concurrent writes without losing unrelated keys", async () => {
    const api = createStorageAPI("owner")
    await Promise.all([api.set("one", 1), api.set("two", 2)])
    expect((await api.keys()).sort()).toEqual(["one", "two"])
    const result = await Promise.allSettled([
      api.set("large1", "x".repeat(1_400_000)),
      api.set("large2", "y".repeat(1_400_000)),
    ])
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1)
    await api.set("large1", "small")
    expect(await api.getUsage()).toBeLessThan(5 * 1024 * 1024)
  })

  it("propagates missing-owner and persistence failures instead of reporting a successful sync", async () => {
    const missing = createStorageAPI("missing")
    await expect(missing.get("key")).rejects.toThrow("not installed")
    await expect(missing.set("key", 1)).rejects.toThrow("not installed")
    const api = createStorageAPI("owner")
    await expect(api.set("undefined", undefined)).rejects.toThrow("JSON value")
    await getDb().plugins.update("owner", { storage: { broken: "not json" } })
    await expect(api.get("broken")).rejects.toThrow()
  })
})
