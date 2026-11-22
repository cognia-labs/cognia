import "fake-indexeddb/auto"
import Dexie from "dexie"

import type { KeyringStore } from "@/lib/credentials/keyring-store"

const mockGetActiveBrowserVault = jest.fn()
jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: () => mockGetActiveBrowserVault(),
}))

import {
  DEVICE_WRAPPED_SECRETS_DB_NAME,
  __resetWebProviderSecretStoreForTesting,
  createDeviceWrappedSecretStore,
  createWebProviderSecretStore,
} from "./web-provider-secret-store"

const SECRET = "sk-synthetic-web-secret"

function fakeVault(localAccountId = "acct_a") {
  const values = new Map<string, string>()
  return {
    localAccountId,
    values,
    storeSecret: jest.fn(async (name: string, value: string) => void values.set(name, value)),
    loadSecret: jest.fn(async (name: string) => values.get(name) ?? null),
    deleteSecret: jest.fn(async (name: string) => void values.delete(name)),
  }
}

beforeEach(async () => {
  __resetWebProviderSecretStoreForTesting()
  await Dexie.delete(DEVICE_WRAPPED_SECRETS_DB_NAME)
  mockGetActiveBrowserVault.mockReturnValue(null)
})

describe("device-wrapped secret store", () => {
  it("round-trips a value and stores only ciphertext", async () => {
    const store = createDeviceWrappedSecretStore()
    await store.save("db-a", SECRET)
    expect(await store.load("db-a")).toBe(SECRET)

    const raw = new Dexie(DEVICE_WRAPPED_SECRETS_DB_NAME)
    await raw.open()
    const row = (await raw.table("secrets").get("db-a")) as { ciphertext: Uint8Array }
    raw.close()
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(SECRET)
  })

  it("keeps values across a reload of the module state", async () => {
    await createDeviceWrappedSecretStore().save("db-a", SECRET)
    __resetWebProviderSecretStoreForTesting()
    expect(await createDeviceWrappedSecretStore().load("db-a")).toBe(SECRET)
  })

  it("binds each ciphertext to its entry name", async () => {
    const store = createDeviceWrappedSecretStore()
    await store.save("db-a", SECRET)
    const raw = new Dexie(DEVICE_WRAPPED_SECRETS_DB_NAME)
    await raw.open()
    const row = await raw.table("secrets").get("db-a")
    await raw.table("secrets").put({ ...row, name: "db-b" })
    raw.close()
    await expect(store.load("db-b")).rejects.toBeDefined()
  })

  it("deletes and reports a missing entry as null", async () => {
    const store = createDeviceWrappedSecretStore()
    await store.save("db-a", SECRET)
    await store.delete("db-a")
    expect(await store.load("db-a")).toBeNull()
  })
})

describe("web provider secret store", () => {
  function memoryDevice(): KeyringStore & { values: Map<string, string> } {
    const values = new Map<string, string>()
    return {
      values,
      save: async (k, v) => void values.set(k, v),
      load: async (k) => values.get(k) ?? null,
      delete: async (k) => void values.delete(k),
    }
  }

  it("uses the device store while no vault is unlocked", async () => {
    const device = memoryDevice()
    const store = createWebProviderSecretStore(device)
    await store.save("db-a", SECRET)
    expect(device.values.get("db-a")).toBe(SECRET)
    expect(await store.load("db-a")).toBe(SECRET)
  })

  it("writes into the unlocked vault and clears the device copy", async () => {
    const device = memoryDevice()
    device.values.set("db-a", "stale")
    const vault = fakeVault()
    mockGetActiveBrowserVault.mockReturnValue(vault)
    const store = createWebProviderSecretStore(device)
    await store.save("db-a", SECRET)
    expect(vault.values.get("provider-secrets:db-a")).toBe(SECRET)
    expect(device.values.has("db-a")).toBe(false)
  })

  it("promotes a value written while locked into the vault on the next read", async () => {
    const device = memoryDevice()
    const store = createWebProviderSecretStore(device)
    await store.save("db-a", SECRET)

    const vault = fakeVault()
    mockGetActiveBrowserVault.mockReturnValue(vault)
    expect(await store.load("db-a")).toBe(SECRET)
    expect(vault.values.get("provider-secrets:db-a")).toBe(SECRET)
    expect(device.values.has("db-a")).toBe(false)
  })

  it("deletes from both places", async () => {
    const device = memoryDevice()
    device.values.set("db-a", SECRET)
    const vault = fakeVault()
    vault.values.set("provider-secrets:db-a", SECRET)
    mockGetActiveBrowserVault.mockReturnValue(vault)
    await createWebProviderSecretStore(device).delete("db-a")
    expect(device.values.size + vault.values.size).toBe(0)
  })

  it("refuses to write or promote acct_a provider secrets into acct_b's Vault (F13)", async () => {
    const device = memoryDevice()
    const vaultB = fakeVault("acct_b")
    mockGetActiveBrowserVault.mockReturnValue(vaultB)
    const store = createWebProviderSecretStore(device)

    await store.save("cognia-account-acct_a-encrypted-v1", SECRET)
    expect(vaultB.storeSecret).not.toHaveBeenCalled()
    expect(device.values.get("cognia-account-acct_a-encrypted-v1")).toBe(SECRET)

    expect(await store.load("cognia-account-acct_a-encrypted-v1")).toBe(SECRET)
    expect(vaultB.storeSecret).not.toHaveBeenCalled()

    const vaultA = fakeVault("acct_a")
    mockGetActiveBrowserVault.mockReturnValue(vaultA)
    expect(await store.load("cognia-account-acct_a-encrypted-v1")).toBe(SECRET)
    expect(vaultA.values.get("provider-secrets:cognia-account-acct_a-encrypted-v1")).toBe(SECRET)
    expect(device.values.has("cognia-account-acct_a-encrypted-v1")).toBe(false)
  })
})
