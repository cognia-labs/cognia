/** @jest-environment jsdom */
/**
 * setSecure/getSecure with the REAL crypto-helpers (W2.5): per-install key
 * derivation, profile isolation, and SSR failure mode.
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
import { deriveInstallKey, encrypt } from "./crypto-helpers"
import {
  activatePluginRuntimeAccount,
  clearPluginRuntimeAccount,
} from "../security/account-runtime-gate"

const PLUGIN = "secure-plugin"
const SIGNED_OUT_STORAGE_KEY = `cognia:plugin:storage:${PLUGIN}:token`

describe("setSecure / getSecure with per-install key", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    localStorage.clear()
    mockPassphrase.mockResolvedValue("device-master-key")
    activatePluginRuntimeAccount("acct_secure_a")
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

  it("never reads signed-out ciphertext into a signed-in profile", async () => {
    const blob = await encrypt(JSON.stringify("signed-out"), await deriveInstallKey(PLUGIN))
    localStorage.setItem(SIGNED_OUT_STORAGE_KEY, JSON.stringify(`__encrypted:${blob}`))
    const api = createStorageAPI(PLUGIN)
    await expect(api.getSecure("token")).resolves.toBeUndefined()
    expect(localStorage.getItem(SIGNED_OUT_STORAGE_KEY)).not.toBeNull()
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
