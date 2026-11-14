/**
 * Where provider credentials live once they leave the settings row (ADR-0256).
 *
 * One JSON blob per settings database, in the platform secret store, entry
 * key = the Dexie database name. The persisted settings row names the blob it
 * expects through a pointer `{ db, rev }` (see `ProviderSecretsRef`):
 *
 *   - `rev` changes on every blob write. A process caches each database's blob
 *     and trusts the cache only while the row's `rev` matches, so a key edited
 *     in another tab or window is read again instead of being written back
 *     stale.
 *   - `db` survives a database migration, which copies the row under a new
 *     name. The target then finds its blob under the source name, uses it, and
 *     adopts it into its own entry at the next write.
 *
 * Backends: the desktop process's own secret store on Tauri (never the
 * remote-routed transport), the service store on a headless Host, Keychain /
 * Keystore on Capacitor, and `web-provider-secret-store.ts` on the web.
 */

import Dexie from "dexie"

import {
  createKeyringStore,
  createLocalKeyringStore,
  type KeyringStore,
} from "@/lib/credentials/keyring-store"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getWindowRole, isSecondaryOverlayRole } from "@/lib/platform/window-role"
import { isCapacitor, isTauri } from "@/lib/tauri"

import { emptySecretSet, type SettingsSecretSet } from "./provider-secret-split"
import { createWebProviderSecretStore } from "./web-provider-secret-store"

export const PROVIDER_SECRETS_NAMESPACE = "cognia-provider-secrets"

/** The persisted row's pointer to its secret blob. Never part of `AppSettings`. */
export interface ProviderSecretsRef {
  /** Database whose secret-store entry holds the blob. */
  db: string
  /** Revision of the blob the row was written with. */
  rev: string
}

/** Row field that carries {@link ProviderSecretsRef}. */
export const PROVIDER_SECRETS_REF_FIELD = "providerSecretsRef"

export interface ProviderSecretBlob {
  v: 1
  db: string
  rev: string
  secrets: SettingsSecretSet
}

/** The secret store could not be read or written; nothing was persisted. */
export class ProviderSecretStoreUnavailableError extends Error {
  readonly code = "PROVIDER_SECRET_STORE_UNAVAILABLE"
  constructor(cause?: unknown) {
    super("The secret store for provider credentials is unavailable.", { cause })
    this.name = "ProviderSecretStoreUnavailableError"
  }
}

export type ProviderSecretResolution =
  | {
      status: "ok"
      /** The blob that applies to the row, or null when it has none. */
      blob: ProviderSecretBlob | null
      /** Set when the blob was found under another database's name (a copy). */
      adoptFrom?: string
    }
  | { status: "unavailable"; error: unknown }

let backendOverride: KeyringStore | null = null
let backend: KeyringStore | null = null

/**
 * Overlay windows (pet, selection toolbar, tray panel, ...) have no
 * `secret_store_*` capability and read no provider credential; asking would
 * only fail one IPC per settings read.
 */
const overlayBackend: KeyringStore = {
  async save() {
    throw new Error("overlay windows cannot reach the secret store")
  },
  async load() {
    throw new Error("overlay windows cannot reach the secret store")
  },
  async delete() {
    throw new Error("overlay windows cannot reach the secret store")
  },
}

function defaultBackend(): KeyringStore {
  if (isTauri() && isSecondaryOverlayRole(getWindowRole())) return overlayBackend
  // The desktop holds keys for the databases of this machine, including the
  // ones it keeps for a remote runtime target; they must never be written
  // through the transport that routes to that remote Host.
  if (isTauri()) return createLocalKeyringStore(PROVIDER_SECRETS_NAMESPACE)
  if (isHeadlessHost() || (typeof isCapacitor === "function" && isCapacitor())) {
    return createKeyringStore(PROVIDER_SECRETS_NAMESPACE)
  }
  return createWebProviderSecretStore()
}

function store(): KeyringStore {
  if (backendOverride) return backendOverride
  backend ??= defaultBackend()
  return backend
}

/** Blob per database name, as last read or written by this process. */
const cache = new Map<string, ProviderSecretBlob | null>()

function isBlob(value: unknown): value is ProviderSecretBlob {
  const blob = value as Partial<ProviderSecretBlob> | null
  return (
    !!blob &&
    blob.v === 1 &&
    typeof blob.db === "string" &&
    typeof blob.rev === "string" &&
    !!blob.secrets &&
    typeof blob.secrets === "object"
  )
}

function normalize(blob: ProviderSecretBlob): ProviderSecretBlob {
  return {
    ...blob,
    secrets: {
      ...emptySecretSet(),
      ...blob.secrets,
      providerSettings: { ...(blob.secrets.providerSettings ?? {}) },
      customProviders: { ...(blob.secrets.customProviders ?? {}) },
    },
  }
}

async function loadBlob(dbName: string, expectedRev?: string): Promise<ProviderSecretBlob | null> {
  if (cache.has(dbName)) {
    const cached = cache.get(dbName) ?? null
    if (expectedRev === undefined || cached?.rev === expectedRev) return cached
  }
  const raw = await store().load(dbName)
  let blob: ProviderSecretBlob | null = null
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw)
    if (!isBlob(parsed)) throw new Error("provider secret blob has an unknown shape")
    blob = normalize(parsed)
  }
  cache.set(dbName, blob)
  return blob
}

/**
 * Find the blob a persisted row expects. A row without a pointer has none: a
 * blob left under the same name by a database that was deleted and created
 * again must not resurface. A blob under another name is used only when its
 * revision matches the pointer, so a row that arrived from another device can
 * never pick up an unrelated blob.
 */
export async function resolveProviderSecrets(
  dbName: string,
  ref: ProviderSecretsRef | undefined
): Promise<ProviderSecretResolution> {
  if (!ref) return { status: "ok", blob: null }
  try {
    const own = await loadBlob(dbName, ref.rev)
    if (own?.rev === ref.rev) return { status: "ok", blob: own }
    if (ref.db !== dbName) {
      const source = await loadBlob(ref.db, ref.rev)
      if (source?.rev === ref.rev) return { status: "ok", blob: source, adoptFrom: ref.db }
    }
    // A crash between the blob write and the row put leaves the row one
    // revision behind its own blob; the blob is still this database's.
    return { status: "ok", blob: own }
  } catch (error) {
    return { status: "unavailable", error }
  }
}

function newRevision(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Write `secrets` as this database's blob under a new revision. Throws
 * {@link ProviderSecretStoreUnavailableError} when the store refuses it.
 */
export async function writeProviderSecrets(
  dbName: string,
  secrets: SettingsSecretSet
): Promise<ProviderSecretsRef> {
  const blob: ProviderSecretBlob = { v: 1, db: dbName, rev: newRevision(), secrets }
  try {
    await store().save(dbName, JSON.stringify(blob))
  } catch (error) {
    cache.delete(dbName)
    throw new ProviderSecretStoreUnavailableError(error)
  }
  cache.set(dbName, blob)
  return { db: dbName, rev: blob.rev }
}

/** Delete one database's blob. Throws {@link ProviderSecretStoreUnavailableError}. */
export async function deleteProviderSecrets(dbName: string): Promise<void> {
  try {
    await store().delete(dbName)
  } catch (error) {
    cache.delete(dbName)
    throw new ProviderSecretStoreUnavailableError(error)
  }
  cache.set(dbName, null)
}

/**
 * Delete the blobs of databases that were deleted. A failure is reported to the
 * caller per database instead of aborting the rest.
 */
export async function forgetProviderSecretsForDatabases(
  dbNames: Iterable<string>
): Promise<{ failed: string[] }> {
  const failed: string[] = []
  for (const name of new Set(dbNames)) {
    try {
      await deleteProviderSecrets(name)
    } catch {
      failed.push(name)
    }
  }
  return { failed }
}

/**
 * Delete a Dexie database together with its provider secret blob. A blob that
 * cannot be removed now is reported, not thrown: the database is already gone,
 * and a database created later under the same name never reads a blob its row
 * does not point at.
 */
export async function deleteDatabaseAndProviderSecrets(name: string): Promise<void> {
  await Dexie.delete(name)
  const { failed } = await forgetProviderSecretsForDatabases([name])
  if (failed.length > 0) {
    console.warn("[provider-secrets] could not remove the secret blob of a deleted database", {
      database: name,
    })
  }
}

/**
 * After a target adopted a copied blob, drop the source entry once the source
 * database is gone. A source that still exists keeps its own blob: it is
 * another live database (two copies never share one entry).
 */
export async function releaseAdoptedProviderSecrets(sourceDb: string): Promise<void> {
  if (await Dexie.exists(sourceDb)) return
  await deleteProviderSecrets(sourceDb)
}

/**
 * Read the blob for a database as it is now, for restore: merge a backup's
 * credentials into it. Throws {@link ProviderSecretStoreUnavailableError}.
 */
export async function readOwnProviderSecrets(dbName: string): Promise<SettingsSecretSet | null> {
  try {
    cache.delete(dbName)
    return (await loadBlob(dbName))?.secrets ?? null
  } catch (error) {
    throw new ProviderSecretStoreUnavailableError(error)
  }
}

/** Test hook: replace the backend (null restores the platform default). */
export function __setProviderSecretBackendForTesting(next: KeyringStore | null): void {
  backendOverride = next
  cache.clear()
}

/** Test hook: forget every cached blob and the chosen backend. */
export function __resetProviderSecretStoreForTesting(): void {
  backendOverride = null
  backend = null
  cache.clear()
}
