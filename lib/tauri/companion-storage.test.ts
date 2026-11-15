/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import Dexie from "dexie"
import {
  BROWSER_VAULT_DB_NAME,
  __resetBrowserVaultForTesting,
  __setBrowserVaultArgon2ParametersForTesting,
  provisionBrowserVault,
} from "@/lib/runtime/browser-vault"

import {
  CompanionConfig,
  __setCompanionStorageForTests,
  companionStorage,
  pickCompanionStorage,
} from "./companion-storage"
import {
  CredentialBookCompanionStorage,
  HOST_BOOK_KEY,
  __resetCredentialBookForTests,
} from "@/lib/companion/credential-book"
import { clearActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

const MOCK: CompanionConfig = {
  targetId: "companion-studio",
  baseUrl: "https://192.168.1.42:7890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-key-a" },
  deviceKeyThumbprint: "thumbprint-a",
  deviceId: "device-abc",
  serverVersion: "0.1.0",
}

afterEach(() => {
  window.localStorage.clear()
  clearActiveRuntimeTargetContext()
  delete (window as { Capacitor?: unknown }).Capacitor
  __setCompanionStorageForTests(null)
  __resetCredentialBookForTests()
})

describe("pickCompanionStorage / companionStorage", () => {
  it("returns the credential-book storage, whatever the platform", () => {
    expect(pickCompanionStorage()).toBeInstanceOf(CredentialBookCompanionStorage)
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    __resetCredentialBookForTests()
    expect(pickCompanionStorage()).toBeInstanceOf(CredentialBookCompanionStorage)
  })

  it("companionStorage() memoizes one instance per process", () => {
    const a = companionStorage()
    const b = companionStorage()
    expect(a).toBe(b)
  })

  it("__setCompanionStorageForTests resets the singleton on null", () => {
    const a = companionStorage()
    __setCompanionStorageForTests(null)
    const b = companionStorage()
    expect(a).not.toBe(b)
  })
})

it("round-trips the default storage through the real active vault's local profile", async () => {
  __resetBrowserVaultForTesting()
  __setBrowserVaultArgon2ParametersForTesting(32)
  await Dexie.delete(BROWSER_VAULT_DB_NAME)
  try {
    await provisionBrowserVault("acct_storage_default", "password")
    const storage = pickCompanionStorage()
    await storage.save(MOCK)
    expect(localStorage.getItem(HOST_BOOK_KEY)).toContain("companion-studio")
    await expect(storage.load()).resolves.toMatchObject({
      targetId: "companion-studio",
      baseUrl: MOCK.baseUrl,
      deviceId: MOCK.deviceId,
      devicePrivateKeyJwk: MOCK.devicePrivateKeyJwk,
      deviceKeyThumbprint: MOCK.deviceKeyThumbprint,
    })
    await provisionBrowserVault("acct_storage_other", "password")
    await expect(storage.load()).resolves.toBeNull()
  } finally {
    __resetBrowserVaultForTesting()
    await Dexie.delete(BROWSER_VAULT_DB_NAME)
  }
})
