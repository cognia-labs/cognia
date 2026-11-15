/**
 * Crypto Helpers for Plugin Storage Encryption
 *
 * Provides AES-GCM encryption using the Web Crypto API (SubtleCrypto).
 * Used by the Storage API to support encrypted key-value storage.
 */

import { getInstallEncryptionPassphrase } from "@/lib/data/backup-key"

const ALGORITHM = "AES-GCM"
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96 bits recommended for AES-GCM
const SALT_PREFIX = "cognia:plugin:encryption:"

async function deriveKeyFromMaterial(material: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(material),
    "PBKDF2",
    false,
    ["deriveKey"]
  )

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Derive the AES-GCM key for `setSecure` from the per-install master key
 * (the stable per-install credential root — the same root `ctx.secrets` uses on
 * web) combined with the plugin id and, for browser/desktop storage, the
 * LocalProfile id. The unscoped form serves Headless and signed-out storage.
 * Confidentiality rests on a secret that never leaves the device rather than
 * on the public plugin id.
 *
 * Throws when no master key is available (SSR).
 */
export async function deriveInstallKey(
  pluginId: string,
  localAccountId?: string
): Promise<CryptoKey> {
  const master = await getInstallEncryptionPassphrase()
  if (!master) {
    throw new Error("Secure plugin storage unavailable: no per-install master key (SSR context)")
  }
  if (localAccountId !== undefined) {
    const coordinates = JSON.stringify([localAccountId, pluginId])
    return deriveKeyFromMaterial(
      JSON.stringify([master, localAccountId, pluginId]),
      `${SALT_PREFIX}v3:${coordinates}`
    )
  }
  return deriveKeyFromMaterial(`${master}:${pluginId}`, `${SALT_PREFIX}v2:${pluginId}`)
}

/**
 * Encrypt a string using AES-GCM.
 * Returns a base64 string with the IV prepended to the ciphertext.
 */
export async function encrypt(data: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder()
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoder.encode(data))

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt a base64 string that was encrypted with `encrypt`.
 * Expects the IV prepended to the ciphertext.
 */
export async function decrypt(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))

  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)

  return new TextDecoder().decode(plaintext)
}
