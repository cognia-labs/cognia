/**
 * Crypto Helpers Tests
 */

// Polyfill Web Crypto APIs for Jest/jsdom environment
import { webcrypto } from "node:crypto"
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from "node:util"

// jsdom does not provide crypto.subtle — use Node.js webcrypto
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

jest.mock("@/lib/data/backup-key", () => ({
  getInstallEncryptionPassphrase: jest.fn(async () => "durable-install-root"),
  getDefaultBackupPassphrase: jest.fn(() => {
    throw new Error("Backup key must not encrypt live plugin state")
  }),
}))

import { deriveInstallKey, encrypt, decrypt } from "./crypto-helpers"

it("B01: binds the install key to both profile and plugin", async () => {
  const key = await deriveInstallKey("plugin-a", "acct_a")
  const ciphertext = await encrypt("profile data", key)
  await expect(decrypt(ciphertext, await deriveInstallKey("plugin-a", "acct_a"))).resolves.toBe(
    "profile data"
  )
  await expect(decrypt(ciphertext, await deriveInstallKey("plugin-a", "acct_b"))).rejects.toThrow()
  await expect(decrypt(ciphertext, await deriveInstallKey("plugin-b", "acct_a"))).rejects.toThrow()
  await expect(decrypt(ciphertext, await deriveInstallKey("plugin-a"))).rejects.toThrow()
})

it("derives live plugin encryption from the persistent install root with plugin isolation", async () => {
  const ciphertext = await encrypt("saved plugin state", await deriveInstallKey("plugin-a"))
  await expect(decrypt(ciphertext, await deriveInstallKey("plugin-a"))).resolves.toBe(
    "saved plugin state"
  )
  await expect(decrypt(ciphertext, await deriveInstallKey("plugin-b"))).rejects.toThrow()
})

describe("crypto-helpers", () => {
  describe("encrypt / decrypt", () => {
    let key: CryptoKey

    beforeAll(async () => {
      key = await deriveInstallKey("roundtrip-plugin")
    })

    it("should encrypt and decrypt a simple string", async () => {
      const data = "hello world"
      const encrypted = await encrypt(data, key)
      expect(encrypted).not.toBe(data)
      const decrypted = await decrypt(encrypted, key)
      expect(decrypted).toBe(data)
    })

    it("should handle JSON-serialized objects", async () => {
      const obj = { nested: { array: [1, 2, 3] }, flag: true }
      const json = JSON.stringify(obj)
      const encrypted = await encrypt(json, key)
      const decrypted = await decrypt(encrypted, key)
      expect(JSON.parse(decrypted)).toEqual(obj)
    })

    it("should handle empty strings", async () => {
      const data = ""
      const encrypted = await encrypt(data, key)
      const decrypted = await decrypt(encrypted, key)
      expect(decrypted).toBe("")
    })

    it("should handle unicode and emoji", async () => {
      const data = "你好世界 🌍"
      const encrypted = await encrypt(data, key)
      const decrypted = await decrypt(encrypted, key)
      expect(decrypted).toBe(data)
    })

    it("should produce different ciphertext for the same plaintext (random IV)", async () => {
      const data = "same-input"
      const enc1 = await encrypt(data, key)
      const enc2 = await encrypt(data, key)
      expect(enc1).not.toBe(enc2)

      // Both should still decrypt correctly
      expect(await decrypt(enc1, key)).toBe(data)
      expect(await decrypt(enc2, key)).toBe(data)
    })

    it("should detect tampered ciphertext", async () => {
      const encrypted = await encrypt("sensitive-data", key)

      // Tamper with the ciphertext (flip a character in the middle)
      const chars = encrypted.split("")
      const mid = Math.floor(chars.length / 2)
      chars[mid] = chars[mid] === "A" ? "B" : "A"
      const tampered = chars.join("")

      await expect(decrypt(tampered, key)).rejects.toThrow()
    })

    it("should fail with invalid base64 input", async () => {
      await expect(decrypt("not-valid-base64!!!", key)).rejects.toThrow()
    })
  })
})
