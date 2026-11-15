/**
 * Plugin Storage API Implementation
 *
 * Provides per-plugin storage: localStorage on browser/desktop, owned plugin
 * records on Headless so acknowledged writes participate in host durability.
 * Each plugin gets an isolated namespace to prevent conflicts.
 */

import { getDb } from "@/lib/db/schema"
import { isHeadlessHost } from "@/lib/platform/detect"
import { createPluginSystemLogger } from "../core/logger"
import { deriveInstallKey, encrypt, decrypt } from "./crypto-helpers"
import {
  getPluginRuntimeAccountId,
  getPluginRuntimeAccountRevision,
  pluginRuntimeAccountAvailable,
} from "../security/account-runtime-gate"

export interface PluginStorageAPI {
  /** Get a value by key */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Get a value by key with a default */
  getOrDefault<T = unknown>(key: string, defaultValue: T): Promise<T>
  /** Set a value by key */
  set<T = unknown>(key: string, value: T): Promise<void>
  /** Remove a value by key */
  remove(key: string): Promise<void>
  /** Delete alias for compatibility with legacy PluginStorage */
  delete(key: string): Promise<void>
  /** Check if a key exists */
  has(key: string): Promise<boolean>
  /** Get all keys in this plugin's namespace */
  keys(): Promise<string[]>
  /** Clear all plugin storage */
  clear(): Promise<void>
  /** Get storage usage in bytes (approximate) */
  getUsage(): Promise<number>
  /** Store a value with AES-GCM encryption */
  setSecure<T = unknown>(key: string, value: T): Promise<void>
  /** Retrieve and decrypt a securely stored value */
  getSecure<T = unknown>(key: string): Promise<T | undefined>
  /** Check if a value is stored with encryption */
  isEncrypted(key: string): Promise<boolean>
}

const STORAGE_PREFIX = "cognia:plugin:storage:"
const ENCRYPTED_PREFIX = "__encrypted:"
const MAX_PLUGIN_STORAGE_BYTES = 5 * 1024 * 1024 // 5MB per plugin
const ACCOUNT_STORAGE_PREFIX = "cognia:plugin:account-storage:"
const mutations = new Map<string, Promise<void>>()
const purgeRevisions = new Map<string, number>()

class PluginStorageAccountError extends Error {
  constructor() {
    super("Plugin storage requires the same active runtime account.")
  }
}

interface BrowserStorageScope {
  accountId: string | null
  revision: number
  purgeRevision: number
  prefix: string
}

function accountStoragePrefix(accountId: string): string {
  return `${ACCOUNT_STORAGE_PREFIX}${encodeURIComponent(accountId)}:`
}

function assertBrowserAccount(scope: BrowserStorageScope): void {
  if (
    !pluginRuntimeAccountAvailable() ||
    getPluginRuntimeAccountId() !== scope.accountId ||
    getPluginRuntimeAccountRevision() !== scope.revision ||
    (scope.accountId !== null && (purgeRevisions.get(scope.accountId) ?? 0) !== scope.purgeRevision)
  ) {
    throw new PluginStorageAccountError()
  }
}

function storageKeys(prefix: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  return keys
}

function browserScope(pluginId: string): BrowserStorageScope {
  if (!pluginRuntimeAccountAvailable()) throw new PluginStorageAccountError()
  const accountId = getPluginRuntimeAccountId()
  return {
    accountId,
    revision: getPluginRuntimeAccountRevision(),
    purgeRevision: accountId === null ? 0 : (purgeRevisions.get(accountId) ?? 0),
    prefix:
      accountId === null
        ? getPluginPrefix(pluginId)
        : `${accountStoragePrefix(accountId)}${encodeURIComponent(pluginId)}:`,
  }
}

function readBrowserValue(scope: BrowserStorageScope, key: string): string | null {
  return localStorage.getItem(scope.prefix + key)
}

function clearBrowserStorage(scope: BrowserStorageScope): number {
  const keys = storageKeys(scope.prefix)
  for (const key of keys) localStorage.removeItem(key)
  return keys.length
}

function browserUsage(prefix: string): number {
  return storageKeys(prefix).reduce(
    (total, key) => total + 2 * (key.length + (localStorage.getItem(key)?.length ?? 0)),
    0
  )
}

function writeBrowserValue(scope: BrowserStorageScope, key: string, serialized: string): void {
  assertBrowserAccount(scope)
  const storageKey = scope.prefix + key
  const currentUsage = browserUsage(scope.prefix)
  const existingRaw = localStorage.getItem(storageKey)
  const existingSize = existingRaw === null ? 0 : 2 * (storageKey.length + existingRaw.length)
  const newEntrySize = 2 * (storageKey.length + serialized.length)
  if (currentUsage - existingSize + newEntrySize > MAX_PLUGIN_STORAGE_BYTES) {
    throw new Error(
      `Plugin storage limit exceeded (${MAX_PLUGIN_STORAGE_BYTES} bytes). ` +
        `Current: ${currentUsage}, New entry: ${newEntrySize}`
    )
  }
  localStorage.setItem(storageKey, serialized)
}

function mutateBrowserStorage<T>(scope: BrowserStorageScope, fn: () => T | Promise<T>): Promise<T> {
  const pending = mutations.get(scope.prefix) ?? Promise.resolve()
  const result = pending.then(async () => {
    assertBrowserAccount(scope)
    const value = await fn()
    assertBrowserAccount(scope)
    return value
  })
  const settled = result.then(
    () => {},
    () => {}
  )
  mutations.set(scope.prefix, settled)
  void settled.then(() => {
    if (mutations.get(scope.prefix) === settled) mutations.delete(scope.prefix)
  })
  return result
}

function getStorageKey(pluginId: string, key: string): string {
  return `${STORAGE_PREFIX}${pluginId}:${key}`
}

function getPluginPrefix(pluginId: string): string {
  return `${STORAGE_PREFIX}${pluginId}:`
}

/** Reads and changes serialize with plugin discovery; no credentials or global Storage are copied. */
async function withHeadlessStorage<T>(
  pluginId: string,
  mutate: boolean,
  fn: (values: Record<string, string>) => T
): Promise<T> {
  const db = getDb()
  return db.transaction("rw", db.plugins, async () => {
    const plugin = await db.plugins.get(pluginId)
    if (!plugin) throw new Error("Plugin storage owner is not installed")
    const values = Object.assign(Object.create(null) as Record<string, string>, plugin.storage)
    const result = fn(values)
    if (mutate) {
      const size = Object.entries(values).reduce(
        (total, [key, value]) => total + 2 * (getStorageKey(pluginId, key).length + value.length),
        0
      )
      if (size > MAX_PLUGIN_STORAGE_BYTES)
        throw new Error(`Plugin storage limit exceeded (${MAX_PLUGIN_STORAGE_BYTES} bytes)`)
      await db.plugins.update(pluginId, { storage: values })
    }
    return result
  })
}

/**
 * Create the Storage API for a plugin
 */
export function createStorageAPI(pluginId: string): PluginStorageAPI {
  const logger = createPluginSystemLogger(pluginId)
  const durable = isHeadlessHost()

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const scope = durable ? undefined : browserScope(pluginId)
      try {
        const raw = durable
          ? await withHeadlessStorage(pluginId, false, (values) => values[key] ?? null)
          : readBrowserValue(scope!, key)
        if (raw === null) return undefined
        return JSON.parse(raw) as T
      } catch (error) {
        if (durable || error instanceof PluginStorageAccountError) throw error
        logger.warn(`Failed to read storage key: ${key}`)
        return undefined
      }
    },

    async getOrDefault<T = unknown>(key: string, defaultValue: T): Promise<T> {
      const value = await this.get<T>(key)
      return value !== undefined ? value : defaultValue
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      const scope = durable ? undefined : browserScope(pluginId)
      try {
        const serialized = JSON.stringify(value)
        if (serialized === undefined) throw new TypeError("Plugin storage requires a JSON value")
        if (durable) {
          await withHeadlessStorage(pluginId, true, (values) => {
            values[key] = serialized
          })
          return
        }

        await mutateBrowserStorage(scope!, () => writeBrowserValue(scope!, key, serialized))
      } catch (err) {
        if (!durable && !(err instanceof Error && err.message.includes("storage limit"))) {
          logger.error(`Failed to write storage key: ${key}`, err)
        }
        throw err
      }
    },

    async remove(key: string): Promise<void> {
      if (durable)
        return withHeadlessStorage(pluginId, true, (values) => {
          delete values[key]
        })
      const scope = browserScope(pluginId)
      await mutateBrowserStorage(scope, () => {
        localStorage.removeItem(scope.prefix + key)
      })
    },

    async has(key: string): Promise<boolean> {
      if (durable)
        return withHeadlessStorage(pluginId, false, (values) => Object.hasOwn(values, key))
      return readBrowserValue(browserScope(pluginId), key) !== null
    },

    async keys(): Promise<string[]> {
      if (durable) return withHeadlessStorage(pluginId, false, (values) => Object.keys(values))
      const { prefix } = browserScope(pluginId)
      return storageKeys(prefix).map((key) => key.slice(prefix.length))
    },

    async delete(key: string): Promise<void> {
      await this.remove(key)
    },

    async clear(): Promise<void> {
      if (durable)
        return withHeadlessStorage(pluginId, true, (values) => {
          for (const key of Object.keys(values)) delete values[key]
        })
      const scope = browserScope(pluginId)
      await mutateBrowserStorage(scope, () => {
        const count = clearBrowserStorage(scope)
        logger.info(`Cleared all storage (${count} entries)`)
      })
    },

    async getUsage(): Promise<number> {
      if (durable)
        return withHeadlessStorage(pluginId, false, (values) =>
          Object.entries(values).reduce(
            (total, [key, value]) =>
              total + 2 * (getStorageKey(pluginId, key).length + value.length),
            0
          )
        )
      return browserUsage(browserScope(pluginId).prefix)
    },

    async setSecure<T = unknown>(key: string, value: T): Promise<void> {
      const scope = durable ? undefined : browserScope(pluginId)
      try {
        const write = async () => {
          const cryptoKey = await deriveInstallKey(pluginId, scope?.accountId ?? undefined)
          const serialized = JSON.stringify(value)
          if (serialized === undefined) throw new TypeError("Plugin storage requires a JSON value")
          const encrypted = `${ENCRYPTED_PREFIX}${await encrypt(serialized, cryptoKey)}`
          if (scope) writeBrowserValue(scope, key, JSON.stringify(encrypted))
          else await this.set(key, encrypted)
        }
        if (scope) await mutateBrowserStorage(scope, write)
        else await write()
      } catch (err) {
        logger.error(`Failed to write secure storage key: ${key}`, err)
        throw err
      }
    },

    async getSecure<T = unknown>(key: string): Promise<T | undefined> {
      const scope = durable ? undefined : browserScope(pluginId)
      try {
        const read = async (): Promise<T | undefined> => {
          const raw = scope
            ? (JSON.parse(readBrowserValue(scope, key) ?? "null") as string | null)
            : await this.get<string>(key)
          if (raw === null) return undefined
          if (raw === undefined) return undefined
          if (typeof raw !== "string" || !raw.startsWith(ENCRYPTED_PREFIX)) {
            logger.warn(`Storage key '${key}' is not encrypted, returning undefined`)
            return undefined
          }

          const cryptoKey = await deriveInstallKey(pluginId, scope?.accountId ?? undefined)
          const decrypted = await decrypt(raw.slice(ENCRYPTED_PREFIX.length), cryptoKey)
          return JSON.parse(decrypted) as T
        }
        return scope ? await mutateBrowserStorage(scope, read) : await read()
      } catch (err) {
        if (err instanceof PluginStorageAccountError) throw err
        logger.error(`Failed to read secure storage key: ${key}`, err)
        return undefined
      }
    },

    async isEncrypted(key: string): Promise<boolean> {
      const raw = await this.get<string>(key)
      return typeof raw === "string" && raw.startsWith(ENCRYPTED_PREFIX)
    },
  }
}

/**
 * Clear all storage for a plugin (called during uninstall)
 */
export function clearPluginStorage(pluginId: string): void {
  clearBrowserStorage(browserScope(pluginId))
}

/** Account deletion must not leave plugin payloads or pending writes behind. */
export function purgePluginAccountData(localAccountId: string): void {
  purgeRevisions.set(localAccountId, (purgeRevisions.get(localAccountId) ?? 0) + 1)
  for (const key of storageKeys(accountStoragePrefix(localAccountId))) localStorage.removeItem(key)
}

/**
 * Get storage usage across all plugins
 */
export function getAllPluginStorageUsage(): Record<string, number> {
  if (!pluginRuntimeAccountAvailable()) throw new PluginStorageAccountError()
  const accountId = getPluginRuntimeAccountId()
  const prefix = accountId === null ? STORAGE_PREFIX : accountStoragePrefix(accountId)
  const usage: Record<string, number> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(prefix)) {
      const remainder = k.slice(prefix.length)
      const colonIndex = remainder.indexOf(":")
      if (colonIndex > 0) {
        const pluginId =
          accountId === null
            ? remainder.slice(0, colonIndex)
            : decodeURIComponent(remainder.slice(0, colonIndex))
        const v = localStorage.getItem(k)
        const bytes = (k.length + (v?.length || 0)) * 2
        usage[pluginId] = (usage[pluginId] || 0) + bytes
      }
    }
  }
  return usage
}
