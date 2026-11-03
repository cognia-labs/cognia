import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { clearSecret, compareAndSetSecret, getSecret } from "@/lib/keyring"
import { withNamedLock, type NamedLockOptions } from "@/lib/locks/named-lock"
import { isTauri } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import type {
  AuthCredentialSet,
  AuthLineageContext,
  AuthMethod,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"

export class AuthProfileDeleted extends Error {
  constructor() {
    super("Auth profile was deleted")
    this.name = "AuthProfileDeleted"
  }
}

export class CredentialRevisionConflict extends Error {
  constructor() {
    super("Auth credential revision changed")
    this.name = "CredentialRevisionConflict"
  }
}

export class CredentialStoreDegraded extends Error {
  readonly reason = "non-persistent-until-vault-unlock"
  constructor() {
    super("Auth credentials require an unlocked persistent secret store")
    this.name = "CredentialStoreDegraded"
  }
}

export interface HostAuthBackend {
  storeFor(namespace: string): KeyringStore
  lock: typeof withAuthLock
}

let hostAuthBackend: HostAuthBackend | null = null

/** CLI seam: install its durable Node store and cross-process lock at bootstrap.
 * Passing null restores the platform defaults; browser/native imports stay Node-free. */
export function setHostAuthBackend(backend: HostAuthBackend | null): void {
  hostAuthBackend = backend
}

/** Separate IDB databases permit nested lineage → metadata → credential commits. */
export function withAuthLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  category: string
): Promise<T> {
  if (hostAuthBackend) return hostAuthBackend.lock(name, task, category)
  const options: NamedLockOptions = {
    databaseName: `cognia-auth-${category}-locks`,
    waitMs: category === "lineage" ? 65_000 : 5_000,
  }
  if (isHeadlessHost()) options.mode = "in-process"
  return withNamedLock(name, task, options)
}

export interface HostAuthSecretOptions {
  store?: KeyringStore
  native?: boolean
  lock?: typeof withAuthLock
  cas?: typeof compareAndSetSecret
  accountId?: string
}

/**
 * Native reads and CAS share lib/keyring's local IPC target. Other runtimes use
 * createKeyringStore: Browser Vault, Capacitor Keychain, or headless companion
 * RPC. The standalone CLI injects its file backend before creating secrets.
 * lib/keyring's browser passphrase fallback has no headless RPC backend.
 */
export class HostAuthSecrets {
  private readonly store: KeyringStore
  private readonly native: boolean
  private readonly lock: typeof withAuthLock
  private readonly cas: typeof compareAndSetSecret
  private readonly accountId?: string
  constructor(
    readonly namespace: string,
    options: HostAuthSecretOptions = {}
  ) {
    this.accountId = options.accountId
    this.native = options.native ?? isTauri()
    this.store =
      options.store ??
      (this.native
        ? {
            load: (key) => getSecret({ namespace, key }, { strict: true }),
            save: async () => {
              throw new Error("Native auth secrets require CAS")
            },
            delete: (key) => clearSecret({ namespace, key }, { strict: true }),
            isPersistent: () => true,
          }
        : (hostAuthBackend?.storeFor(namespace) ?? createKeyringStore(namespace)))
    this.lock = options.lock ?? hostAuthBackend?.lock ?? withAuthLock
    this.cas = options.cas ?? compareAndSetSecret
  }
  isPersistent(): boolean {
    return this.store.isPersistent?.() !== false
  }
  private assertAccount(): void {
    // BrowserVaultStore follows the active vault; never let an old async flow
    // write into a different profile after an account switch.
    const vault = getActiveBrowserVault()
    if (
      this.accountId &&
      vault &&
      vault.localAccountId !== this.accountId &&
      !this.native &&
      !isHeadlessHost()
    )
      throw new Error("The local profile changed during authentication")
  }
  async read(key: string): Promise<string | null> {
    this.assertAccount()
    const value = await this.store.load(key)
    this.assertAccount()
    return value
  }
  async delete(key: string): Promise<void> {
    this.assertAccount()
    if (this.accountId) {
      await this.inventory(async (record, persist) => {
        await this.store.delete(key)
        record.keys = record.keys.filter((entry) => entry !== key)
        await persist()
      })
    } else {
      await this.store.delete(key)
    }
  }
  /**
   * KeyringStore has no enumeration API. A non-secret inventory in the SAME
   * account namespace makes even orphaned attempt/connection secrets erasable.
   * Register keys before writing; stale inventory entries are safe to retry.
   */
  private inventory<T>(
    task: (
      record: { keys: string[]; deleting?: boolean },
      persist: () => Promise<void>
    ) => Promise<T>
  ): Promise<T> {
    return this.lock(
      `cognia-auth-inventory:${this.namespace}`,
      async () => {
        this.assertAccount()
        let raw = await this.store.load("__host_auth_keys__")
        const record = raw
          ? (JSON.parse(raw) as { keys: string[]; deleting?: boolean })
          : { keys: [] }
        return task(record, async () => {
          const next = JSON.stringify(record)
          await this.compareRaw("__host_auth_keys__", raw, next)
          raw = next
        })
      },
      this.namespace
    )
  }
  /** Fence new writes before enumerating a deleted profile's secrets. */
  beginDeletion(): Promise<string[]> {
    return this.inventory(async (record, persist) => {
      record.deleting = true
      await persist()
      return [...record.keys]
    })
  }
  async compareAndSet(
    key: string,
    expected: string | null,
    value: string,
    requirePersistent = false
  ): Promise<void> {
    if (this.accountId) {
      await this.inventory(async (record, persist) => {
        if (record.deleting) throw new AuthProfileDeleted()
        if (!record.keys.includes(key)) {
          record.keys.push(key)
          // Persist the inventory before creating the secret, even on a crash.
          await persist()
        }
        await this.writeValue(key, expected, value, requirePersistent)
      })
      return
    }
    await this.writeValue(key, expected, value, requirePersistent)
  }
  private async writeValue(
    key: string,
    expected: string | null,
    value: string,
    requirePersistent: boolean
  ): Promise<void> {
    if (requirePersistent && !this.isPersistent()) throw new CredentialStoreDegraded()
    await this.compareRaw(key, expected, value, requirePersistent)
    if (requirePersistent && !this.isPersistent()) throw new CredentialStoreDegraded()
  }
  private async compareRaw(
    key: string,
    expected: string | null,
    value: string,
    requirePersistent = false
  ): Promise<void> {
    this.assertAccount()
    if (this.native) {
      try {
        await this.cas({ namespace: this.namespace, key }, expected, value)
      } catch (error) {
        if (String(error).includes("secret-store condition mismatch"))
          throw new CredentialRevisionConflict()
        throw error
      }
      return
    }
    await this.lock(
      `cognia-auth-credentials:${key}`,
      async (assertHeld) => {
        if ((await this.store.load(key)) !== expected) throw new CredentialRevisionConflict()
        if (requirePersistent && !this.isPersistent()) throw new CredentialStoreDegraded()
        // The vault may have switched profiles while the read was pending.
        this.assertAccount()
        assertHeld()
        await this.store.save(key, value)
        assertHeld()
      },
      this.namespace
    )
  }
}

export interface CredentialSnapshot {
  raw: string | null
  revision: number
  tombstoned?: boolean
  credentials?: AuthCredentialSet
  /** Host-selected method, kept outside provider credential payloads. */
  authMethod?: AuthMethod
  /** Protected revocation context, usable when deleting an inactive profile. */
  lineage?: Omit<AuthLineageContext, "credentials" | "credentialRevision">
}

export class ConnectionCredentialStore {
  constructor(private readonly secrets = accountAuthSecrets("auth-connections")) {}
  isPersistent(): boolean {
    return this.secrets.isPersistent()
  }
  private assertPersistent(): void {
    if (!this.isPersistent()) throw new CredentialStoreDegraded()
  }
  async read(ref: string): Promise<CredentialSnapshot> {
    this.assertPersistent()
    const raw = await this.secrets.read(ref)
    this.assertPersistent()
    if (raw === null) return { raw, revision: 0 }
    const value = JSON.parse(raw) as Omit<CredentialSnapshot, "raw">
    if (
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      (!value.tombstoned &&
        (!value.credentials ||
          typeof value.credentials.accessToken !== "string" ||
          !Array.isArray(value.credentials.scopes)))
    ) {
      throw new Error("Invalid Host auth credential record")
    }
    return { ...value, raw }
  }
  async commit(
    ref: string,
    expected: CredentialSnapshot,
    credentials: AuthCredentialSet,
    lineage = expected.lineage,
    authMethod = expected.authMethod
  ): Promise<CredentialSnapshot> {
    if (expected.tombstoned) throw new CredentialRevisionConflict()
    if (
      !credentials.accessToken ||
      !Array.isArray(credentials.scopes) ||
      credentials.scopes.some((scope) => typeof scope !== "string")
    )
      throw new Error("Invalid Host auth credentials")
    return this.write(ref, expected, { credentials, lineage, authMethod })
  }
  tombstone(ref: string, expected: CredentialSnapshot): Promise<CredentialSnapshot> {
    return this.write(ref, expected, {
      tombstoned: true,
      credentials: expected.credentials,
      lineage: expected.lineage,
      authMethod: expected.authMethod,
    })
  }
  /** Roll back only our unpublished write; never overwrite a later CAS winner.
   * The connection lock still guards publication, so no new metadata revision
   * has been exposed for this tentative credential revision.
   */
  async rollbackUnpublished(
    ref: string,
    committed: CredentialSnapshot,
    previous: CredentialSnapshot
  ): Promise<void> {
    if (previous.raw !== null) {
      await this.secrets.compareAndSet(ref, committed.raw, previous.raw, true)
    } else {
      await this.tombstone(ref, committed)
      await this.delete(ref)
    }
  }
  private async write(
    ref: string,
    expected: CredentialSnapshot,
    value: Pick<CredentialSnapshot, "credentials" | "tombstoned" | "lineage" | "authMethod">
  ): Promise<CredentialSnapshot> {
    this.assertPersistent()
    const record = { revision: expected.revision + 1, ...value }
    const raw = JSON.stringify(record)
    await this.secrets.compareAndSet(ref, expected.raw, raw, true)
    return { ...record, raw }
  }
  delete(ref: string): Promise<void> {
    return this.secrets.delete(ref)
  }
}

export function accountAuthSecrets(
  kind: "auth-connections" | "auth-attempts",
  accountId = getActiveAccountId()
): HostAuthSecrets {
  return new HostAuthSecrets(`${kind}:${accountId}`, { accountId })
}
