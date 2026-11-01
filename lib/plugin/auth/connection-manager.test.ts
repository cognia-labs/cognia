import "fake-indexeddb/auto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createCliFileLock, FileLockLostError } from "@/cli/src/plugin/file-lock"
import { withNamedLock } from "@/lib/locks/named-lock"
import {
  AuthConnectionManager,
  ConnectionIdentityConflict,
  ConnectionUnavailableError,
  ConnectionRevisionChanged,
  AUTH_REFRESH_TIMEOUT_MS,
  AUTH_REVOKE_TIMEOUT_MS,
  AuthRefreshRejected,
  forgetProfileAuthSecrets,
  registerHostConnectionDriver,
} from "./connection-manager"
import { ConnectionCredentialStore, HostAuthSecrets } from "./connection-credentials"
import { authConnectionIdentityKey, type AuthConnectionRow } from "@/lib/db/auth-connections"
import type { AuthenticationProvider } from "./auth-provider-registry"
import type {
  AuthCredentialSet,
  AuthLineageContext,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getPlugin } from "@/lib/db/plugins"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { registerDerivedDataPurger } from "@/lib/external-services/derived-data-registry"
import {
  createIntegrationAccount,
  createIntegrationSubscription,
  enqueueIntegrationActionJob,
} from "@/lib/db/integrations"

jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))

const old: AuthCredentialSet = {
  accessToken: "old",
  refreshToken: "old-refresh",
  scopes: ["read"],
  expiresAt: "2000-01-01T00:00:00Z",
}
const fresh: AuthCredentialSet = {
  accessToken: "new",
  refreshToken: "rotated-refresh",
  scopes: ["read"],
  expiresAt: "2100-01-01T00:00:00Z",
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function fixture() {
  const rows = new Map<string, AuthConnectionRow>()
  const tokens = new Map<string, string>()
  const providers = new Map<string, AuthenticationProvider>()
  const store = {
    get: async (id: string) => rows.get(id),
    find: async (key: string) => [...rows.values()].find((row) => row.identityKey === key),
    list: async (id?: string) => [...rows.values()].filter((row) => !id || row.providerId === id),
    put: async (row: AuthConnectionRow) => {
      rows.set(row.id, structuredClone(row))
    },
  }
  const keyring = {
    load: async (key: string) => tokens.get(key) ?? null,
    save: async (key: string, value: string) => {
      tokens.set(key, value)
    },
    delete: async (key: string) => {
      tokens.delete(key)
    },
    isPersistent: () => true,
  }
  const credentials = new ConnectionCredentialStore(
    new HostAuthSecrets("auth-connections", { store: keyring, native: false })
  )
  const makeManager = (
    useManifest = false,
    lock?: typeof import("./connection-credentials").withAuthLock,
    now?: () => number
  ) =>
    new AuthConnectionManager({
      store,
      credentials,
      lock,
      now,
      provider: (id) => providers.get(id),
      providerIdentity: useManifest
        ? undefined
        : async (provider) => ({
            providerId: provider.id,
            ownerPluginId: provider.pluginId,
            publisher: "pub",
            contractMajor: 1,
          }),
    })
  const provider: AuthenticationProvider = {
    id: "acme",
    label: "Acme",
    pluginId: "owner",
    getSessions: async () => [],
    createSession: async () => {
      throw new Error("unused")
    },
    removeSession: jest.fn(),
    refresh: jest.fn(async () => fresh),
    describe: jest.fn(async (credentials) => ({
      issuer: "https://issuer",
      clientId: "client",
      principal: { kind: "user" as const, id: "user" },
      accountLabel: "Account",
      scopes: credentials.scopes,
    })),
  }
  providers.set(provider.id, provider)
  return {
    rows,
    tokens,
    provider,
    providers,
    credentials,
    store,
    manager: makeManager(),
    makeManager,
  }
}

it("reconciles Rust-owned credentials without copying them into the connection keyring", async () => {
  const f = fixture()
  f.provider.pluginId = null
  const dispose = registerHostConnectionDriver("acme", {
    publisher: "cognia",
    getCredentials: async () => fresh,
    disconnect: jest.fn(),
  })
  try {
    const manager = f.makeManager(true)
    const description = await f.provider.describe!(fresh)
    const state = {
      adapterId: "adapter",
      authorizationEpoch: "epoch-1",
      credentialVersion: "r1",
      bot: true,
    }
    const ref = await manager.reconcileHostConnection("acme", description, state)
    const first = structuredClone(f.rows.get(ref)!)
    expect(first).toMatchObject({ publisher: "cognia", revision: 1, credentialRevision: 1 })
    await manager.reconcileHostConnection("acme", description, state)
    expect(f.rows.get(ref)).toEqual(first)
    await manager.reconcileHostConnection("acme", description, {
      ...state,
      credentialVersion: "r2",
    })
    expect(f.rows.get(ref)).toMatchObject({ revision: 1, credentialRevision: 2 })
    await manager.reconcileHostConnection("acme", description, {
      ...state,
      authorizationEpoch: "epoch-2",
      credentialVersion: "r3",
    })
    expect(f.rows.get(ref)).toMatchObject({ revision: 2, credentialRevision: 3 })
    expect(await manager.getCredentials(ref)).toEqual(fresh)
    expect(f.tokens.size).toBe(0)
    await manager.disconnect(ref)
    expect(f.rows.get(ref)?.status).toBe("tombstoned")
    await manager.reconcileHostConnection("acme", description, {
      ...state,
      authorizationEpoch: "epoch-2",
      credentialVersion: "r3",
    })
    expect(f.rows.get(ref)?.status).toBe("tombstoned")
  } finally {
    dispose()
  }
})

it("atomically removes all default-store bindings when a connection becomes terminal", async () => {
  const dbFixture = createDbTestFixture()
  await dbFixture.initialize()
  try {
    const f = fixture()
    const manager = new AuthConnectionManager({
      credentials: f.credentials,
      provider: (id) => f.providers.get(id),
      providerIdentity: async (provider) => ({
        providerId: provider.id,
        ownerPluginId: provider.pluginId,
        publisher: "pub",
        contractMajor: 1,
      }),
    })
    const ref = await manager.createConnectionFromCredentials(f.provider, fresh)
    const account = await createIntegrationAccount("consumer", {
      integrationId: "items",
      providerId: f.provider.id,
      authSessionId: "unused",
      connectionId: ref,
      remoteAccountId: "user",
      label: "User",
    })
    await createIntegrationSubscription("consumer", {
      integrationId: "items",
      accountId: account.id,
      eventTypes: ["changed"],
    })
    const job = await enqueueIntegrationActionJob({
      pluginId: "consumer",
      integrationId: "items",
      accountId: account.id,
      actionId: "write",
      input: {},
      status: "running",
      risk: "write",
      source: "manual",
      attempts: 1,
      maxAttempts: 3,
      remoteWriteStartedAt: "2026-11-01T00:00:00Z",
    })
    await getDb().integrationEvents.put({
      schemaVersion: 1,
      id: "derived-event",
      pluginId: "consumer",
      integrationId: "items",
      accountId: account.id,
      deliveryId: "delivery",
      eventType: "changed",
      payload: {},
      occurredAt: "",
      receivedAt: "",
    })
    await getDb().connectionBindings.bulkPut(
      ["one", "two"].map((consumerPluginId) => ({
        consumerPluginId,
        providerId: f.provider.id,
        connectionRef: ref,
        createdAt: 1,
        updatedAt: 1,
      }))
    )
    await manager.disconnect(ref)
    expect(await getDb().connectionBindings.count()).toBe(0)
    expect((await getDb().authConnections.get(ref))?.status).toBe("tombstoned")
    expect(
      await getDb().integrationSubscriptions.where("accountId").equals(account.id).count()
    ).toBe(0)
    expect(await getDb().integrationActionJobs.get(job.id)).toMatchObject({
      status: "cancelled",
      remoteOutcome: "unknown",
    })
    expect(await getDb().integrationEvents.get("derived-event")).toBeUndefined()
  } finally {
    await dbFixture.dispose()
  }
})

it("startup retries a failed local purge after vendor revocation without revoking twice", async () => {
  const dbFixture = createDbTestFixture()
  await dbFixture.initialize()
  const purge = jest.fn().mockRejectedValue(new Error("temporary"))
  const dispose = registerDerivedDataPurger({ id: "retry-test", purge })
  try {
    const f = fixture()
    f.provider.revoke = jest.fn(async () => {})
    const manager = new AuthConnectionManager({
      credentials: f.credentials,
      provider: (id) => f.providers.get(id),
      providerIdentity: async (provider) => ({
        providerId: provider.id,
        ownerPluginId: provider.pluginId,
        publisher: "pub",
        contractMajor: 1,
      }),
    })
    const ref = await manager.createConnectionFromCredentials(f.provider, fresh)
    await manager.disconnect(ref, { revoke: true })
    expect(await getDb().authConnections.get(ref)).toMatchObject({ status: "revoked" })
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(1)
    purge.mockResolvedValue(undefined)
    await manager.sweepTombstoned()
    expect(f.provider.revoke).toHaveBeenCalledTimes(1)
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(0)
  } finally {
    dispose()
    await dbFixture.dispose()
  }
})

it.each([true, false])(
  "provider uninstall loaded=%s removes credentials and retires refs",
  async (loaded) => {
    const f = fixture()
    f.provider.revoke = jest.fn(async () => {})
    const refs = [await f.manager.createConnectionFromCredentials(f.provider, fresh)]
    f.provider.describe = jest.fn(async () => ({
      issuer: "https://issuer",
      clientId: "second-client",
      principal: { kind: "user" as const, id: "user" },
      accountLabel: "Second",
      scopes: ["read"],
    }))
    refs.push(await f.manager.createConnectionFromCredentials(f.provider, fresh))
    if (!loaded) {
      f.providers.clear()
      await f.manager.markProviderUnavailable(f.provider.id)
    }
    await f.manager.uninstallProviderConnections("owner")
    await f.manager.uninstallProviderConnections("owner")
    expect(f.provider.revoke).toHaveBeenCalledTimes(loaded ? 2 : 0)
    expect(f.tokens.size).toBe(0)
    for (const ref of refs)
      expect(f.rows.get(ref)).toMatchObject({
        status: loaded ? "revoked" : "tombstoned",
        identityKey: `tombstoned:${ref}`,
      })
    f.providers.set(f.provider.id, { ...f.provider, pluginId: "new-owner" })
    const next = await f.manager.createConnectionFromCredentials(
      f.providers.get(f.provider.id)!,
      fresh
    )
    expect(refs).not.toContain(next)
  }
)

it("provider disable/enable round-trip keeps credentials and revision", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  const before = await f.credentials.read(ref)
  f.providers.clear()
  await f.manager.markProviderUnavailable(f.provider.id)
  expect(f.rows.get(ref)).toMatchObject({ status: "provider-unavailable", revision: 1 })
  expect(await f.credentials.read(ref)).toEqual(before)
  f.providers.set(f.provider.id, f.provider)
  await f.manager.restoreProvider(f.provider.id)
  expect(f.rows.get(ref)).toMatchObject({ status: "connected", revision: 1 })
  expect(await f.credentials.read(ref)).toEqual(before)
})

it("fences a sign-in publishing during provider uninstall across manager instances", async () => {
  const dbFixture = createDbTestFixture()
  await dbFixture.initialize()
  try {
    const f = fixture()
    const options = {
      credentials: f.credentials,
      provider: (id: string) => f.providers.get(id),
      providerIdentity: async (provider: AuthenticationProvider) => ({
        providerId: provider.id,
        ownerPluginId: provider.pluginId,
        publisher: "pub",
        contractMajor: 1,
      }),
    }
    const manager = new AuthConnectionManager(options)
    const second = new AuthConnectionManager(options)
    const first = await manager.createConnectionFromCredentials(f.provider, fresh)
    const entered = deferred<void>()
    const release = deferred<void>()
    f.provider.revoke = jest.fn(async (context: AuthLineageContext) => {
      if (context.ref === first) {
        entered.resolve()
        await release.promise
      }
    })
    const uninstall = manager.uninstallProviderConnections("owner")
    await entered.promise
    f.provider.describe = jest.fn(async () => ({
      issuer: "https://issuer",
      clientId: "late-client",
      principal: { kind: "user" as const, id: "user" },
      accountLabel: "Late",
      scopes: ["read"],
    }))
    await expect(
      second.createConnectionFromCredentials(f.provider, { ...fresh, accessToken: "late" })
    ).rejects.toThrow("provider-uninstalling")
    release.resolve()
    await uninstall
    expect(await getDb().authConnections.count()).toBe(1)
    expect(f.tokens.size).toBe(0)
    expect(
      await getDb().integrationAudit.where("kind").equals("auth.provider-uninstalled").first()
    ).toMatchObject({ detail: { vendorRevocation: "succeeded" } })
    // A fresh installation of the same package is a new owner generation.
    await getDb().plugins.put({
      id: "owner",
      createdAt: Date.now(),
    } as import("@/lib/db/plugin-types").PluginRow)
    const reinstalled = await second.createConnectionFromCredentials(f.provider, fresh)
    expect(reinstalled).not.toBe(first)
    f.providers.clear()
    await second.markProviderUnavailable(f.provider.id)
    await second.uninstallProviderConnections("owner")
    expect(f.tokens.size).toBe(0)
    expect(
      await getDb()
        .integrationAudit.where("kind")
        .equals("auth.provider-uninstalled")
        .filter((row) => row.detail?.vendorRevocation === "unavailable")
        .count()
    ).toBe(1)
  } finally {
    await dbFixture.dispose()
  }
})

it("exposes Host metadata only for a connected connection with its original provider", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  expect(await f.manager.getConnection(ref)).toMatchObject({
    id: ref,
    ownerPluginId: "owner",
    revision: 1,
  })
  expect(JSON.stringify(await f.manager.getConnection(ref))).not.toMatch(/accessToken|refreshToken/)
  for (const status of ["needs-reauth", "provider-unavailable", "tombstoned", "revoked"] as const) {
    f.rows.set(ref, { ...f.rows.get(ref)!, status })
    await expect(f.manager.getConnection(ref)).rejects.toMatchObject({
      name: "ConnectionUnavailableError",
      reason: status,
    })
  }
  f.rows.set(ref, { ...f.rows.get(ref)!, status: "connected" })
  f.providers.clear()
  await expect(f.manager.getConnection(ref)).rejects.toBeInstanceOf(ConnectionUnavailableError)
  f.rows.clear()
  await expect(f.manager.getConnection(ref)).rejects.toMatchObject({ reason: "unknown" })
})

it("fences a revision change during asynchronous provider validation", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  const get = f.providers.get.bind(f.providers)
  const lookup = jest.spyOn(f.providers, "get").mockImplementationOnce((id) => {
    f.rows.set(ref, { ...f.rows.get(ref)!, revision: 2 })
    return get(id)
  })
  try {
    await expect(f.manager.getConnection(ref, 1)).rejects.toBeInstanceOf(ConnectionRevisionChanged)
  } finally {
    lookup.mockRestore()
  }
})

it("fault injection: a stalled lineage owner is replaced only beyond the stale bound and its late CAS loses", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-refresh-takeover-"))
  const realNow = Date.now()
  let now = realNow
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now)
  const f = fixture()
  const fileLock = createCliFileLock(home, { staleMs: 1000, retryMs: 2, waitMs: 2000 })
  const lock: typeof import("./connection-credentials").withAuthLock = (name, task, category) =>
    category === "lineage"
      ? fileLock(name, task, category)
      : withNamedLock(name, task, { mode: "in-process" })
  const a = f.makeManager(false, lock)
  const b = f.makeManager(false, lock)
  const started = deferred<void>()
  const late = deferred<AuthCredentialSet>()
  try {
    const ref = await a.createConnectionFromCredentials(f.provider, old)
    const initial = await f.credentials.read(ref)
    f.provider.refresh = jest
      .fn()
      .mockImplementationOnce(async () => {
        started.resolve()
        return late.promise
      })
      .mockResolvedValue(fresh)
    const pendingA = a.getCredentials(ref)
    const rejectedA = expect(pendingA).rejects.toBeInstanceOf(FileLockLostError)
    await started.promise
    const pendingB = b.getCredentials(ref)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(f.provider.refresh).toHaveBeenCalledTimes(1)
    now += 1000
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(f.provider.refresh).toHaveBeenCalledTimes(1)
    now += 1
    await expect(pendingB).resolves.toEqual(fresh)
    late.resolve({ ...fresh, accessToken: "late-A" })
    await rejectedA
    const final = await f.credentials.read(ref)
    expect(final.revision).toBe(initial.revision + 1)
    expect(final.credentials).toEqual(fresh)
    expect(f.rows.get(ref)?.credentialRevision).toBe(final.revision)
  } finally {
    late.resolve(fresh)
    clock.mockRestore()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it("two tab managers sharing storage make exactly one lineage refresh", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  const second = f.makeManager()
  expect(await Promise.all([f.manager.getCredentials(ref), second.getCredentials(ref)])).toEqual([
    fresh,
    fresh,
  ])
  expect(f.provider.refresh).toHaveBeenCalledTimes(1)
  expect(await f.credentials.read(ref)).toMatchObject({ revision: 2, credentials: fresh })
})

it("returns a CAS winner without retrying the stale refresh token", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.refresh = jest.fn(async () => {
    await f.credentials.commit(ref, await f.credentials.read(ref), fresh)
    return { ...fresh, accessToken: "loser" }
  })
  expect(await f.manager.getCredentials(ref)).toEqual(fresh)
  expect(f.provider.refresh).toHaveBeenCalledTimes(1)
})

it("a refresh completing after disconnect cannot resurrect credentials", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  const started = deferred<void>()
  const release = deferred<AuthCredentialSet>()
  f.provider.refresh = jest.fn(async () => {
    started.resolve()
    return release.promise
  })
  const refreshing = f.manager.getCredentials(ref)
  const rejected = expect(refreshing).rejects.toThrow("revoked")
  await started.promise
  f.provider.revoke = jest.fn(async () => {
    if ((await f.credentials.read(ref)).raw !== null)
      expect(await f.credentials.read(ref)).toMatchObject({ tombstoned: true })
  })
  await f.makeManager().disconnect(ref, { revoke: true })
  release.resolve(fresh)
  await rejected
  expect(f.tokens.size).toBe(0)
  expect(f.rows.get(ref)).toMatchObject({ status: "revoked", identityKey: `tombstoned:${ref}` })
})

it("enforces identity uniqueness, reuses same-provider refs, and bumps scope revision", async () => {
  const f = fixture()
  const listener = jest.fn()
  f.manager.onDidChange(listener)
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  expect(
    await f.manager.createConnectionFromCredentials(f.provider, {
      ...fresh,
      scopes: ["read", "write"],
    })
  ).toBe(ref)
  expect(f.rows.get(ref)).toMatchObject({ revision: 2, credentialRevision: 2 })
  expect(listener.mock.calls.map(([, kind]) => kind)).toEqual(["added", "changed"])
  expect(JSON.stringify(listener.mock.calls)).not.toMatch(
    /accessToken|refreshToken|clientId|lineageId/
  )
  const other = { ...f.provider, id: "other" }
  f.providers.set(other.id, other)
  await expect(f.manager.createConnectionFromCredentials(other, fresh)).rejects.toBeInstanceOf(
    ConnectionIdentityConflict
  )
  await f.manager.disconnect(ref)
  const reconnected = await f.manager.createConnectionFromCredentials(other, fresh)
  expect(reconnected).not.toBe(ref)
})

it("reconnects only the original identity and revokes mismatched fresh credentials", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  expect(
    await f.manager.createConnectionFromCredentials(f.provider, fresh, { reconnect: ref })
  ).toBe(ref)
  expect(f.rows.get(ref)).toMatchObject({ revision: 1, credentialRevision: 2 })
  await f.manager.createConnectionFromCredentials(
    f.provider,
    { ...fresh, scopes: ["read", "write"] },
    { reconnect: ref }
  )
  expect(f.rows.get(ref)).toMatchObject({ revision: 2, credentialRevision: 3 })
  const before = structuredClone([...f.rows.values()])
  const secrets = [...f.tokens.entries()]
  const describe = f.provider.describe!
  f.provider.describe = async (credentials) => ({
    ...(await describe(credentials)),
    tenantId: "another-tenant",
  })
  f.provider.revoke = jest.fn(async () => {})
  await expect(
    f.manager.createConnectionFromCredentials(
      f.provider,
      { ...fresh, accessToken: "mismatch" },
      { reconnect: ref }
    )
  ).rejects.toMatchObject({ name: "ReconnectIdentityMismatch" })
  expect(f.provider.revoke).toHaveBeenCalledWith(
    expect.objectContaining({ credentials: expect.objectContaining({ accessToken: "mismatch" }) })
  )
  expect([...f.rows.values()]).toEqual(before)
  expect([...f.tokens.entries()]).toEqual(secrets)
})

it("reopens a terminal identity with a new ref and lineage and preserves tombstone cleanup", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  const oldRow = f.rows.get(ref)!
  await f.manager.disconnect(ref)
  // Recover a pre-release terminal row which still occupies the unique slot.
  f.rows.set(ref, { ...f.rows.get(ref)!, identityKey: oldRow.identityKey })
  const next = await f.manager.createConnectionFromCredentials(f.provider, fresh, {
    reconnect: ref,
  })
  expect(next).not.toBe(ref)
  expect(f.rows.get(next)).toMatchObject({
    revision: 1,
    credentialRevision: 1,
    identityKey: oldRow.identityKey,
  })
  expect(f.rows.get(next)?.lineageId).not.toBe(oldRow.lineageId)
  expect(f.rows.get(ref)?.identityKey).toBe(`tombstoned:${ref}`)
  await f.manager.sweepTombstoned()
  expect(await f.manager.getCredentials(next)).toEqual(fresh)
})

it("restores old credentials if reconnect metadata cannot be persisted", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  const before = structuredClone(f.rows.get(ref))
  const snapshot = await f.credentials.read(ref)
  f.provider.revoke = jest.fn(async () => {})
  jest.spyOn(f.store, "put").mockRejectedValueOnce(new Error("metadata unavailable"))
  await expect(
    f.manager.createConnectionFromCredentials(
      f.provider,
      { ...fresh, accessToken: "unpublished" },
      { reconnect: ref }
    )
  ).rejects.toThrow("metadata unavailable")
  expect(f.rows.get(ref)).toEqual(before)
  expect(await f.credentials.read(ref)).toEqual(snapshot)
  expect(f.provider.revoke).toHaveBeenCalledWith(
    expect.objectContaining({
      credentials: expect.objectContaining({ accessToken: "unpublished" }),
    })
  )
})

it("rolls back a credential write if cancellation wins before publication", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  const before = await f.credentials.read(ref)
  const started = deferred<void>()
  const resume = deferred<void>()
  const commit = f.credentials.commit.bind(f.credentials)
  jest.spyOn(f.credentials, "commit").mockImplementationOnce(async (...args) => {
    const next = await commit(...args)
    started.resolve()
    await resume.promise
    return next
  })
  f.provider.revoke = jest.fn(async () => {})
  const controller = new AbortController()
  const pending = f.manager.createConnectionFromCredentials(
    f.provider,
    { ...fresh, accessToken: "cancelled" },
    { reconnect: ref, signal: controller.signal }
  )
  const rejected = expect(pending).rejects.toMatchObject({ reason: "cancelled" })
  await started.promise
  controller.abort()
  resume.resolve()
  await rejected
  expect(await f.credentials.read(ref)).toEqual(before)
  expect(f.rows.get(ref)).toMatchObject({ revision: 1, credentialRevision: 1 })
  expect(f.provider.revoke).toHaveBeenCalled()
})

it("does not reconnect over a disconnect which wins during describe", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  const started = deferred<void>()
  const resume = deferred<void>()
  const describe = f.provider.describe!
  f.provider.describe = async (credentials) => {
    started.resolve()
    await resume.promise
    return describe(credentials)
  }
  f.provider.revoke = jest.fn(async () => {})
  const pending = f.manager.createConnectionFromCredentials(f.provider, fresh, { reconnect: ref })
  const rejected = expect(pending).rejects.toBeInstanceOf(ConnectionRevisionChanged)
  await started.promise
  await f.manager.disconnect(ref)
  resume.resolve()
  await rejected
  expect(f.rows.size).toBe(1)
  expect(f.tokens.size).toBe(0)
})

it.each(["invalid_grant", "offline"])("classifies refresh failure %s", async (message) => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.refresh = jest.fn(async () => {
    throw message === "invalid_grant" ? new AuthRefreshRejected() : new Error(message)
  })
  await expect(f.manager.getCredentials(ref)).rejects.toThrow(
    message === "invalid_grant" ? "refresh grant" : message
  )
  expect(f.rows.get(ref)?.status).toBe(message === "invalid_grant" ? "needs-reauth" : "connected")
})

it("restores only the same provider owner and keeps credentials while unavailable", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  await f.manager.markProviderUnavailable(f.provider.id)
  expect(f.tokens.size).toBe(1)
  f.providers.set(f.provider.id, { ...f.provider, pluginId: "other" })
  await f.manager.restoreProvider(f.provider.id)
  expect(f.rows.get(ref)?.status).toBe("provider-unavailable")
  f.providers.set(f.provider.id, f.provider)
  await f.manager.restoreProvider(f.provider.id)
  expect(f.rows.get(ref)?.status).toBe("connected")
  f.providers.delete(f.provider.id)
  await f.manager.disconnect(ref)
  expect(f.rows.get(ref)?.status).toBe("tombstoned")
  expect(f.tokens.size).toBe(0)
})

it("legacy adapters delegate credentials to the existing provider", async () => {
  const f = fixture()
  f.provider.describe = undefined
  const session = {
    id: "session",
    account: { id: "u", label: "U" },
    scopes: ["repo"],
    accessToken: "legacy",
  }
  f.provider.getSessions = async () => [session]
  const ref = await f.manager.ensureLegacyConnection(f.provider.id, session)
  expect(f.tokens.size).toBe(0)
  expect(await f.manager.getCredentials(ref)).toMatchObject({ accessToken: "legacy" })
  f.provider.resolveRequestCredential = jest.fn(async () => ({ accessToken: "resolved" }))
  expect(await f.manager.getCredentials(ref)).toMatchObject({ accessToken: "resolved" })
  expect(f.rows.get(ref)?.identityKey).toBe(
    authConnectionIdentityKey({
      issuer: "provider:acme",
      clientId: "legacy",
      principal: { kind: "user", id: JSON.stringify(["u", "session"]) },
    })
  )
})

it("does not create credentials when a provider unregisters during describe", async () => {
  const f = fixture()
  const started = deferred<void>()
  const release = deferred<void>()
  const original = f.provider.describe!
  f.provider.describe = async (credentials) => {
    started.resolve()
    await release.promise
    return original(credentials)
  }
  const creating = f.manager.createConnectionFromCredentials(f.provider, fresh)
  const failed = expect(creating).rejects.toThrow("provider-unavailable")
  await started.promise
  f.providers.delete(f.provider.id)
  await f.manager.markProviderUnavailable(f.provider.id)
  release.resolve()
  await failed
  expect(f.tokens.size).toBe(0)
  expect(f.rows.size).toBe(0)
})

it("keeps needs-reauth across temporary provider loss and disconnect is idempotent", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.refresh = async () => {
    throw new AuthRefreshRejected("invalid_grant")
  }
  await expect(f.manager.getCredentials(ref)).rejects.toThrow("invalid_grant")
  await f.manager.markProviderUnavailable(f.provider.id)
  await f.manager.restoreProvider(f.provider.id)
  expect(f.rows.get(ref)?.status).toBe("needs-reauth")
  await f.manager.disconnect(ref)
  const row = f.rows.get(ref)
  await f.manager.disconnect(ref)
  expect(f.rows.get(ref)).toEqual(row)
})

it("keeps a repeated local disconnect's timestamp stable across different clock ticks", async () => {
  const f = fixture()
  let time = 1
  const manager = f.makeManager(false, undefined, () => time)
  const ref = await manager.createConnectionFromCredentials(f.provider, fresh)
  time = 2
  await manager.disconnect(ref)
  const row = structuredClone(f.rows.get(ref))
  time = 3
  await manager.disconnect(ref)
  expect(f.rows.get(ref)).toEqual(row)
})

it("retains an existing refresh token when the vendor does not rotate it", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.refresh = async () => ({
    accessToken: "new",
    scopes: ["read"],
    expiresAt: fresh.expiresAt,
  })
  expect(await f.manager.getCredentials(ref)).toMatchObject({
    accessToken: "new",
    refreshToken: "old-refresh",
  })
  expect((await f.credentials.read(ref)).credentials?.refreshToken).toBe("old-refresh")
})

it("records the installed manifest publisher/service major, and null ownership for Host providers", async () => {
  jest.mocked(getPlugin).mockResolvedValue({
    id: "owner",
    name: "Owner",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: ["auth-provider"],
    path: "builtin:owner",
    createdAt: 1,
    updatedAt: 1,
    manifest: {
      author: { name: "Publisher", publicKey: "publisher-key" },
      providesServices: { "auth.acme": "2.3.0" },
    },
  })
  const f = fixture()
  const manager = f.makeManager(true)
  const ref = await manager.createConnectionFromCredentials(f.provider, fresh)
  expect(getPlugin).toHaveBeenCalledWith("owner")
  expect(f.rows.get(ref)).toMatchObject({
    providerId: "acme",
    ownerPluginId: "owner",
    publisher: "publisher-key",
    contractMajor: 2,
  })
  const host = fixture()
  host.provider.pluginId = null
  const hostRef = await host.makeManager(true).createConnectionFromCredentials(host.provider, fresh)
  expect(host.rows.get(hostRef)).toMatchObject({
    ownerPluginId: null,
    publisher: null,
    contractMajor: 1,
  })
})

it.each([
  new Error("Failed to refresh token: invalid JSON response"),
  new Error("invalid_grant"),
  { code: "invalid_token" },
  { message: "refresh token revoked" },
])(
  "does not classify transient free text or invalid_token as rejected grants: %p",
  async (failure) => {
    const f = fixture()
    const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
    f.provider.refresh = jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(fresh)
    await expect(f.manager.getCredentials(ref)).rejects.toEqual(failure)
    expect(f.rows.get(ref)?.status).toBe("connected")
    await expect(f.manager.getCredentials(ref)).resolves.toEqual(fresh)
  }
)

it.each([{ code: "invalid_grant" }, { error: "invalid_grant" }])(
  "classifies structured grant rejection: %p",
  async (failure) => {
    const f = fixture()
    const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
    f.provider.refresh = jest.fn().mockRejectedValue(failure)
    await expect(f.manager.getCredentials(ref)).rejects.toEqual(failure)
    expect(f.rows.get(ref)?.status).toBe("needs-reauth")
  }
)

it("retains failed revocation credentials and retries a tombstoned connection", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  f.provider.revoke = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(undefined)
  await expect(f.manager.disconnect(ref, { revoke: true })).rejects.toThrow("offline")
  expect(f.rows.get(ref)?.status).toBe("tombstoned")
  expect(await f.credentials.read(ref)).toMatchObject({ tombstoned: true, credentials: fresh })
  await expect(f.manager.getCredentials(ref)).rejects.toThrow("tombstoned")
  await f.manager.disconnect(ref, { revoke: true })
  expect(f.provider.revoke).toHaveBeenCalledTimes(2)
  expect(f.rows.get(ref)?.status).toBe("revoked")
  expect(f.tokens.size).toBe(0)
})

it("retains a missing provider's tombstone secret until revocation can be retried", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  f.providers.clear()
  await f.manager.disconnect(ref, { revoke: true })
  expect(f.rows.get(ref)?.status).toBe("tombstoned")
  expect((await f.credentials.read(ref)).credentials).toEqual(fresh)
  f.provider.revoke = jest.fn(async () => {})
  f.providers.set(f.provider.id, f.provider)
  await f.manager.disconnect(ref, { revoke: true })
  expect(f.provider.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentials: fresh }))
  expect(f.rows.get(ref)?.status).toBe("revoked")
})

it("a local-only disconnect deletes credentials without claiming vendor revocation", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
  f.provider.revoke = jest.fn()
  await f.manager.disconnect(ref, { revoke: false })
  expect(f.rows.get(ref)?.status).toBe("tombstoned")
  expect(f.provider.revoke).not.toHaveBeenCalled()
  expect(f.tokens.size).toBe(0)
})

it.each(["success", "failure", "missing"])(
  "sweeps tombstoned secrets after %s revocation",
  async (result) => {
    const f = fixture()
    const ref = await f.manager.createConnectionFromCredentials(f.provider, fresh)
    f.provider.revoke = jest.fn().mockRejectedValue(new Error("offline"))
    await expect(f.manager.disconnect(ref, { revoke: true })).rejects.toThrow("offline")
    if (result === "success") f.provider.revoke = jest.fn().mockResolvedValue(undefined)
    if (result === "missing") f.providers.clear()
    await f.makeManager().sweepTombstoned()
    expect(f.tokens.size).toBe(0)
    expect(f.rows.get(ref)?.status).toBe(result === "success" ? "revoked" : "tombstoned")
  }
)

it("persists rotated credentials when the provider disappears during refresh", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.refresh = async () => {
    f.providers.clear()
    return fresh
  }
  await expect(f.manager.getCredentials(ref)).rejects.toThrow("provider-unavailable")
  expect((await f.credentials.read(ref)).credentials).toEqual(fresh)
  expect(f.rows.get(ref)?.status).toBe("provider-unavailable")
  f.providers.set(f.provider.id, f.provider)
  await f.manager.restoreProvider(f.provider.id)
  await expect(f.manager.getCredentials(ref)).resolves.toEqual(fresh)
})

it("revokes the newly issued lineage when a local-only disconnect wins refresh", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.revoke = jest.fn().mockRejectedValue(new Error("offline"))
  f.provider.refresh = async () => {
    await f.makeManager().disconnect(ref, { revoke: false })
    return fresh
  }
  await expect(f.manager.getCredentials(ref)).rejects.toThrow("tombstoned")
  expect(f.provider.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentials: fresh }))
  expect(f.tokens.size).toBe(0)
})

it("keeps legacy sessions for one account in separate rows", async () => {
  const f = fixture()
  f.provider.describe = undefined
  const a = { id: "a", account: { id: "u", label: "U" }, scopes: [], accessToken: "a-token" }
  const b = { ...a, id: "b", accessToken: "b-token" }
  f.provider.getSessions = async () => [a, b]
  const first = await f.manager.ensureLegacyConnection(f.provider.id, a)
  const second = await f.manager.ensureLegacyConnection(f.provider.id, b)
  expect(first).not.toBe(second)
  await f.manager.disconnect(first, { revoke: true })
  expect(f.provider.removeSession).toHaveBeenCalledWith("a")
  await expect(f.manager.getCredentials(second)).resolves.toMatchObject({ accessToken: "b-token" })
})

it("times out and aborts hung refreshes, releases the lineage, and revokes late results", async () => {
  jest.useFakeTimers()
  try {
    const f = fixture()
    const manager = f.makeManager(false, (name, task) =>
      withNamedLock(name, task, { mode: "in-process" })
    )
    const ref = await manager.createConnectionFromCredentials(f.provider, old)
    const started = deferred<void>()
    const late = deferred<AuthCredentialSet>()
    let signal: AbortSignal | undefined
    f.provider.refresh = jest.fn(async (context) => {
      signal = context.signal
      started.resolve()
      return late.promise
    })
    f.provider.revoke = jest.fn(async () => {})
    const pending = manager.getCredentials(ref)
    const rejected = expect(pending).rejects.toMatchObject({ name: "AuthRefreshTimeout" })
    await started.promise
    expect(signal?.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(AUTH_REFRESH_TIMEOUT_MS)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect((await f.credentials.read(ref)).credentials).toEqual(old)
    expect(f.rows.get(ref)?.status).toBe("connected")
    f.provider.refresh = jest.fn(async () => fresh)
    await expect(manager.getCredentials(ref)).resolves.toEqual(fresh)
    late.resolve({ ...fresh, accessToken: "late" })
    await jest.advanceTimersByTimeAsync(0)
    expect(f.provider.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: expect.objectContaining({ accessToken: "late" }) })
    )
    expect((await f.credentials.read(ref)).credentials).toEqual(fresh)
  } finally {
    jest.useRealTimers()
  }
})

it.each([false, true])(
  "profile cleanup revokes and clears only the deleted account, revoke failure=%s",
  async (failRevoke) => {
    const f = fixture()
    const namespaces = new Map<string, Map<string, string>>()
    const secrets = (kind: "auth-connections" | "auth-attempts", accountId = "active") => {
      const namespace = `${kind}:${accountId}`
      let values = namespaces.get(namespace)
      if (!values) {
        values = new Map()
        namespaces.set(namespace, values)
      }
      const backing = values
      return new HostAuthSecrets(namespace, {
        accountId,
        native: false,
        lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
        store: {
          load: async (key) => backing.get(key) ?? null,
          save: async (key, value) => {
            backing.set(key, value)
          },
          delete: async (key) => {
            backing.delete(key)
          },
          isPersistent: () => true,
        },
      })
    }
    const credentials = new ConnectionCredentialStore(secrets("auth-connections", "deleted"))
    const manager = new AuthConnectionManager({
      store: {
        get: async (id) => f.rows.get(id),
        find: async () => undefined,
        list: async () => [...f.rows.values()],
        put: async (row) => {
          f.rows.set(row.id, row)
        },
      },
      credentials,
      provider: () => f.provider,
      providerIdentity: async () => ({
        providerId: "acme",
        ownerPluginId: "owner",
        publisher: "pub",
        contractMajor: 1,
      }),
    })
    await manager.createConnectionFromCredentials(f.provider, fresh)
    await secrets("auth-attempts", "deleted").compareAndSet("attempt", null, "verifier")
    await secrets("auth-connections", "other").compareAndSet("other-ref", null, "other-token")
    await secrets("auth-attempts", "other").compareAndSet("other-attempt", null, "other-verifier")
    f.provider.revoke = failRevoke
      ? jest.fn().mockRejectedValue(new Error("offline"))
      : jest.fn().mockResolvedValue(undefined)
    const report = await forgetProfileAuthSecrets("deleted", {
      secrets,
      provider: () => f.provider,
      providerIdentity: async () => ({
        providerId: "acme",
        ownerPluginId: "owner",
        publisher: "pub",
        contractMajor: 1,
      }),
    })
    expect(f.provider.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentials: fresh }))
    expect(report.tokensMayRemainLive).toBe(failRevoke)
    expect(report.failures.length > 0).toBe(failRevoke)
    for (const kind of ["auth-connections", "auth-attempts"] as const) {
      expect([...namespaces.get(`${kind}:deleted`)!.keys()]).toEqual(["__host_auth_keys__"])
      await expect(
        secrets(kind, "deleted").compareAndSet("late", null, "late-token")
      ).rejects.toThrow("deleted")
    }
    expect(await secrets("auth-connections", "other").read("other-ref")).toBe("other-token")
    expect(await secrets("auth-attempts", "other").read("other-attempt")).toBe("other-verifier")
  }
)

it("revokes refreshed credentials if profile deletion fences the commit", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  const { AuthProfileDeleted } = await import("./connection-credentials")
  f.provider.revoke = jest.fn(async () => {})
  jest.spyOn(f.credentials, "commit").mockRejectedValueOnce(new AuthProfileDeleted())
  await expect(f.manager.getCredentials(ref)).rejects.toThrow("profile-deleted")
  expect(f.provider.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentials: fresh }))
})

it("startup sweep discards tombstone secrets even when vendor revoke hangs", async () => {
  jest.useFakeTimers()
  try {
    const f = fixture()
    const manager = f.makeManager(false, (name, task) =>
      withNamedLock(name, task, { mode: "in-process" })
    )
    const ref = await manager.createConnectionFromCredentials(f.provider, fresh)
    f.provider.revoke = jest.fn().mockRejectedValueOnce(new Error("offline"))
    await expect(manager.disconnect(ref, { revoke: true })).rejects.toThrow("offline")
    const started = deferred<void>()
    f.provider.revoke = jest.fn(async () => {
      started.resolve()
      await new Promise(() => {})
    })
    const sweep = manager.sweepTombstoned()
    await started.promise
    await jest.advanceTimersByTimeAsync(AUTH_REVOKE_TIMEOUT_MS)
    await sweep
    expect(f.tokens.size).toBe(0)
    expect(f.rows.get(ref)?.status).toBe("tombstoned")
  } finally {
    jest.useRealTimers()
  }
})

it("revokes a refresh lost to disconnect even when logout locks the secret store", async () => {
  const f = fixture()
  const ref = await f.manager.createConnectionFromCredentials(f.provider, old)
  f.provider.revoke = jest.fn(async () => {})
  f.provider.refresh = async () => {
    await f.makeManager().disconnect(ref, { revoke: false })
    jest.spyOn(f.credentials, "read").mockRejectedValue(new Error("vault locked"))
    return fresh
  }
  await expect(f.manager.getCredentials(ref)).rejects.toThrow("tombstoned")
  expect(f.provider.revoke).toHaveBeenCalledWith(expect.objectContaining({ credentials: fresh }))
})
