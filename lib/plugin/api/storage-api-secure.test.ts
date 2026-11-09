/** @jest-environment jsdom */
/**
 * setSecure/getSecure with the REAL crypto-helpers (W2.5): per-install key
 * derivation, legacy-blob migration, and SSR failure mode.
 */

import { webcrypto } from "node:crypto"
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from "node:util"

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  writable: true,
  configurable: true,
})
if (typeof globalThis.TextEncoder === "undefined") {
  Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder })
}
if (typeof globalThis.TextDecoder === "undefined") {
  Object.defineProperty(globalThis, "TextDecoder", { value: NodeTextDecoder })
}

const mockPassphrase = jest.fn<Promise<string | null>, []>()
jest.mock("@/lib/data/backup-key", () => ({
  getInstallEncryptionPassphrase: () => mockPassphrase(),
}))

import { createStorageAPI } from "./storage-api"
import { deriveKey, deriveInstallKey, encrypt, decrypt } from "./crypto-helpers"
import {
  activatePluginRuntimeAccount,
  clearPluginRuntimeAccount,
} from "../security/account-runtime-gate"

const PLUGIN = "secure-plugin"
const LEGACY_STORAGE_KEY = `cognia:plugin:storage:${PLUGIN}:token`
const STORAGE_KEY = `cognia:plugin:account-storage:acct_secure_a:${PLUGIN}:token`

describe("setSecure / getSecure with per-install key", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    localStorage.clear()
    mockPassphrase.mockResolvedValue("device-master-key")
    activatePluginRuntimeAccount("acct_secure_a")
  })

  it("R2: reads adopted legacy ciphertext even when relocation and re-encryption exceed quota", async () => {
    const legacyKey = await deriveInstallKey(PLUGIN)
    const blob = await encrypt(JSON.stringify("legacy-secret"), legacyKey)
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(`__encrypted:${blob}`))
    localStorage.setItem(`cognia:plugin:storage-adoption:${PLUGIN}`, "acct_secure_a")
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Browser storage is full", "QuotaExceededError")
    })
    const api = createStorageAPI(PLUGIN)

    await expect(api.getSecure("token")).resolves.toBe("legacy-secret")
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull()
    activatePluginRuntimeAccount("acct_secure_b")
    await expect(api.getSecure("token")).resolves.toBeUndefined()
    activatePluginRuntimeAccount("acct_secure_a")
    setItem.mockRestore()
    await expect(api.getSecure("token")).resolves.toBe("legacy-secret")
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull()
    const migrated = (JSON.parse(localStorage.getItem(STORAGE_KEY)!) as string).slice(
      "__encrypted:".length
    )
    await expect(decrypt(migrated, await deriveInstallKey(PLUGIN, "acct_secure_a"))).resolves.toBe(
      JSON.stringify("legacy-secret")
    )
  })

  it("B01: secure values do not cross LocalProfiles", async () => {
    const api = createStorageAPI(PLUGIN)
    await api.setSecure("token", "profile-a-secret")
    clearPluginRuntimeAccount()
    activatePluginRuntimeAccount("acct_secure_b")
    await expect(api.getSecure("token")).resolves.toBeUndefined()
    activatePluginRuntimeAccount("acct_secure_a")
    await expect(api.getSecure("token")).resolves.toBe("profile-a-secret")
  })

  it("round-trips a value under the install key", async () => {
    const api = createStorageAPI(PLUGIN)
    await api.setSecure("token", { secret: "s3cr3t" })
    await expect(api.getSecure("token")).resolves.toEqual({ secret: "s3cr3t" })
  })

  it("does NOT decrypt with the legacy public-id key alone", async () => {
    const api = createStorageAPI(PLUGIN)
    await api.setSecure("token", "value")
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as string
    const blob = raw.slice("__encrypted:".length)
    const legacyKey = await deriveKey(PLUGIN)
    await expect(decrypt(blob, legacyKey)).rejects.toBeDefined()
  })

  it("migrates a legacy blob to the install key on first read", async () => {
    // Simulate a pre-W2.5 write: encrypted with the public-id key.
    const legacyKey = await deriveKey(PLUGIN)
    const legacyBlob = await encrypt(JSON.stringify("legacy-value"), legacyKey)
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(`__encrypted:${legacyBlob}`))

    const api = createStorageAPI(PLUGIN)
    await expect(api.getSecure("token")).resolves.toBe("legacy-value")

    // The stored blob must now decrypt with the install key.
    const migrated = (JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as string).slice(
      "__encrypted:".length
    )
    const installKey = await deriveInstallKey(PLUGIN, "acct_secure_a")
    await expect(decrypt(migrated, installKey)).resolves.toBe(JSON.stringify("legacy-value"))
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull()
  })

  it("B01: migrates W2.5 per-install ciphertext into the adopting profile key", async () => {
    const oldKey = await deriveInstallKey(PLUGIN)
    const oldBlob = await encrypt(JSON.stringify("install-value"), oldKey)
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(`__encrypted:${oldBlob}`))
    const api = createStorageAPI(PLUGIN)
    await expect(api.getSecure("token")).resolves.toBe("install-value")
    const migrated = (await api.get<string>("token"))!.slice("__encrypted:".length)
    await expect(decrypt(migrated, await deriveInstallKey(PLUGIN, "acct_secure_a"))).resolves.toBe(
      JSON.stringify("install-value")
    )
    await expect(decrypt(migrated, oldKey)).rejects.toThrow()
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull()
  })

  it("B01: profile keys prevent decrypting ciphertext copied into another namespace", async () => {
    const api = createStorageAPI(PLUGIN)
    await api.setSecure("token", "profile-secret")
    const ciphertext = await api.get("token")
    activatePluginRuntimeAccount("acct_secure_b")
    await api.set("token", ciphertext)
    await expect(api.getSecure("token")).resolves.toBeUndefined()
  })

  it("B24: serializes setSecure with remove, clear and ordinary set", async () => {
    const api = createStorageAPI(PLUGIN)
    await Promise.all([api.setSecure("token", "secret"), api.remove("token")])
    expect(await api.has("token")).toBe(false)
    await Promise.all([api.setSecure("token", "secret"), api.clear()])
    expect(await api.keys()).toEqual([])
    await Promise.all([api.setSecure("token", "secret"), api.set("token", "plain")])
    expect(await api.get("token")).toBe("plain")
  })

  it("B01: rejects an in-flight secure write after switching accounts", async () => {
    let finish!: (value: string) => void
    mockPassphrase.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const api = createStorageAPI(PLUGIN)
    const pending = api.setSecure("token", "profile-a-secret")
    await Promise.resolve()
    activatePluginRuntimeAccount("acct_secure_b")
    finish("device-master-key")
    await expect(pending).rejects.toThrow(/account/i)
    expect(await api.keys()).toEqual([])
    activatePluginRuntimeAccount("acct_secure_a")
    expect(await api.keys()).toEqual([])
  })

  it("setSecure throws when no master key is available", async () => {
    mockPassphrase.mockResolvedValue(null)
    const api = createStorageAPI(PLUGIN)
    await expect(api.setSecure("token", "v")).rejects.toThrow(/master key/)
  })
})
