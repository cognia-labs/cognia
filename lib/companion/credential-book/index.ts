"use client"

/**
 * Composition root for the credential book (ADR-0097).
 *
 * Picks the platform's stores once and exposes the singleton.
 */
import { isCapacitor } from "@/lib/platform/detect"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

import { createCredentialBook } from "./book"
import {
  LocalStorageHostRecordStore,
  SecureStorageHostCredentialStore,
  SecureStorageHostRecordStore,
  VaultHostCredentialStore,
  type HostCredentialStore,
  type HostRecordStore,
} from "./stores"
import type { CompanionCredentialBook } from "./types"

export * from "./types"
export { createCredentialBook } from "./book"
export {
  CredentialBookCompanionStorage,
  companionCursorNamespace,
  companionHostCredentialFromConfig,
  companionHostDraftFromConfig,
  companionHostIdOf,
  companionHostLabelOf,
  toCompanionConfig,
} from "./adapter"
export * from "./stores"

/**
 * The account a pairing belongs to, resolved from whichever runtime scope is
 * live.
 *
 * The runtime-target context is authoritative when set (it is what the account
 * switch writes); the unlocked Vault is the browser fallback before a target has
 * been activated. `null` means "no account is active yet" — the adapter then
 * reports no pairing rather than guessing one.
 */
export function activeAccountNamespace(): string | null {
  return (
    getActiveRuntimeTargetContext()?.accountId ?? getActiveBrowserVault()?.localAccountId ?? null
  )
}

function pickRecordStore(): HostRecordStore {
  return isCapacitor() ? new SecureStorageHostRecordStore() : new LocalStorageHostRecordStore()
}

function pickCredentialStore(): HostCredentialStore {
  return isCapacitor() ? new SecureStorageHostCredentialStore() : new VaultHostCredentialStore()
}

let bookInstance: CompanionCredentialBook | null = null

export function companionCredentialBook(): CompanionCredentialBook {
  if (!bookInstance) {
    bookInstance = createCredentialBook({
      records: pickRecordStore(),
      credentials: pickCredentialStore(),
    })
  }
  return bookInstance
}

/** Test-only: drop the memoised singleton. */
export function __resetCredentialBookForTests(next: CompanionCredentialBook | null = null): void {
  bookInstance = next
}
