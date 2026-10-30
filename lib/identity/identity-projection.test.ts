import {
  getOrg,
  getOrgMembership,
  getUser,
  findUserIdByExternalIdentity,
  listExternalIdentities,
} from "@/lib/db/identity"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { identityProjection, writeIdentityProjection } from "./identity-projection"
import type { SignedInIdentity } from "./sign-in"
import { completeSignIn, completeSignOut } from "./complete-sign-in"
import { CogniaAccountRegistryDB } from "@/lib/accounts/account-db"
import { UserBindingRegistry } from "./user-binding"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await Promise.all([
    db.users.clear(),
    db.orgs.clear(),
    db.orgMemberships.clear(),
    db.externalIdentities.clear(),
  ])
})
afterAll(dbFixture.dispose)

const ISSUER = "https://logto.example.com/oidc"

function identity(overrides: Partial<SignedInIdentity> = {}): SignedInIdentity {
  return {
    user: { id: "usr_ada", displayName: "Ada", email: "a@x.dev", createdAt: 5, updatedAt: 5 },
    org: {
      id: "org_acme",
      displayName: "Acme",
      logtoOrganizationId: "org_tenant_1",
      createdAt: 5,
      updatedAt: 5,
    },
    orgRole: "admin",
    binding: {
      localAccountId: getActiveAccountId(),
      userId: "usr_ada",
      orgId: "org_acme",
      logtoSubject: "logto_ada",
      logtoIssuer: ISSUER,
      boundAt: 5,
      updatedAt: 5,
    },
    ...overrides,
  }
}

describe("writeIdentityProjection", () => {
  it("rolls back identity writes when the authentication commit is interrupted", async () => {
    const db = getDb()
    const put = db.users.put.bind(db.users)
    let current = true
    const intercepted = jest.spyOn(db.users, "put").mockImplementationOnce((user, key) =>
      put(user, key).then((result) => {
        current = false
        return result
      })
    )
    try {
      await expect(
        writeIdentityProjection(identity(), () => {
          if (!current) throw new Error("stale auth")
        })
      ).rejects.toThrow("stale auth")
    } finally {
      intercepted.mockRestore()
    }
    expect(await db.users.count()).toBe(0)
    expect(await db.externalIdentities.count()).toBe(0)
  })
  it("retains real content, unsent sync outbox and projected names across logout/resume", async () => {
    const db = getDb()
    await db
      .table("sessions")
      .put({ id: "preserved-session", title: "Keep conversation", createdAt: 1, updatedAt: 1 })
    await db.table("messages").put({
      id: "preserved-message",
      sessionId: "preserved-session",
      role: "user",
      content: "Keep message",
      createdAt: 1,
    })
    await db
      .table("accountSyncOutbox")
      .put({ table: "messages", rowId: "preserved-message", pending: "keep" })
    const original = await Promise.all([
      db.sessions.toArray(),
      db.messages.toArray(),
      db.accountSyncOutbox.toArray(),
    ])
    const registryDb = new CogniaAccountRegistryDB("cognia-projection-owner-preservation")
    const registry = new UserBindingRegistry(registryDb)
    const localAccountId = getActiveAccountId()
    const payload = Buffer.from(JSON.stringify({ sub: "projection_owner" })).toString("base64url")
    const signedIn = {
      issuer: ISSUER,
      clientId: "fixture",
      resource: "fixture",
      accessToken: `header.${payload}.sig`,
      scopes: [],
    }
    try {
      const first = await completeSignIn(signedIn, {
        localAccountId,
        registry,
        host: { isDesktop: () => false },
      })
      const projected = await db.users.get(first.user.id)
      await completeSignOut({
        localAccountId,
        registry,
        host: { isDesktop: () => false },
        unlinkSelfBound: async () => [],
      })
      expect(await registry.get(localAccountId)).toBeNull()
      expect(await db.users.get(first.user.id)).toEqual(projected)
      expect(
        await Promise.all([
          db.sessions.toArray(),
          db.messages.toArray(),
          db.accountSyncOutbox.toArray(),
        ])
      ).toEqual(original)
      await completeSignIn(signedIn, { localAccountId, registry, host: { isDesktop: () => false } })
      expect(
        await Promise.all([
          db.sessions.toArray(),
          db.messages.toArray(),
          db.accountSyncOutbox.toArray(),
        ])
      ).toEqual(original)
    } finally {
      await registryDb.delete()
    }
  })
  it("rejects a late identity for another profile before writing any projection", async () => {
    const incoming = identity()
    await expect(
      writeIdentityProjection({
        ...incoming,
        binding: { ...incoming.binding, localAccountId: "acct_another" },
      })
    ).rejects.toThrow(/profile changed/i)
    expect(await getDb().users.count()).toBe(0)
    expect(await getDb().externalIdentities.count()).toBe(0)
  })

  it("rolls back a projection if the selected database changes between writes", async () => {
    const originalDb = getDb()
    const put = originalDb.users.put.bind(originalDb.users)
    const intercepted = jest.spyOn(originalDb.users, "put").mockImplementationOnce((user, key) =>
      put(user, key).then((result) => {
        activateAccountDatabase("acct_other")
        return result
      })
    )
    try {
      await expect(writeIdentityProjection(identity())).rejects.toThrow()
    } finally {
      intercepted.mockRestore()
      clearAccountDatabaseSelection()
    }
    expect(await getDb().users.count()).toBe(0)
    expect(await getDb().orgs.count()).toBe(0)
    expect(await getDb().externalIdentities.count()).toBe(0)
  })
  it("mirrors the person, the org, the membership and the external identity", async () => {
    await writeIdentityProjection(identity())

    expect(await getUser("usr_ada")).toMatchObject({ displayName: "Ada", email: "a@x.dev" })
    expect(await getOrg("org_acme")).toMatchObject({ logtoOrganizationId: "org_tenant_1" })
    expect(await getOrgMembership("org_acme", "usr_ada")).toMatchObject({
      role: "admin",
      updatedAt: 5,
    })
    expect(await findUserIdByExternalIdentity("logto", "logto_ada", ISSUER)).toBe("usr_ada")
  })

  it("scopes the Logto subject by issuer, so two deployments cannot collide", async () => {
    await writeIdentityProjection(identity())
    // The same `sub` from a different Logto deployment is a different person.
    expect(
      await findUserIdByExternalIdentity("logto", "logto_ada", "https://other.example/oidc")
    ).toBeUndefined()
  })

  it("writes a person with no organization without inventing one", async () => {
    const { org: _org, orgRole: _role, ...rest } = identity()
    await writeIdentityProjection({
      ...rest,
      binding: { ...rest.binding, orgId: undefined },
    } as SignedInIdentity)

    expect(await getUser("usr_ada")).toBeDefined()
    expect(await getDb().orgs.count()).toBe(0)
    expect(await getDb().orgMemberships.count()).toBe(0)
  })

  it("mirrors the org but no membership when the token carried no role", async () => {
    await writeIdentityProjection(identity({ orgRole: undefined }))
    expect(await getOrg("org_acme")).toBeDefined()
    expect(await getOrgMembership("org_acme", "usr_ada")).toBeUndefined()
  })

  it("is idempotent — signing in twice leaves one of everything", async () => {
    await writeIdentityProjection(identity())
    await writeIdentityProjection(identity())

    const db = getDb()
    expect(await db.users.count()).toBe(1)
    expect(await db.orgs.count()).toBe(1)
    expect(await db.orgMemberships.count()).toBe(1)
    expect(await listExternalIdentities("usr_ada")).toHaveLength(1)
  })

  it("refreshes a changed role and display name on the next sign-in", async () => {
    await writeIdentityProjection(identity())
    await writeIdentityProjection(
      identity({
        orgRole: "member",
        user: { id: "usr_ada", displayName: "Ada L.", createdAt: 5, updatedAt: 9 },
        binding: { ...identity().binding, updatedAt: 9 },
      })
    )
    expect(await getOrgMembership("org_acme", "usr_ada")).toMatchObject({ role: "member" })
    expect(await getUser("usr_ada")).toMatchObject({ displayName: "Ada L." })
  })

  it("exposes itself as the IdentityProjectionWriter sign-in writes through", async () => {
    await identityProjection.upsert(identity())
    expect(await getUser("usr_ada")).toBeDefined()
  })
})
