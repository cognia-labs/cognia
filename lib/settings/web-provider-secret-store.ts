/**
 * Web backend of the provider secret store (ADR-0256 §2).
 *
 * The browser has no OS keyring, and the generic `BrowserVaultStore` falls
 * back to process memory while no account vault is unlocked, which would drop
 * every provider key on reload. This store keeps two places instead:
 *
 *   - **Browser Vault**, while one is unlocked: the value is encrypted under the
 *     account master key, like every other vault secret.
 *   - **Device-wrapped IndexedDB** otherwise: AES-GCM ciphertext in its own
 *     database, under a NON-EXTRACTABLE key that also lives in IndexedDB. Script
 *     can use the key in place but cannot read its bytes, so an exported or
 *     copied database does not carry a usable credential. It does not defend
 *     against code running in the page; that is the same claim the quick-unlock
 *     device pepper makes (`lib/accounts/quick-unlock/device-pepper.ts`).
 *
 * A value written while the vault was locked is promoted into the vault the
 * first time it is read with the vault unlocked, and removed from the device
 * store only after the vault write succeeded.
 */

import Dexie, { type Table } from "dexie"

import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"

export const DEVICE_WRAPPED_SECRETS_DB_NAME = "cognia-provider-secrets"
const DEVICE_KEY_ID = "device"
const VAULT_SECRET_PREFIX = "provider-secrets:"

interface DeviceKeyRow {
  id: string
  key: CryptoKey
}

interface WrappedSecretRow {
  name: string
  iv: Uint8Array
  ciphertext: Uint8Array
}

/** Copy into this realm: a structured clone may hand back another realm's buffer. */
function bytes(value: ArrayBufferLike | ArrayBufferView): Uint8Array<ArrayBuffer> {
  const view = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value)
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return copy
}

class DeviceWrappedSecretsDb extends Dexie {
  keys!: Table<DeviceKeyRow, string>
  secrets!: Table<WrappedSecretRow, string>

  constructor() {
    super(DEVICE_WRAPPED_SECRETS_DB_NAME)
    this.version(1).stores({ keys: "id", secrets: "name" })
  }
}

let db: DeviceWrappedSecretsDb | null = null

function database(): DeviceWrappedSecretsDb {
  db ??= new DeviceWrappedSecretsDb()
  return db
}

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto
  if (!crypto?.subtle) {
    throw new Error("WebCrypto is unavailable, so provider credentials cannot be stored here.")
  }
  return crypto.subtle
}

let deviceKey: Promise<CryptoKey> | null = null

async function loadOrMintDeviceKey(): Promise<CryptoKey> {
  const existing = await database().keys.get(DEVICE_KEY_ID)
  if (existing) return existing.key
  const key = await subtle().generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])
  try {
    await database().keys.add({ id: DEVICE_KEY_ID, key })
    return key
  } catch (error) {
    // Another tab minted one first; theirs is the key every tab must share.
    const raced = await database().keys.get(DEVICE_KEY_ID)
    if (raced) return raced.key
    throw error
  }
}

function getDeviceKey(): Promise<CryptoKey> {
  deviceKey ??= loadOrMintDeviceKey().catch((error: unknown) => {
    deviceKey = null
    throw error
  })
  return deviceKey
}

function additionalData(name: string): Uint8Array<ArrayBuffer> {
  return bytes(new TextEncoder().encode(`cognia.provider-secrets.v1:${name}`))
}

/** The device-wrapped half on its own: ciphertext in IndexedDB. */
export function createDeviceWrappedSecretStore(): KeyringStore {
  return {
    async save(name, value) {
      const key = await getDeviceKey()
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
      const ciphertext = await subtle().encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(name) },
        key,
        new TextEncoder().encode(value)
      )
      await database().secrets.put({ name, iv, ciphertext: new Uint8Array(ciphertext) })
    },
    async load(name) {
      const row = await database().secrets.get(name)
      if (!row) return null
      const key = await getDeviceKey()
      const plain = await subtle().decrypt(
        { name: "AES-GCM", iv: bytes(row.iv), additionalData: additionalData(name) },
        key,
        bytes(row.ciphertext)
      )
      return new TextDecoder().decode(plain)
    },
    async delete(name) {
      await database().secrets.delete(name)
    },
    isPersistent() {
      return true
    },
  }
}

const ACCOUNT_DB_PREFIX = "cognia-account-"

function matchesVaultAccount(name: string, vaultAccountId: string | undefined): boolean {
  if (!vaultAccountId || !name.startsWith(ACCOUNT_DB_PREFIX)) return true
  const prefix = `${ACCOUNT_DB_PREFIX}${vaultAccountId}`
  if (name === prefix) return true
  return (
    name.startsWith(`${prefix}-encrypted-v1`) ||
    name.startsWith(`${prefix}-target-`) ||
    name.startsWith(`${prefix}-fusion`)
  )
}

function resolveVaultForSecret(name: string) {
  const vault = getActiveBrowserVault()
  if (!vault) return null
  return matchesVaultAccount(name, vault.localAccountId) ? vault : null
}

/** Vault while unlocked, device-wrapped otherwise (see the file comment). */
export function createWebProviderSecretStore(
  device: KeyringStore = createDeviceWrappedSecretStore()
): KeyringStore {
  const vaultName = (name: string) => `${VAULT_SECRET_PREFIX}${name}`
  return {
    async save(name, value) {
      const vault = resolveVaultForSecret(name)
      if (!vault) {
        await device.save(name, value)
        return
      }
      await vault.storeSecret(vaultName(name), value)
      await device.delete(name)
    },
    async load(name) {
      const vault = resolveVaultForSecret(name)
      if (vault) {
        const persisted = await vault.loadSecret(vaultName(name))
        if (persisted !== null) return persisted
      }
      const local = await device.load(name)
      if (local !== null && vault) {
        await vault.storeSecret(vaultName(name), local)
        await device.delete(name)
      }
      return local
    },
    async delete(name) {
      const vault = resolveVaultForSecret(name)
      if (vault) await vault.deleteSecret(vaultName(name))
      await device.delete(name)
    },
    isPersistent() {
      return true
    },
  }
}

/** Test hook: forget the cached connection and device key. */
export function __resetWebProviderSecretStoreForTesting(): void {
  db?.close()
  db = null
  deviceKey = null
}
