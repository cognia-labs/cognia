import type {
  AuthConnectionIdentity,
  AuthConnectionMetadata,
  AuthConnectionProviderIdentity,
  AuthConnectionRef,
  AuthCredentialSet,
  AuthIdentityDescription,
  AuthLineageContext,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  getProvider,
  AuthRefreshRejected,
  type AuthenticationProvider,
  type AuthSession,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import { getDb } from "@/lib/db/schema"
import { getPlugin } from "@/lib/db/plugins"
import { isClientSecretRequired } from "./client-secrets"
import {
  queueAccessTeardown,
  runAccessTeardown,
  sweepAccessTeardowns,
} from "@/lib/external-services/access-teardown"
import {
  authConnectionIdentityKey,
  findAuthConnection,
  getAuthConnection,
  listAuthConnections,
  putAuthConnection,
  tombstoneAuthConnection,
  type AuthConnectionRow,
} from "@/lib/db/auth-connections"
import {
  ConnectionCredentialStore,
  CredentialRevisionConflict,
  withAuthLock,
  accountAuthSecrets,
  AuthProfileDeleted,
  type CredentialSnapshot,
} from "./connection-credentials"

export { AuthRefreshRejected }

export const AUTH_REFRESH_TIMEOUT_MS = 30_000
export const AUTH_REVOKE_TIMEOUT_MS = 30_000

/** Built-in controllers keep their own CAS/keyring authority; never copy their tokens. */
export interface HostConnectionDriver {
  publisher: string
  synchronize?(row: AuthConnectionRow): Promise<void>
  getCredentials(row: AuthConnectionRow): Promise<AuthCredentialSet>
  disconnect(row: AuthConnectionRow): Promise<void>
  reauthorize?(ref: AuthConnectionRef, options: { ingressBase?: string | null }): Promise<void>
}
const hostDrivers = new Map<string, HostConnectionDriver>()
export function registerHostConnectionDriver(
  providerId: string,
  driver: HostConnectionDriver
): () => void {
  if (hostDrivers.has(providerId)) throw new Error("Host connection driver already registered")
  hostDrivers.set(providerId, driver)
  return () => {
    if (hostDrivers.get(providerId) === driver) hostDrivers.delete(providerId)
  }
}
export function getHostConnectionDriver(providerId: string): HostConnectionDriver | undefined {
  return hostDrivers.get(providerId)
}

export type AuthConnectionChangeKind = "added" | "changed" | "removed"
type ConnectionListener = (metadata: AuthConnectionMetadata, kind: AuthConnectionChangeKind) => void

/** Cleanup must not keep startup or profile deletion waiting forever. */
async function boundedRevoke(task: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Auth revocation timed out")),
          AUTH_REVOKE_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class ConnectionIdentityConflict extends Error {
  constructor() {
    super("This remote identity already belongs to another auth provider")
    this.name = "ConnectionIdentityConflict"
  }
}
export class ConnectionUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Auth connection unavailable: ${reason}`)
    this.name = "ConnectionUnavailableError"
  }
}
export class ReconnectIdentityMismatch extends Error {
  readonly code = "CONFLICT"
  constructor() {
    super("Sign-in returned a different identity from the connection being reconnected")
    this.name = "ReconnectIdentityMismatch"
  }
}
interface ConnectOptions {
  reconnect?: AuthConnectionRef
  signal?: AbortSignal
  expectedRevision?: number
  binding?: { clientId: string; issuer: string }
  /** Publication is the commit point; cancellation after it starts must observe its result. */
  onCommit?: () => void
}
/** A stale response or credential resolution must never cross a connection revision. */
export class ConnectionRevisionChanged extends Error {
  constructor(
    readonly connectionRef: string,
    readonly revision: number,
    readonly currentRevision?: number
  ) {
    super("Auth connection revision changed; discard the result and authorize again")
    this.name = "ConnectionRevisionChanged"
  }
}

export interface AuthConnectionStore {
  get: typeof getAuthConnection
  find: typeof findAuthConnection
  list: typeof listAuthConnections
  put: typeof putAuthConnection
}
interface ManagerOptions {
  store?: AuthConnectionStore
  credentials?: ConnectionCredentialStore
  lock?: typeof withAuthLock
  provider?: typeof getProvider
  providerIdentity?: (provider: AuthenticationProvider) => Promise<AuthConnectionProviderIdentity>
  now?: () => number
}

/** Manifest ownership comes from the installed Host row, never provider-supplied data. */
async function providerIdentity(
  provider: AuthenticationProvider
): Promise<AuthConnectionProviderIdentity> {
  if (provider.pluginId === null)
    return {
      providerId: provider.id,
      ownerPluginId: null,
      publisher: hostDrivers.get(provider.id)?.publisher ?? null,
      contractMajor: 1,
    }
  const plugin = await getPlugin(provider.pluginId)
  if (!plugin) throw new ConnectionUnavailableError("provider-manifest-missing")
  const manifest = plugin.manifest
  const author = manifest.author as string | { name?: string; publicKey?: string } | undefined
  const version = (manifest.providesServices as Record<string, string> | undefined)?.[
    `auth.${provider.id}`
  ]
  const contractMajor = version === undefined ? 1 : Number(version.split(".")[0])
  if (!Number.isSafeInteger(contractMajor) || contractMajor < 1)
    throw new ConnectionUnavailableError("provider-contract-invalid")
  return {
    providerId: provider.id,
    ownerPluginId: provider.pluginId,
    publisher: typeof author === "string" ? author : (author?.publicKey ?? author?.name ?? null),
    contractMajor,
  }
}

function identityOf(row: AuthConnectionRow): AuthConnectionIdentity {
  return {
    provider: {
      providerId: row.providerId,
      ownerPluginId: row.ownerPluginId,
      publisher: row.publisher,
      contractMajor: row.contractMajor,
    },
    issuer: row.issuer,
    clientId: row.clientId,
    tenantId: row.tenantId,
    principal: { id: row.principalId, kind: row.principalKind },
  }
}
function metadata(row: AuthConnectionRow): AuthConnectionMetadata {
  return {
    ref: row.id,
    providerId: row.providerId,
    accountLabel: row.accountLabel,
    principalKind: row.principalKind,
    issuer: row.issuer,
    tenantLabel: row.tenantLabel,
    scopes: [...row.scopes],
    status: row.status,
    revision: row.revision,
  }
}
function sameProvider(row: AuthConnectionRow, owner: AuthConnectionProviderIdentity): boolean {
  return (
    row.providerId === owner.providerId &&
    row.ownerPluginId === owner.ownerPluginId &&
    row.publisher === owner.publisher &&
    row.contractMajor === owner.contractMajor
  )
}
function terminal(row: AuthConnectionRow): boolean {
  return row.status === "revoked" || row.status === "tombstoned"
}
function scopesChanged(a: string[], b: string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) !== JSON.stringify([...new Set(b)].sort())
}
function needsRefresh(credentials: AuthCredentialSet, minValidityMs: number, now: number): boolean {
  return (
    credentials.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(credentials.expiresAt)) ||
      Date.parse(credentials.expiresAt) <= now + minValidityMs)
  )
}
function invalidGrant(error: unknown): boolean {
  if (error instanceof AuthRefreshRejected) return true
  const value = error as { code?: unknown; error?: unknown } | null
  return (
    value?.code === "invalid_grant" ||
    value?.error === "invalid_grant" ||
    isClientSecretRequired(error)
  )
}

/** Host authority. Each instance may be a different tab; only storage CAS decides commits. */
export class AuthConnectionManager {
  private readonly hostPersistence: boolean
  private readonly store: AuthConnectionStore
  private readonly credentials: ConnectionCredentialStore
  private readonly lock: typeof withAuthLock
  private readonly provider: typeof getProvider
  private readonly owner: NonNullable<ManagerOptions["providerIdentity"]>
  private readonly now: () => number
  private readonly listeners = new Set<ConnectionListener>()
  constructor(options: ManagerOptions = {}) {
    this.hostPersistence = !options.store
    const database = options.store ? undefined : getDb()
    this.store = options.store ?? {
      get: (ref) => database!.authConnections.get(ref),
      find: (key) => database!.authConnections.where("identityKey").equals(key).first(),
      list: (providerId) =>
        providerId
          ? database!.authConnections.where("providerId").equals(providerId).toArray()
          : database!.authConnections.toArray(),
      put: async (row) => {
        await database!.transaction(
          "rw",
          database!.authConnections,
          database!.connectionBindings,
          database!.integrationAudit,
          database!.plugins,
          async () => {
            if (!terminal(row) && row.ownerPluginId) {
              const fence = await database!.integrationAudit.get(
                `host-provider-uninstall:${row.ownerPluginId}`
              )
              if (fence) {
                const installed = await database!.plugins.get(row.ownerPluginId)
                if (!installed || installed.createdAt === fence.detail?.installCreatedAt)
                  throw new ConnectionUnavailableError("provider-uninstalling")
              }
            }
            await database!.authConnections.put(row)
            if (terminal(row))
              await database!.connectionBindings.where("connectionRef").equals(row.id).delete()
            if (terminal(row) || row.status === "needs-reauth")
              await queueAccessTeardown({ kind: "connection", ref: row.id })
          }
        )
      },
    }
    this.credentials = options.credentials ?? new ConnectionCredentialStore()
    this.lock = options.lock ?? withAuthLock
    this.provider = options.provider ?? getProvider
    this.owner = options.providerIdentity ?? providerIdentity
    this.now = options.now ?? Date.now
  }
  onDidChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** Host-only connection lookup for injection and revision fences; never exposes credentials. */
  async getConnection(
    ref: AuthConnectionRef,
    expectedRevision?: number
  ): Promise<AuthConnectionRow> {
    const read = async () => {
      const row = await this.store.get(ref)
      if (expectedRevision !== undefined && row?.revision !== expectedRevision)
        throw new ConnectionRevisionChanged(ref, expectedRevision, row?.revision)
      if (!row) throw new ConnectionUnavailableError("unknown")
      if (row.status !== "connected") throw new ConnectionUnavailableError(row.status)
      return row
    }
    const before = await read()
    const provider = await this.requireProvider(before)
    if (before.hostMetadata) await hostDrivers.get(before.providerId)?.synchronize?.(before)
    // Provider ownership may await a manifest read. Re-read after that await,
    // so a disconnect or scope change during validation cannot pass the fence.
    const current = await read()
    if (!sameProvider(current, before) || this.provider(current.providerId) !== provider)
      throw new ConnectionUnavailableError("provider-unavailable")
    return current
  }
  private async publish(
    row: AuthConnectionRow,
    kind: AuthConnectionChangeKind = terminal(row) ? "removed" : "changed"
  ): Promise<void> {
    await this.store.put(row)
    for (const listener of this.listeners) {
      try {
        listener(metadata(row), kind)
      } catch {
        console.warn("Auth connection listener failed")
      }
    }
    if (this.hostPersistence && (terminal(row) || row.status === "needs-reauth")) {
      // Access is already published. Local cleanup failures remain in the
      // durable journal and must not undo it or prevent vendor revocation.
      try {
        await runAccessTeardown({ kind: "connection", ref: row.id })
      } catch {
        console.warn("Auth access cleanup pending")
      }
    }
  }
  private async requireRow(ref: AuthConnectionRef): Promise<AuthConnectionRow> {
    const row = await this.store.get(ref)
    if (!row || terminal(row)) throw new ConnectionUnavailableError(row?.status ?? "unknown")
    return row
  }
  private async requireProvider(row: AuthConnectionRow): Promise<AuthenticationProvider> {
    const provider = this.provider(row.providerId)
    if (
      !provider ||
      !sameProvider(row, await this.owner(provider)) ||
      this.provider(row.providerId) !== provider
    )
      throw new ConnectionUnavailableError("provider-unavailable")
    return provider
  }
  private mutate<T>(ref: string, task: () => Promise<T>): Promise<T> {
    return this.lock(`cognia-auth-connection:${ref}`, task, "connection")
  }
  /** Runtime reconciliation, under the same uniqueness and publication locks as plugin grants. */
  async reconcileHostConnection(
    providerId: string,
    description: AuthIdentityDescription,
    hostMetadata: NonNullable<AuthConnectionRow["hostMetadata"]>,
    available = true
  ): Promise<AuthConnectionRef> {
    const provider = this.provider(providerId)
    if (!provider || provider.pluginId !== null || !hostDrivers.has(providerId))
      throw new ConnectionUnavailableError("provider-unavailable")
    if (
      !description.issuer ||
      !description.clientId ||
      !description.principal.id ||
      !hostMetadata.authorizationEpoch
    )
      throw new ConnectionUnavailableError("provider-description-invalid")
    const owner = await this.owner(provider)
    const identityKey = authConnectionIdentityKey(description)
    return this.lock(
      "cognia-auth-connections:identity",
      async () => {
        const existing = await this.store.find(identityKey)
        if (
          existing &&
          (!sameProvider(existing, owner) ||
            existing.hostMetadata?.adapterId !== hostMetadata.adapterId ||
            existing.tenantId !== description.tenantId)
        )
          throw new ConnectionIdentityConflict()
        const rows = (await this.store.list(providerId)).filter(
          (row) => row.hostMetadata?.adapterId === hostMetadata.adapterId
        )
        // An account switch retires the previous identity without clearing the new native grant.
        for (const old of rows) {
          if (terminal(old) || authConnectionIdentityKey(identityOf(old)) === identityKey) continue
          await this.retireHostConnection(old.id)
        }
        const current =
          existing ?? rows.find((row) => authConnectionIdentityKey(identityOf(row)) === identityKey)
        const ref = current?.id ?? (crypto.randomUUID() as AuthConnectionRef)
        return this.mutate(ref, async () => {
          const latest = await this.store.get(ref)
          // A disconnect fence wins until Rust publishes a NEW authorization epoch.
          if (
            latest &&
            terminal(latest) &&
            latest.hostMetadata?.authorizationEpoch === hostMetadata.authorizationEpoch
          )
            return ref
          const authorizationChanged =
            latest?.hostMetadata?.authorizationEpoch !== hostMetadata.authorizationEpoch
          const scopes = [...new Set(description.scopes)].sort()
          const row: AuthConnectionRow = {
            ...owner,
            id: ref,
            issuer: description.issuer,
            clientId: description.clientId,
            tenantId: description.tenantId,
            tenantLabel: description.tenantLabel,
            principalId: description.principal.id,
            principalKind: description.principal.kind,
            accountLabel: description.accountLabel,
            scopes,
            revision: latest ? latest.revision + Number(authorizationChanged) : 1,
            credentialRevision: latest
              ? latest.credentialRevision +
                Number(latest.hostMetadata?.credentialVersion !== hostMetadata.credentialVersion)
              : 1,
            lineageId: latest?.lineageId ?? crypto.randomUUID(),
            status: !available
              ? "provider-unavailable"
              : !authorizationChanged &&
                  (latest?.status === "needs-reauth" ||
                    latest?.unavailableStatus === "needs-reauth")
                ? "needs-reauth"
                : "connected",
            unavailableStatus: !available
              ? !authorizationChanged &&
                (latest?.status === "needs-reauth" || latest?.unavailableStatus === "needs-reauth")
                ? "needs-reauth"
                : "connected"
              : undefined,
            identityKey,
            hostMetadata,
            createdAt: latest?.createdAt ?? this.now(),
            updatedAt: latest?.updatedAt ?? this.now(),
          }
          if (JSON.stringify(row) !== JSON.stringify(latest)) {
            row.updatedAt = this.now()
            await this.publish(row, latest ? "changed" : "added")
          }
          return ref
        })
      },
      "identity"
    )
  }
  /** Native credential deletion / invalid_grant must invalidate online access too. */
  async retireHostConnection(
    ref: AuthConnectionRef,
    status: "tombstoned" | "needs-reauth" = "tombstoned"
  ): Promise<void> {
    await this.mutate(ref, async () => {
      const row = await this.store.get(ref)
      if (!row?.hostMetadata || terminal(row) || row.status === status) return
      const next = {
        ...row,
        status,
        revision: row.revision + Number(status === "tombstoned"),
        updatedAt: this.now(),
      }
      await this.publish(
        status === "tombstoned" ? tombstoneAuthConnection(next, status, this.now()) : next
      )
    })
  }
  async dropHostConnection(ref: AuthConnectionRef): Promise<void> {
    await this.retireHostConnection(ref)
    if (this.hostPersistence) await getDb().authConnections.delete(ref)
  }
  async createConnectionFromCredentials(
    provider: AuthenticationProvider,
    credentials: AuthCredentialSet,
    options: ConnectOptions = {}
  ): Promise<AuthConnectionRef> {
    let description: AuthIdentityDescription | undefined
    try {
      const registered = this.provider(provider.id)
      if (registered !== provider || !registered.describe)
        throw new ConnectionUnavailableError("provider-not-registered-or-no-describe")
      if (options.reconnect && options.expectedRevision === undefined) {
        const target = await this.store.get(options.reconnect)
        if (target && !terminal(target)) options = { ...options, expectedRevision: target.revision }
      }
      description = await registered.describe(credentials)
      if (
        !description ||
        !description.issuer ||
        !description.clientId ||
        !description.principal?.id ||
        !["user", "bot", "service"].includes(description.principal.kind) ||
        !Array.isArray(description.scopes) ||
        description.scopes.some((scope) => typeof scope !== "string")
      )
        throw new ConnectionUnavailableError("provider-description-invalid")
      if (
        options.binding &&
        (description.issuer !== options.binding.issuer ||
          description.clientId !== options.binding.clientId)
      )
        throw new ConnectionUnavailableError("attempt-identity-mismatch")
      return await this.connect(registered, description, credentials, undefined, options)
    } catch (error) {
      // Fresh credentials rejected by identity checks or a disconnect fence
      // never reach storage. Revoke that fresh grant, not the stored lineage.
      await this.discardCredentials(provider, credentials, description)
      throw error
    }
  }
  /** Best-effort cleanup for an exchange finishing after cancellation, without ever storing it. */
  async discardCredentials(
    provider: AuthenticationProvider,
    credentials: AuthCredentialSet,
    description?: AuthIdentityDescription
  ): Promise<void> {
    try {
      const identity = description ?? (await provider.describe?.(credentials))
      if (!identity) return
      await this.revokeBestEffort(provider, {
        ref: crypto.randomUUID() as AuthConnectionRef,
        lineageId: crypto.randomUUID(),
        credentialRevision: 0,
        identity: { provider: await this.owner(provider), ...identity },
        credentials,
      })
    } catch {
      console.warn("Auth uncommitted credential cleanup failed")
    }
  }
  private async connect(
    provider: AuthenticationProvider,
    description: AuthIdentityDescription,
    credentials?: AuthCredentialSet,
    legacySessionId?: string,
    options: ConnectOptions = {}
  ): Promise<AuthConnectionRef> {
    const owner = await this.owner(provider)
    const identityKey = authConnectionIdentityKey(description)
    return this.lock(
      "cognia-auth-connections:identity",
      async () => {
        if (options.signal?.aborted) throw new ConnectionUnavailableError("cancelled")
        if (options.reconnect) {
          const target = await this.store.get(options.reconnect)
          if (!target) throw new ConnectionUnavailableError("unknown")
          if (
            options.expectedRevision !== undefined &&
            target.revision !== options.expectedRevision
          )
            throw new ConnectionRevisionChanged(
              target.id,
              options.expectedRevision,
              target.revision
            )
          if (
            !sameProvider(target, owner) ||
            authConnectionIdentityKey(identityOf(target)) !== identityKey ||
            target.tenantId !== description.tenantId
          )
            throw new ReconnectIdentityMismatch()
        }
        let existing = await this.store.find(identityKey)
        if (existing && terminal(existing)) {
          const retired = existing
          await this.mutate(retired.id, async () => {
            const current = await this.store.get(retired.id)
            if (!current || !terminal(current))
              throw new ConnectionUnavailableError("identity-changed")
            if (!current.legacySessionId && (await this.credentials.read(current.id)).raw !== null)
              throw new ConnectionUnavailableError("terminal-cleanup-pending")
            // Preserve the opaque ref and tombstone for cleanup/provenance,
            // releasing only its unique identity slot. No schema migration.
            await this.store.put(
              tombstoneAuthConnection(
                current,
                current.status as "revoked" | "tombstoned",
                current.updatedAt
              )
            )
          })
          existing = undefined
        }
        if (existing && !sameProvider(existing, owner)) throw new ConnectionIdentityConflict()
        if (existing && existing.tenantId !== description.tenantId)
          throw new ConnectionIdentityConflict()
        const ref = existing?.id ?? (crypto.randomUUID() as AuthConnectionRef)
        return this.mutate(ref, async () => {
          if (this.provider(provider.id) !== provider)
            throw new ConnectionUnavailableError("provider-unavailable")
          const current = await this.store.get(ref)
          if (current && terminal(current)) throw new ConnectionUnavailableError(current.status)
          if (options.reconnect && current && current.id !== options.reconnect)
            throw new ConnectionUnavailableError("reconnect-replaced")
          if (options.signal?.aborted) throw new ConnectionUnavailableError("cancelled")
          const scopes = [...new Set(description.scopes)].sort()
          const row: AuthConnectionRow = {
            ...owner,
            id: ref,
            issuer: description.issuer,
            clientId: description.clientId,
            tenantId: description.tenantId,
            tenantLabel: description.tenantLabel,
            principalId: description.principal.id,
            principalKind: description.principal.kind,
            accountLabel: description.accountLabel,
            scopes,
            revision: current
              ? current.revision + Number(scopesChanged(current.scopes, scopes))
              : 1,
            credentialRevision: current?.credentialRevision ?? 0,
            lineageId: current?.lineageId ?? crypto.randomUUID(),
            status: "connected",
            identityKey,
            legacySessionId,
            createdAt: current?.createdAt ?? this.now(),
            updatedAt: this.now(),
          }
          let committed: CredentialSnapshot | undefined
          let previous: CredentialSnapshot | undefined
          if (credentials) {
            previous = await this.credentials.read(ref)
            if (options.signal?.aborted) throw new ConnectionUnavailableError("cancelled")
            const next = await this.credentials.commit(
              ref,
              previous,
              { ...credentials, scopes },
              {
                ref,
                lineageId: row.lineageId,
                identity: identityOf(row),
              }
            )
            row.credentialRevision = next.revision
            committed = next
          }
          if (this.provider(provider.id) !== provider) {
            row.status = "provider-unavailable"
            row.unavailableStatus = "connected"
          }
          try {
            if (options.signal?.aborted) throw new ConnectionUnavailableError("cancelled")
            options.onCommit?.()
            await this.publish(row, current ? "changed" : "added")
          } catch (error) {
            if (committed && previous)
              await this.credentials.rollbackUnpublished(ref, committed, previous)
            throw error
          }
          return ref
        })
      },
      "identity"
    )
  }
  async getCredentials(
    ref: AuthConnectionRef,
    options: { minValidityMs?: number } = {}
  ): Promise<AuthCredentialSet> {
    let row = await this.requireRow(ref)
    let provider = await this.requireProvider(row)
    if (row.hostMetadata) {
      row = await this.getConnection(ref, row.revision)
      const driver = hostDrivers.get(row.providerId)
      if (!driver) throw new ConnectionUnavailableError("provider-unavailable")
      const credentials = await driver.getCredentials(row)
      await this.getConnection(ref, row.revision)
      return credentials
    }
    if (row.legacySessionId) {
      const session = (await provider.getSessions(undefined, { silent: true })).find(
        (session) => session.id === row.legacySessionId
      )
      if (!session) throw new ConnectionUnavailableError("legacy-session-missing")
      const resolved = provider.resolveRequestCredential
        ? await provider.resolveRequestCredential(session.id, {
            connectorAccountId: ref,
            origin: row.issuer,
          })
        : session
      await this.requireRow(ref)
      return {
        accessToken: resolved.accessToken,
        expiresAt: "expiresAt" in resolved ? resolved.expiresAt : undefined,
        scopes: [...session.scopes],
      }
    }
    const read = async () => {
      const snapshot = await this.credentials.read(ref)
      if (snapshot.tombstoned || !snapshot.credentials)
        throw new ConnectionUnavailableError("credentials-removed")
      return snapshot as typeof snapshot & { credentials: AuthCredentialSet }
    }
    let snapshot = await read()
    const minValidityMs = Math.max(0, options.minValidityMs ?? 0)
    if (!needsRefresh(snapshot.credentials, minValidityMs, this.now())) return snapshot.credentials
    return this.lock(
      `cognia-auth-lineage:${row.lineageId}`,
      async () => {
        row = await this.requireRow(ref)
        provider = await this.requireProvider(row)
        snapshot = await read()
        if (!needsRefresh(snapshot.credentials, minValidityMs, this.now()))
          return snapshot.credentials
        if (!provider.refresh || row.status === "needs-reauth")
          throw new ConnectionUnavailableError("needs-reauth")
        const context: AuthLineageContext = {
          ref,
          lineageId: row.lineageId,
          credentialRevision: snapshot.revision,
          identity: identityOf(row),
          credentials: snapshot.credentials,
        }
        let refreshed: AuthCredentialSet
        try {
          refreshed = await this.refresh(provider, context)
        } catch (error) {
          if (invalidGrant(error))
            await this.mutate(ref, async () => {
              const current = await this.store.get(ref)
              const latest = await this.credentials.read(ref)
              if (current && !terminal(current) && latest.raw === snapshot.raw)
                await this.publish({ ...current, status: "needs-reauth", updatedAt: this.now() })
            })
          throw error
        }
        refreshed = {
          ...refreshed,
          refreshToken: refreshed.refreshToken ?? snapshot.credentials.refreshToken,
        }
        try {
          return await this.mutate(ref, async () => {
            const current = await this.requireRow(ref)
            let available = true
            try {
              await this.requireProvider(current)
            } catch {
              available = false
            }
            let committed
            try {
              // Persist a rotated refresh token even when its provider just
              // unregistered. The CAS still enforces the disconnect barrier.
              committed = await this.credentials.commit(ref, snapshot, refreshed)
            } catch (error) {
              if (!(error instanceof CredentialRevisionConflict)) throw error
              await this.requireRow(ref)
              const winner = await read()
              if (!available) throw new ConnectionUnavailableError("provider-unavailable")
              return winner.credentials
            }
            await this.publish({
              ...current,
              credentialRevision: committed.revision,
              scopes: [...refreshed.scopes],
              revision: current.revision + Number(scopesChanged(current.scopes, refreshed.scopes)),
              status: available ? "connected" : "provider-unavailable",
              unavailableStatus: available ? undefined : "connected",
              updatedAt: this.now(),
            })
            if (!available) throw new ConnectionUnavailableError("provider-unavailable")
            return refreshed
          })
        } catch (error) {
          // Disconnect may have won while the vendor was rotating. Its old
          // token cannot revoke this newly issued lineage on our behalf.
          if (error instanceof AuthProfileDeleted) {
            await this.revokeBestEffort(provider, { ...context, credentials: refreshed })
            throw new ConnectionUnavailableError("profile-deleted")
          }
          const current = await this.store.get(ref)
          // A terminal row is already sufficient evidence. The secret store
          // may have locked during logout; reading it must not skip revocation
          // or replace the original connection-unavailable error.
          if (!current || terminal(current)) {
            await this.revokeBestEffort(provider, { ...context, credentials: refreshed })
          } else {
            const latest = await this.credentials.read(ref)
            if (latest.tombstoned)
              await this.revokeBestEffort(provider, { ...context, credentials: refreshed })
          }
          throw error
        }
      },
      "lineage"
    )
  }
  async disconnect(ref: AuthConnectionRef, options: { revoke?: boolean } = {}): Promise<void> {
    const hostRow = await this.store.get(ref)
    if (hostRow?.hostMetadata) {
      let retired = hostRow
      await this.mutate(ref, async () => {
        const current = await this.store.get(ref)
        if (!current?.hostMetadata) return
        retired = current
        if (!terminal(current))
          await this.publish(
            tombstoneAuthConnection(
              { ...current, revision: current.revision + 1 },
              "tombstoned",
              this.now()
            )
          )
      })
      const driver = hostDrivers.get(hostRow.providerId)
      if (!driver) throw new ConnectionUnavailableError("provider-unavailable")
      await driver.disconnect(retired)
      return
    }
    let context: AuthLineageContext | undefined
    let provider: AuthenticationProvider | undefined
    let legacySessionId: string | undefined
    let disconnected = false
    await this.mutate(ref, async () => {
      const row = await this.store.get(ref)
      if (!row || row.status === "revoked") return
      disconnected = true
      try {
        provider = await this.requireProvider(row)
      } catch {
        provider = undefined
      }
      legacySessionId = row.legacySessionId
      let previous = legacySessionId
        ? ({ raw: null, revision: 0 } as import("./connection-credentials").CredentialSnapshot)
        : await this.credentials.read(ref)
      if (!legacySessionId && !previous.tombstoned && !terminal(row)) {
        for (;;) {
          try {
            await this.credentials.tombstone(ref, previous)
            break
          } catch (error) {
            if (!(error instanceof CredentialRevisionConflict)) throw error
            previous = await this.credentials.read(ref)
            if (previous.tombstoned) break
          }
        }
      }
      if (previous.credentials)
        context = {
          ref,
          lineageId: row.lineageId,
          credentialRevision: previous.revision,
          identity: identityOf(row),
          credentials: previous.credentials,
        }
      await this.publish(
        tombstoneAuthConnection(
          {
            ...row,
            credentialRevision: Math.max(
              row.credentialRevision,
              previous.revision + Number(!previous.tombstoned && !terminal(row))
            ),
            revision: row.revision + Number(!terminal(row)),
          },
          "tombstoned",
          row.status === "tombstoned" ? row.updatedAt : this.now()
        )
      )
    })
    if (!disconnected) return
    let revoked = false
    let failure: unknown
    try {
      if (options.revoke && provider) {
        if (context && provider.revoke) {
          await boundedRevoke(() => provider!.revoke!(context!))
          revoked = true
        } else if (legacySessionId) {
          await boundedRevoke(() => provider!.removeSession(legacySessionId!))
          revoked = true
        }
      }
    } catch (error) {
      failure = error
    }
    await this.mutate(ref, async () => {
      const row = await this.store.get(ref)
      if (!row || !terminal(row)) return
      // Keep failed/unavailable revocations retryable, including their tokens.
      // A deliberate local-only disconnect discards its secret immediately.
      if (!legacySessionId && (revoked || !options.revoke)) await this.credentials.delete(ref)
      const status = revoked || row.status === "revoked" ? "revoked" : "tombstoned"
      // Cleanup/revocation stays retryable, but repeating an already-published
      // terminal state does not change its metadata or disconnect timestamp.
      await this.publish(
        tombstoneAuthConnection(row, status, row.status === status ? row.updatedAt : this.now())
      )
    })
    if (failure) throw failure
  }
  /** Recover secrets left behind by an interrupted disconnect, once at boot. */
  async sweepTombstoned(): Promise<void> {
    for (const row of await this.store.list()) {
      if (row.status !== "tombstoned") continue
      try {
        try {
          await this.disconnect(row.id, { revoke: true })
        } finally {
          // Startup recovery also discards tokens if the vendor is unavailable.
          if (!row.hostMetadata) await this.mutate(row.id, () => this.credentials.delete(row.id))
        }
      } catch {
        console.warn("Auth tombstone cleanup failed")
      }
    }
    if (this.hostPersistence) await sweepAccessTeardowns()
  }

  /** Uninstall runs before provider deactivation. Disable never calls this. */
  async uninstallProviderConnections(pluginId: string): Promise<void> {
    if (this.hostPersistence) {
      const db = getDb()
      await db.transaction("rw", db.authConnections, db.integrationAudit, db.plugins, async () => {
        const installed = await db.plugins.get(pluginId)
        await db.integrationAudit.put({
          id: `host-provider-uninstall:${pluginId}`,
          pluginId,
          integrationId: "__host__",
          kind: "auth.provider-uninstalling",
          outcome: "allowed",
          createdAt: new Date(this.now()).toISOString(),
          detail: { installCreatedAt: installed?.createdAt },
        })
      })
    }
    for (const row of await this.store.list()) {
      if (row.ownerPluginId !== pluginId) continue
      if (terminal(row)) {
        await this.mutate(row.id, () => this.credentials.delete(row.id))
        continue
      }
      let vendorRevocation = "unavailable"
      try {
        await this.disconnect(row.id, { revoke: true })
        if ((await this.store.get(row.id))?.status === "revoked") vendorRevocation = "succeeded"
      } catch {
        vendorRevocation = "failed"
      }
      // Uninstall is terminal even when disabled or the vendor is offline.
      // A later provider owner must never inherit credentials or old refs.
      await this.disconnect(row.id)
      await this.mutate(row.id, () => this.credentials.delete(row.id))
      if (this.hostPersistence) {
        const { appendIntegrationAudit } = await import("@/lib/db/integrations")
        await appendIntegrationAudit({
          pluginId,
          integrationId: "__host__",
          kind: "auth.provider-uninstalled",
          outcome: vendorRevocation === "succeeded" ? "succeeded" : "denied",
          detail: { connectionRef: row.id, vendorRevocation },
        })
      }
    }
  }
  private async revokeBestEffort(
    provider: AuthenticationProvider,
    context: AuthLineageContext
  ): Promise<void> {
    try {
      if (provider.revoke) await boundedRevoke(() => provider.revoke!(context))
    } catch {
      console.warn("Auth lineage revocation failed")
    }
  }
  private async refresh(
    provider: AuthenticationProvider,
    context: AuthLineageContext
  ): Promise<AuthCredentialSet> {
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = Promise.resolve().then(() =>
      provider.refresh!({ ...context, signal: controller.signal })
    )
    // Providers that ignore AbortSignal may finish after the lock is released.
    // Never commit such a result; best-effort revoke the credentials instead.
    void pending.then(
      async (credentials) => {
        if (timedOut)
          await this.revokeBestEffort(provider, {
            ...context,
            credentials: {
              ...credentials,
              refreshToken: credentials.refreshToken ?? context.credentials.refreshToken,
            },
          })
      },
      () => {}
    )
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            const error = new Error("Auth refresh timed out")
            error.name = "AuthRefreshTimeout"
            controller.abort(error)
            reject(error)
          }, AUTH_REFRESH_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async markProviderUnavailable(providerId: string): Promise<void> {
    for (const row of await this.store.list(providerId))
      await this.mutate(row.id, async () => {
        const current = await this.store.get(row.id)
        if (current && !terminal(current))
          await this.publish({
            ...current,
            unavailableStatus:
              current.status === "needs-reauth"
                ? "needs-reauth"
                : (current.unavailableStatus ?? "connected"),
            status: "provider-unavailable",
            updatedAt: this.now(),
          })
      })
  }
  async restoreProvider(providerId: string): Promise<void> {
    for (const row of await this.store.list(providerId))
      await this.mutate(row.id, async () => {
        const current = await this.store.get(row.id)
        if (current?.status !== "provider-unavailable") return
        try {
          await this.requireProvider(current)
        } catch {
          return
        }
        const snapshot = current.legacySessionId
          ? undefined
          : await this.credentials.read(current.id)
        await this.publish({
          ...current,
          status:
            current.unavailableStatus === "needs-reauth"
              ? "needs-reauth"
              : current.legacySessionId || (snapshot?.credentials && !snapshot.tombstoned)
                ? "connected"
                : "needs-reauth",
          unavailableStatus: undefined,
          updatedAt: this.now(),
        })
      })
  }
  async ensureLegacyConnection(
    providerId: string,
    session: AuthSession,
    options: ConnectOptions = {}
  ): Promise<AuthConnectionRef> {
    const provider = this.provider(providerId)
    if (!provider) throw new ConnectionUnavailableError("provider-unavailable")
    if (provider.describe)
      throw new Error("Host-managed providers must create connections from credentials")
    const previous = options.reconnect ? await this.store.get(options.reconnect) : undefined
    let principalId = JSON.stringify([session.account.id, session.id])
    if (previous?.legacySessionId) {
      const original = JSON.parse(previous.principalId) as string[]
      if (original[0] === session.account.id) principalId = previous.principalId
    }
    return this.connect(
      provider,
      {
        issuer: `provider:${providerId}`,
        clientId: "legacy",
        principal: { id: principalId, kind: "user" },
        accountLabel: session.account.label,
        scopes: session.scopes,
      },
      undefined,
      session.id,
      options
    )
  }
}

const managers = new WeakMap<object, AuthConnectionManager>()
export function getConnectionManager(): AuthConnectionManager {
  const database = getDb()
  let manager = managers.get(database)
  if (!manager) {
    manager = new AuthConnectionManager()
    managers.set(database, manager)
  }
  return manager
}
export const createConnectionFromCredentials = (
  provider: AuthenticationProvider,
  credentials: AuthCredentialSet,
  options?: ConnectOptions
) => getConnectionManager().createConnectionFromCredentials(provider, credentials, options)
export const getCredentials = (ref: AuthConnectionRef, options?: { minValidityMs?: number }) =>
  getConnectionManager().getCredentials(ref, options)
export const disconnect = (ref: AuthConnectionRef, options?: { revoke?: boolean }) =>
  getConnectionManager().disconnect(ref, options)
export const markProviderUnavailable = (providerId: string) =>
  getConnectionManager().markProviderUnavailable(providerId)
export const ensureLegacyConnection = (providerId: string, session: AuthSession) =>
  getConnectionManager().ensureLegacyConnection(providerId, session)
export const onDidChange = (listener: (metadata: AuthConnectionMetadata) => void) =>
  getConnectionManager().onDidChange(listener)

export const sweepTombstoned = () => getConnectionManager().sweepTombstoned()

export interface ProfileAuthCleanupReport {
  failures: string[]
  tokensMayRemainLive: boolean
}

/** Profile deletion can address inactive accounts without opening their DB. */
export async function forgetProfileAuthSecrets(
  accountId: string,
  options: {
    secrets?: typeof accountAuthSecrets
    provider?: typeof getProvider
    providerIdentity?: typeof providerIdentity
  } = {}
): Promise<ProfileAuthCleanupReport> {
  const report: ProfileAuthCleanupReport = { failures: [], tokensMayRemainLive: false }
  for (const kind of ["auth-connections", "auth-attempts"] as const) {
    try {
      const secrets = (options.secrets ?? accountAuthSecrets)(kind, accountId)
      const keys = await secrets.beginDeletion()
      for (const key of keys) {
        try {
          if (kind === "auth-connections") {
            const raw = await secrets.read(key)
            if (raw) {
              const record = JSON.parse(raw) as CredentialSnapshot
              if (record.credentials) {
                const lineage = record.lineage
                const expected = lineage?.identity.provider
                const provider = expected && (options.provider ?? getProvider)(expected.providerId)
                const owner =
                  provider && (await (options.providerIdentity ?? providerIdentity)(provider))
                if (
                  provider?.revoke &&
                  lineage &&
                  owner &&
                  expected &&
                  owner.providerId === expected.providerId &&
                  owner.ownerPluginId === expected.ownerPluginId &&
                  owner.publisher === expected.publisher &&
                  owner.contractMajor === expected.contractMajor
                ) {
                  const context = {
                    ...lineage,
                    credentialRevision: record.revision,
                    credentials: record.credentials,
                  }
                  await boundedRevoke(() => provider.revoke!(context))
                } else {
                  throw new Error("Auth provider unavailable for profile revocation")
                }
              }
            }
          }
        } catch {
          report.failures.push(`${kind}: revocation unavailable`)
          report.tokensMayRemainLive = true
        } finally {
          try {
            await secrets.delete(key)
          } catch {
            report.failures.push(`${kind}: secret deletion failed`)
            report.tokensMayRemainLive = true
          }
        }
      }
    } catch {
      report.failures.push(`${kind}: secret inventory unavailable`)
      report.tokensMayRemainLive = true
    }
  }
  return report
}
