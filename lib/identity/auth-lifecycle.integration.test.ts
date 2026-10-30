/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"

jest.mock("@/lib/tauri", () => ({ isTauri: () => true, isCapacitor: () => false }))
jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => mockProfileId }))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: async (
    command: string,
    args: {
      input?: { namespace: string; key: string; value?: string }
      condition?: { expected: string | null; changes: { key: string; value: string | null }[] }
      localAccountId?: string
      userId?: string
      authRevision?: string
    }
  ) => {
    const { input, condition } = args
    if (command === "account_bind_person" || command === "account_unbind_person") {
      const gate = command === "account_bind_person" ? mockHostBindGate : mockHostUnbindGate
      if (gate) {
        if (command === "account_bind_person") mockHostBindGate = undefined
        else mockHostUnbindGate = undefined
        gate.issued.resolve()
        await gate.release.promise
      }
      try {
        // Native verification can finish after logout. The final storage guard
        // compares and publishes the host identity synchronously under its lock.
        if (
          args.authRevision !== undefined &&
          mockNativeSecrets.get(`logto:auth-revision:${args.localAccountId}`) !== args.authRevision
        )
          throw new Error("secret-store condition mismatch")
        if (command === "account_bind_person")
          mockHostPersons.set(args.localAccountId!, args.userId!)
        else mockHostPersons.delete(args.localAccountId!)
        return null
      } finally {
        gate?.finished.resolve()
      }
    }
    if (!input) throw new Error(`Missing fixture input for ${command}`)
    const key = `${input.namespace}:${input.key}`
    if (command === "secret_store_get") return mockNativeSecrets.get(key) ?? null
    if (command === "secret_store_set") {
      const changes = condition?.changes ?? []
      const writesSession =
        input.key.startsWith("session:") ||
        changes.some((change) => change.key.startsWith("session:") && change.value !== null)
      if (mockSessionWriteFails && writesSession)
        throw new Error("Fixture session persistence failed")
      if (mockDeleteFails && changes.some((change) => change.value === null))
        throw new Error("Fixture native deletion denied")
      if (condition && (mockNativeSecrets.get(key) ?? null) !== condition.expected)
        throw new Error("secret-store condition mismatch")
      mockNativeSecrets.set(key, input.value!)
      for (const change of changes) {
        const target = `${input.namespace}:${change.key}`
        if (change.value === null) mockNativeSecrets.delete(target)
        else mockNativeSecrets.set(target, change.value)
      }
      return null
    }
    if (command === "secret_store_delete") {
      if (mockDeleteFails) throw new Error("Fixture native deletion denied")
      mockNativeSecrets.delete(key)
      return null
    }
    throw new Error(`Unexpected fixture command: ${command}`)
  },
}))

import { CogniaAccountRegistryDB, LocalAccountRegistry } from "@/lib/accounts/account-db"
import { officialSyncSession } from "@/lib/account-sync/sync-session"
import { signInToLogto, resolveLogtoSession, signOutFromLogto } from "@/lib/logto/app-session"
import { loadLogtoSession, saveLogtoSession } from "@/lib/logto/session-store"
import type { LogtoAppSessionDeps } from "@/lib/logto/app-session"
import type { LogtoSession } from "@/lib/logto/client"
import { UserBindingRegistry } from "./user-binding"
import { completeSignIn, completeSignOut } from "./complete-sign-in"
import { readCloudSessionState } from "./cloud-session"
import { signInToOfficialAccount } from "./personal-sign-in"
import { officialDeployment } from "./official-deployment"
import { IDENTITIES_CLAIM } from "./issuer-identities"
import type { PersonalSignInDeps } from "./personal-sign-in"
import { adoptOrganization } from "./cloud-sign-in-flow"
import type { ReadyDeployment } from "./deployment-discovery"

const mockNativeSecrets = new Map<string, string>()
const mockHostPersons = new Map<string, string>()
let mockHostBindGate:
  | {
      issued: ReturnType<typeof deferred<void>>
      release: ReturnType<typeof deferred<void>>
      finished: ReturnType<typeof deferred<void>>
    }
  | undefined
let mockHostUnbindGate: typeof mockHostBindGate
let mockDeleteFails = false
let mockSessionWriteFails = false
let mockProfileId = "acct_lifecycle_0"
let nextId = 0
let db: CogniaAccountRegistryDB
let content: Dexie
let registry: UserBindingRegistry
const deployment = officialDeployment({})!
const alice = `usr_${"a".repeat(32)}`
const bob = `usr_${"b".repeat(32)}`
const projection = { upsert: jest.fn(async () => {}) }
const host = { isDesktop: () => false }
const localContent = { id: "message_1", text: "Preserve existing conversation", outbox: "pending" }

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`
}
function session(
  person = alice,
  turn = "original",
  expiresAt = Date.now() + 600_000
): LogtoSession {
  return {
    issuer: deployment.issuer,
    clientId: deployment.webClientId,
    resource: deployment.audience,
    issuerKind: "oidc",
    accessToken: jwt({ iss: deployment.issuer, sub: person, turn }),
    refreshToken: `fixture-refresh-${person}-${turn}`,
    scopes: [],
    expiresAt,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const noNetwork = async () => {
  throw new Error("Network is forbidden in this regression")
}
function complete(candidate: LogtoSession) {
  return completeSignIn(candidate, { localAccountId: mockProfileId, registry, projection, host })
}
function deactivate() {
  return completeSignOut({
    localAccountId: mockProfileId,
    registry,
    host,
    unlinkSelfBound: async () => [],
  })
}
function logout(overrides: LogtoAppSessionDeps = {}) {
  return signOutFromLogto({
    localAccountId: mockProfileId,
    afterClear: deactivate,
    fetchImpl: noNetwork,
    discover: async () => ({
      issuer: deployment.issuer,
      authorizationEndpoint: `${deployment.issuer}/authorize`,
      tokenEndpoint: `${deployment.issuer}/token`,
    }),
    revoke: async () => ({ status: "revoked" }),
    ...overrides,
  })
}
function login(candidate: LogtoSession, overrides: Partial<PersonalSignInDeps> = {}) {
  return signInToOfficialAccount(
    deployment,
    { openUrl: () => {}, waitForCode: noNetwork },
    {
      redirectUri: "https://app.example.test/callback",
      clientKind: "web",
    },
    {
      localAccountId: mockProfileId,
      registry,
      complete,
      signIn: (config, drivers, deps) =>
        signInToLogto(config, drivers, {
          ...deps,
          login: async () => candidate,
        }),
      ...overrides,
    }
  )
}

beforeEach(async () => {
  mockNativeSecrets.clear()
  mockHostPersons.clear()
  mockHostBindGate = undefined
  mockHostUnbindGate = undefined
  mockDeleteFails = false
  mockSessionWriteFails = false
  mockProfileId = `acct_lifecycle_${++nextId}`
  db = new CogniaAccountRegistryDB(`cognia-auth-lifecycle-${nextId}`)
  registry = new UserBindingRegistry(db)
  await new LocalAccountRegistry(db).createAccount({
    id: mockProfileId,
    displayName: "Preserved profile",
    passwordVerifier: { algorithm: "fixture", salt: "fixture", hash: "fixture", params: {} },
  })
  content = new Dexie(`cognia-auth-content-fixture-${nextId}`)
  content.version(1).stores({ messages: "&id" })
  await content.table("messages").put(localContent)
  await complete(session())
  await saveLogtoSession(session(), mockProfileId)
})
afterEach(async () => {
  await db.delete()
  await content.delete()
})

it("rejected official login preserves the existing token, owner and data", async () => {
  const previous = await loadLogtoSession(mockProfileId)
  await expect(login(session(bob))).rejects.toMatchObject({ code: "already-bound-to-another-user" })
  expect(await loadLogtoSession(mockProfileId)).toEqual(previous)
  expect(await registry.get(mockProfileId)).toMatchObject({ userId: alice })
  const sync = await officialSyncSession({ localAccountId: mockProfileId, registry, deployment })
  expect(sync?.userId).toBe(alice)
  expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
})

it("logout retains ownership and data; only the original Person can resume", async () => {
  const profile = await db.accounts.get(mockProfileId)
  await logout()
  expect(await loadLogtoSession(mockProfileId)).toBeNull()
  expect(await registry.get(mockProfileId)).toBeNull()
  expect(await registry.getOwner(mockProfileId)).toMatchObject({ userId: alice })
  await expect(login(session(bob))).rejects.toMatchObject({ code: "already-bound-to-another-user" })
  expect(await loadLogtoSession(mockProfileId)).toBeNull()
  await login(session(alice, "resumed"))
  expect(await registry.get(mockProfileId)).toMatchObject({ userId: alice })
  expect(await db.accounts.get(mockProfileId)).toEqual(profile)
  expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
})

it("legacy mismatched credentials cannot become cloud-active or select a sync space", async () => {
  await saveLogtoSession(session(bob), mockProfileId)
  expect(await readCloudSessionState({ localAccountId: mockProfileId, registry })).toMatchObject({
    status: "reauth-required",
    reason: "binding-mismatch",
  })
  expect(
    await officialSyncSession({ localAccountId: mockProfileId, registry, deployment })
  ).toBeNull()
  expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
})

it("late refresh after logout cannot restore credentials or reactivate the owner", async () => {
  await saveLogtoSession(session(alice, "expired", 0), mockProfileId)
  const response = deferred<LogtoSession>()
  const started = deferred<void>()
  const refreshing = resolveLogtoSession({
    localAccountId: mockProfileId,
    fetchImpl: noNetwork,
    refresh: async () => {
      started.resolve()
      return response.promise
    },
  })
  await started.promise
  await logout()
  response.resolve(session(alice, "late"))
  expect(await refreshing).toMatchObject({ status: "none" })
  expect(await loadLogtoSession(mockProfileId)).toBeNull()
  expect(await registry.get(mockProfileId)).toBeNull()
  expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
})

it("a slow issuer logout cannot deactivate or clear a newer successful login", async () => {
  const started = deferred<void>()
  const response = deferred<{ status: "revoked" }>()
  const signingOut = logout({
    revoke: async () => {
      started.resolve()
      return response.promise
    },
  })
  await started.promise
  expect(await registry.get(mockProfileId)).toBeNull()
  const newer = session(alice, "newer")
  await login(newer)
  response.resolve({ status: "revoked" })
  await signingOut
  expect(await loadLogtoSession(mockProfileId)).toEqual(newer)
  expect(await registry.get(mockProfileId)).toMatchObject({ userId: alice })
})

it("native deletion failure rejects logout and keeps the owner active", async () => {
  mockDeleteFails = true
  await expect(logout()).rejects.toThrow("native deletion denied")
  expect(await loadLogtoSession(mockProfileId)).not.toBeNull()
  expect(await registry.get(mockProfileId)).toMatchObject({ userId: alice })
  expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
})

it("failed credential persistence cannot mutate the existing owner or projection", async () => {
  const owner = await registry.getOwner(mockProfileId)
  const stored = await loadLogtoSession(mockProfileId)
  const projectionCalls = projection.upsert.mock.calls.length
  mockSessionWriteFails = true
  await expect(login(session(alice, "cannot-save"))).rejects.toThrow("persistence failed")
  expect(await registry.getOwner(mockProfileId)).toEqual(owner)
  expect(await loadLogtoSession(mockProfileId)).toEqual(stored)
  expect(projection.upsert).toHaveBeenCalledTimes(projectionCalls)
  expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
})

it("organization token persistence failure leaves owner, org, projection and connection unchanged", async () => {
  const previous = (await loadLogtoSession(mockProfileId))!
  const owner = await registry.getOwner(mockProfileId)
  const projectionCalls = projection.upsert.mock.calls.length
  const saveConnection = jest.fn((_account, connection) => connection)
  const server: ReadyDeployment = {
    status: "ready",
    baseUrl: "https://host.example.test",
    config: {
      deploymentMode: "multi-tenant",
      hostId: "fixture",
      signaling: { url: "wss://signal.example.test", iceServers: [] },
    },
    social: [],
    collaborationServiceUrl: "https://collab.example.test",
    registrationPolicy: null,
    webOrigin: null,
  }
  mockSessionWriteFails = true
  await expect(
    adoptOrganization(
      server,
      previous,
      {
        orgId: "org_new",
        userId: alice,
        logtoOrganizationId: "new_org",
      },
      {
        localAccountId: mockProfileId,
        registry,
        complete,
        fetchImpl: noNetwork,
        refresh: async () => session(alice, "new-org"),
        saveConnection,
        refreshPlane: noNetwork,
      }
    )
  ).rejects.toThrow("persistence failed")
  expect(await loadLogtoSession(mockProfileId)).toEqual(previous)
  expect(await registry.getOwner(mockProfileId)).toEqual(owner)
  expect(projection.upsert).toHaveBeenCalledTimes(projectionCalls)
  expect(saveConnection).not.toHaveBeenCalled()
})

it("an expired profile scope refuses a late candidate before saving or publishing", async () => {
  const previous = await loadLogtoSession(mockProfileId)
  const started = deferred<void>()
  const candidate = deferred<LogtoSession>()
  let current = true
  const signingIn = login(session(), {
    assertCurrent: () => {
      if (!current) throw new Error("profile changed")
    },
    signIn: (config, drivers, deps) =>
      signInToLogto(config, drivers, {
        ...deps,
        login: async () => {
          started.resolve()
          return candidate.promise
        },
      }),
  })
  const rejected = expect(signingIn).rejects.toThrow("profile changed")
  await started.promise
  current = false
  candidate.resolve(session(alice, "late-profile"))
  await rejected
  expect(await loadLogtoSession(mockProfileId)).toEqual(previous)
})

it("finishes local sign-in linking before logout can revoke its self-bound access", async () => {
  const linked = deferred<{ linked: []; conflicts: []; skipped: [] }>()
  const started = deferred<void>()
  const candidate = {
    ...session(alice, "social"),
    idToken: jwt({
      sub: alice,
      [IDENTITIES_CLAIM]: [{ provider: "lark", tenant: "tenant", subject: "union" }],
    }),
  }
  const signingIn = login(candidate, {
    linkIdentities: async () => {
      started.resolve()
      return linked.promise
    },
  })
  await started.promise
  const signingOut = logout()
  linked.resolve({ linked: [], conflicts: [], skipped: [] })
  await signingIn
  await signingOut
  expect(await loadLogtoSession(mockProfileId)).toBeNull()
  expect(await registry.get(mockProfileId)).toBeNull()
})

it("organization-token refresh cannot revive an identity after sign-out", async () => {
  const response = deferred<LogtoSession>()
  const started = deferred<void>()
  const server = {
    status: "ready",
    baseUrl: "https://host.example.test",
    config: {
      deploymentMode: "multi-tenant",
      hostId: "fixture",
      signaling: { url: "wss://signal.example.test", iceServers: [] },
    },
    social: [],
    collaborationServiceUrl: "https://collab.example.test",
    registrationPolicy: null,
    webOrigin: null,
  } as ReadyDeployment
  const adopting = adoptOrganization(
    server,
    (await loadLogtoSession(mockProfileId))!,
    {
      orgId: "org_test",
      userId: alice,
      logtoOrganizationId: "organization_test",
    },
    {
      localAccountId: mockProfileId,
      registry,
      complete,
      fetchImpl: noNetwork,
      refresh: async () => {
        started.resolve()
        return response.promise
      },
      saveConnection: (_account, connection) => connection,
      refreshPlane: noNetwork,
    }
  )
  const rejected = expect(adopting).rejects.toMatchObject({
    name: "LogtoAuthOperationSupersededError",
  })
  await started.promise
  await logout()
  response.resolve(session(alice, "late-org"))
  await rejected
  expect(await loadLogtoSession(mockProfileId)).toBeNull()
  expect(await registry.get(mockProfileId)).toBeNull()
})

it("an interrupted composed personal sign-in cannot restore the host Person after a newer logout", async () => {
  let second!: typeof import("@/lib/logto/app-session")
  await jest.isolateModulesAsync(async () => {
    second = await import("@/lib/logto/app-session")
  })
  const gate = { issued: deferred<void>(), release: deferred<void>(), finished: deferred<void>() }
  mockHostBindGate = gate
  const originalTransaction = IDBDatabase.prototype.transaction
  let activeAuth!: IDBTransaction
  const spy = jest.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = originalTransaction.apply(this, args)
    if (args[0] === "auth") activeAuth = tx
    return tx
  })
  const mirrorFailureReported = deferred<void>()
  const onHostMirrorFailed = jest.fn(() => mirrorFailureReported.resolve())
  try {
    // This is the production personal -> afterCommit -> completeSignIn ->
    // bindHostPerson composition; seams supply storage and a desktop IPC only.
    const signingIn = login(session(alice, "late-person"), {
      complete: (candidate, scoped) =>
        completeSignIn(candidate, {
          ...scoped,
          registry,
          projection,
          host: { isDesktop: () => true },
          onHostMirrorFailed,
        }),
      signIn: (config, drivers, deps) =>
        signInToLogto(config, drivers, {
          ...deps,
          locks: null,
          login: async () => session(alice, "late-person"),
        }),
    })
    const rejected = expect(signingIn).rejects.toThrow("authentication lock")
    await gate.issued.promise
    activeAuth.abort()
    await rejected
    await second.signOutFromLogto(
      {
        localAccountId: mockProfileId,
        locks: null,
        discover: noNetwork,
        afterClear: (context) =>
          completeSignOut({
            localAccountId: mockProfileId,
            registry,
            host: { isDesktop: () => true },
            unlinkSelfBound: async () => [],
            ...context,
          }),
      },
      { revoke: false }
    )
    gate.release.resolve()
    await gate.finished.promise
    expect(mockHostPersons.has(mockProfileId)).toBe(false)
    await mirrorFailureReported.promise
    expect(await loadLogtoSession(mockProfileId)).toBeNull()
    expect(await registry.get(mockProfileId)).toBeNull()
    expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
    expect(onHostMirrorFailed).toHaveBeenCalledTimes(1)
  } finally {
    gate.release.resolve()
    spy.mockRestore()
  }
})

it("an interrupted composed logout cannot unbind the host Person from a newer successful login", async () => {
  let second!: typeof import("@/lib/logto/app-session")
  await jest.isolateModulesAsync(async () => {
    second = await import("@/lib/logto/app-session")
  })
  const gate = { issued: deferred<void>(), release: deferred<void>(), finished: deferred<void>() }
  mockHostUnbindGate = gate
  mockHostPersons.set(mockProfileId, alice)
  const originalTransaction = IDBDatabase.prototype.transaction
  let activeAuth!: IDBTransaction
  const spy = jest.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = originalTransaction.apply(this, args)
    if (args[0] === "auth") activeAuth = tx
    return tx
  })
  const mirrorFailureReported = deferred<void>()
  const onHostMirrorFailed = jest.fn(() => mirrorFailureReported.resolve())
  try {
    const signingOut = signOutFromLogto(
      {
        localAccountId: mockProfileId,
        locks: null,
        discover: noNetwork,
        afterClear: (context) =>
          completeSignOut({
            localAccountId: mockProfileId,
            registry,
            host: { isDesktop: () => true },
            unlinkSelfBound: async () => [],
            onHostMirrorFailed,
            ...context,
          }),
      },
      { revoke: false }
    )
    const rejected = expect(signingOut).rejects.toThrow("authentication lock")
    await gate.issued.promise
    activeAuth.abort()
    await rejected
    const candidate = session(alice, "new-host-person")
    await login(candidate, {
      complete: (signedIn, scoped) =>
        completeSignIn(signedIn, {
          ...scoped,
          registry,
          projection,
          host: { isDesktop: () => true },
        }),
      signIn: (config, drivers, deps) =>
        second.signInToLogto(config, drivers, {
          ...deps,
          locks: null,
          login: async () => candidate,
        }),
    })
    gate.release.resolve()
    await gate.finished.promise
    expect(mockHostPersons.get(mockProfileId)).toBe(alice)
    await mirrorFailureReported.promise
    expect(await loadLogtoSession(mockProfileId)).toEqual(candidate)
    expect(await registry.get(mockProfileId)).toMatchObject({ userId: alice })
    expect(await content.table("messages").get(localContent.id)).toEqual(localContent)
    expect(onHostMirrorFailed).toHaveBeenCalledTimes(1)
  } finally {
    gate.release.resolve()
    spy.mockRestore()
  }
})
