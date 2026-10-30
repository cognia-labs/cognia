/** @jest-environment jsdom */

import "fake-indexeddb/auto"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  isCapacitor: jest.fn(() => false),
}))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))

import { invoke } from "@tauri-apps/api/core"

import { isCapacitor, isTauri } from "@/lib/tauri"
import {
  __resetPhoneKeyringForTests,
  clearSecret,
  compareAndSetSecret,
  getSecret,
  setSecret,
  setWebKeyringPassphrase,
} from "./index"

const invokeMock = invoke as jest.Mock
const ref = { namespace: "tests", key: "token" }

beforeEach(() => {
  invokeMock.mockReset()
})

describe("desktop secret-store IPC", () => {
  it("uses the canonical get command", async () => {
    invokeMock.mockResolvedValue("secret")
    await expect(getSecret(ref)).resolves.toBe("secret")
    expect(invokeMock).toHaveBeenCalledWith("secret_store_get", { input: ref })
  })

  it("sends a storage-level comparison and related changes through the existing set command", async () => {
    const revision = { namespace: "logto", key: "auth-revision:acct" }
    const changes = [
      { key: "session:acct", value: "token" },
      { key: "reauth:acct", value: null },
    ]
    await compareAndSetSecret(revision, "old", "new", changes)
    expect(invokeMock).toHaveBeenCalledWith("secret_store_set", {
      input: { ...revision, value: "new" },
      condition: { expected: "old", changes },
    })
    invokeMock.mockRejectedValueOnce("secret-store condition mismatch")
    await expect(compareAndSetSecret(revision, "old", "other", changes)).rejects.toBe(
      "secret-store condition mismatch"
    )
  })

  it("uses canonical set and delete commands", async () => {
    invokeMock.mockResolvedValue(undefined)
    await setSecret(ref, "secret")
    await clearSecret(ref)
    expect(invokeMock.mock.calls).toEqual([
      ["secret_store_set", { input: { ...ref, value: "secret" } }],
      ["secret_store_delete", { input: ref }],
    ])
  })

  it("rejects an empty value before invoking the host", async () => {
    await expect(setSecret(ref, "")).rejects.toThrow("must not be empty")
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

it("distinguishes a missing strict credential from a failed native read", async () => {
  invokeMock.mockResolvedValueOnce(null)
  await expect(getSecret(ref, { strict: true })).resolves.toBeNull()
  invokeMock.mockRejectedValueOnce(new Error("keychain unavailable"))
  await expect(getSecret(ref, { strict: true })).rejects.toThrow("keychain unavailable")
})

it("reports native deletion failures to strict callers", async () => {
  invokeMock.mockRejectedValueOnce(new Error("delete denied"))
  await expect(clearSecret(ref, { strict: true })).rejects.toThrow("delete denied")
})

describe("phone secure storage (ADR-0215 defect 6)", () => {
  const MISSING = "Item with given key does not exist"
  let items: Map<string, string>
  let plugin: {
    set: jest.Mock
    get: jest.Mock
    remove: jest.Mock
  }

  beforeEach(() => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    ;(isCapacitor as jest.Mock).mockReturnValue(true)
    __resetPhoneKeyringForTests()
    items = new Map()
    plugin = {
      set: jest.fn(async ({ key, value }: { key: string; value: string }) => {
        items.set(key, value)
      }),
      get: jest.fn(async ({ key }: { key: string }) => {
        if (!items.has(key)) throw new Error(MISSING)
        return { value: items.get(key)! }
      }),
      remove: jest.fn(async ({ key }: { key: string }) => {
        if (!items.delete(key)) throw new Error(MISSING)
      }),
    }
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      Plugins: { SecureStoragePlugin: plugin },
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor
    ;(isTauri as jest.Mock).mockReturnValue(true)
    ;(isCapacitor as jest.Mock).mockReturnValue(false)
    setWebKeyringPassphrase(null)
  })

  it("keeps secrets in the Keychain / Keystore, under a prefixed key", async () => {
    await setSecret(ref, "secret")
    expect(items.get("keyring:tests.token")).toBe("secret")
    await expect(getSecret(ref)).resolves.toBe("secret")
    await clearSecret(ref)
    expect(items.size).toBe(0)
    await expect(getSecret(ref)).resolves.toBeNull()
    // Clearing what is already gone is not an error.
    await expect(clearSecret(ref, { strict: true })).resolves.toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("moves an entry the old IndexedDB fallback held, then deletes the old copy", async () => {
    // Written the old way: the browser fallback, keyed by a localStorage passphrase.
    setWebKeyringPassphrase("device-key")
    ;(isCapacitor as jest.Mock).mockReturnValue(false)
    await setSecret(ref, "legacy-token")
    ;(isCapacitor as jest.Mock).mockReturnValue(true)

    await expect(getSecret(ref)).resolves.toBe("legacy-token")
    expect(items.get("keyring:tests.token")).toBe("legacy-token")

    // The fallback copy is gone: with secure storage emptied, nothing comes back.
    items.clear()
    await expect(getSecret(ref)).resolves.toBeNull()
  })

  it("leaves the old copy in place when the secure write fails", async () => {
    setWebKeyringPassphrase("device-key")
    ;(isCapacitor as jest.Mock).mockReturnValue(false)
    await setSecret(ref, "legacy-token")
    ;(isCapacitor as jest.Mock).mockReturnValue(true)

    plugin.set.mockRejectedValueOnce(new Error("keystore locked"))
    await expect(getSecret(ref, { strict: true })).rejects.toThrow("keystore locked")
    await expect(getSecret(ref)).resolves.toBe("legacy-token")
  })

  it("reports a failed secure read to strict callers instead of calling it empty", async () => {
    plugin.get.mockRejectedValueOnce(new Error("keystore unavailable"))
    await expect(getSecret(ref, { strict: true })).rejects.toThrow("keystore unavailable")
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    plugin.get.mockRejectedValueOnce(new Error("keystore unavailable"))
    await expect(getSecret(ref)).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("propagates a failed strict delete and keeps the stored phone credential", async () => {
    await setSecret(ref, "retained-token")
    plugin.remove.mockRejectedValueOnce(new Error("keystore deletion denied"))
    await expect(clearSecret(ref, { strict: true })).rejects.toThrow("keystore deletion denied")
    await expect(getSecret(ref)).resolves.toBe("retained-token")
  })
})

describe("strict browser deletion", () => {
  beforeEach(() => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    ;(isCapacitor as jest.Mock).mockReturnValue(false)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    ;(isTauri as jest.Mock).mockReturnValue(true)
  })

  it("reports a failed database open rather than claiming the secret was removed", async () => {
    const request = { error: new Error("database unavailable") } as unknown as IDBOpenDBRequest
    jest.spyOn(indexedDB, "open").mockImplementation(() => {
      queueMicrotask(() => request.onerror?.call(request, new Event("error")))
      return request
    })
    await expect(clearSecret(ref, { strict: true })).rejects.toThrow("database unavailable")
    await expect(clearSecret(ref)).resolves.toBeUndefined()
  })

  it("reports an aborted delete transaction instead of claiming success", async () => {
    const transaction = {
      error: new Error("deletion aborted"),
      objectStore: () => ({
        delete: () =>
          queueMicrotask(() => transaction.onabort?.call(transaction, new Event("abort"))),
      }),
    } as unknown as IDBTransaction
    const close = jest.fn()
    const request = {
      result: { transaction: () => transaction, close },
    } as unknown as IDBOpenDBRequest
    jest.spyOn(indexedDB, "open").mockImplementation(() => {
      queueMicrotask(() => request.onsuccess?.call(request, new Event("success")))
      return request
    })
    await expect(clearSecret(ref, { strict: true })).rejects.toThrow("deletion aborted")
    expect(close).toHaveBeenCalledTimes(1)
    await expect(clearSecret(ref)).resolves.toBeUndefined()
  })
})
