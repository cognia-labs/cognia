import { encryptedAccountDatabaseName } from "@/lib/accounts/account-db"
import {
  AccountContentCipher,
  activateAccountContentCipher,
  lockAccountContentCipher,
} from "@/lib/accounts/content-cipher"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { linkExternalIdentity, type LinkExternalIdentityInput } from "@/lib/db/identity"
import type { ExternalIdentity } from "@/types/identity"

import { externalProviderFor, linkSignedInIdentities } from "./link-signed-in-identities"

describe("externalProviderFor", () => {
  it("maps Logto's Feishu connector target onto the lark vocabulary", () => {
    expect(externalProviderFor("feishu-web")).toBe("lark")
    expect(externalProviderFor("feishu")).toBe("lark")
    expect(externalProviderFor("Lark")).toBe("lark")
    expect(externalProviderFor("github")).toBe("github")
  })

  it("has no word for a provider the identity table does not know", () => {
    expect(externalProviderFor("google")).toBeNull()
    expect(externalProviderFor("")).toBeNull()
  })
})

describe("linkSignedInIdentities", () => {
  const link = jest.fn(
    async (input: LinkExternalIdentityInput) =>
      ({
        id: `${input.provider}:${input.tenant ?? ""}:${input.subject}`,
        userId: input.userId,
        provider: input.provider,
        subject: input.subject,
        ...(input.tenant ? { tenant: input.tenant } : {}),
        ...(input.label ? { label: input.label } : {}),
        linkedAt: input.now ?? 0,
      }) as ExternalIdentity
  )

  beforeEach(() => link.mockClear())

  it("links GitHub and Feishu identities onto the canonical user, tenant included", async () => {
    const report = await linkSignedInIdentities(
      {
        userId: "usr_canonical",
        identities: [
          { provider: "github", subject: "12345", label: "ada" },
          { provider: "feishu-web", subject: "on_abc", tenant: "tenant_key_1" },
        ],
      },
      { find: jest.fn(async () => undefined), link, now: () => 7 }
    )
    expect(report.conflicts).toEqual([])
    expect(report.skipped).toEqual([])
    expect(link).toHaveBeenCalledWith({
      userId: "usr_canonical",
      provider: "github",
      subject: "12345",
      label: "ada",
      now: 7,
    })
    expect(link).toHaveBeenCalledWith({
      userId: "usr_canonical",
      provider: "lark",
      subject: "on_abc",
      tenant: "tenant_key_1",
      now: 7,
    })
    expect(report.linked.map((row) => row.provider)).toEqual(["github", "lark"])
  })

  it("re-links a subject that already belongs to the same person", async () => {
    const report = await linkSignedInIdentities(
      { userId: "usr_a", identities: [{ provider: "github", subject: "1" }] },
      { find: jest.fn(async () => "usr_a"), link }
    )
    expect(report.linked).toHaveLength(1)
    expect(report.conflicts).toEqual([])
  })

  /** Two Users for one human is a migration somebody confirms, not a side effect. */
  it("reports a subject held by another user as a conflict and leaves it alone", async () => {
    const report = await linkSignedInIdentities(
      {
        userId: "usr_login",
        identities: [{ provider: "feishu-web", subject: "ou_im_first", tenant: "t1" }],
      },
      { find: jest.fn(async () => "usr_im_first"), link }
    )
    expect(link).not.toHaveBeenCalled()
    expect(report.conflicts).toEqual([
      { provider: "lark", subject: "ou_im_first", tenant: "t1", existingUserId: "usr_im_first" },
    ])
  })

  it("skips providers it has no word for and blank subjects, without failing the rest", async () => {
    const report = await linkSignedInIdentities(
      {
        userId: "usr_a",
        identities: [
          { provider: "google", subject: "g1" },
          { provider: "github", subject: "   " },
          { provider: "github", subject: "ok" },
        ],
      },
      { find: jest.fn(async () => undefined), link }
    )
    expect(report.skipped).toEqual(["google", "github"])
    expect(report.linked).toHaveLength(1)
  })
})

describe("linkSignedInIdentities profile isolation", () => {
  const fixture = createDbTestFixture({ emptyTables: ["externalIdentities"] })
  beforeAll(fixture.initialize)
  beforeEach(fixture.restore)
  afterAll(fixture.dispose)

  it("keeps canonical identity keys and conflicts when using the real database transaction", async () => {
    await linkExternalIdentity({ userId: "usr_existing", provider: "github", subject: "held" })
    const report = await linkSignedInIdentities(
      {
        userId: "usr_owner",
        identities: [
          { provider: "github", subject: "held" },
          {
            provider: "feishu-web",
            subject: "union_owner",
            tenant: "tenant_owner",
            label: "Owner",
          },
        ],
      },
      { now: () => 7 }
    )
    expect(report.conflicts).toEqual([
      { provider: "github", subject: "held", existingUserId: "usr_existing" },
    ])
    expect(report.linked).toEqual([
      {
        id: "lark:tenant_owner:union_owner",
        userId: "usr_owner",
        provider: "lark",
        subject: "union_owner",
        tenant: "tenant_owner",
        label: "Owner",
        linkedAt: 7,
      },
    ])
    expect(await getDb().externalIdentities.get("github::held")).toMatchObject({
      userId: "usr_existing",
    })
  })

  it.each(["lookup", "write"] as const)(
    "rejects a profile switch after a real identity %s without cross-profile writes or partial links",
    async (boundary) => {
      const originalDb = getDb()
      const otherId = "acct_social_other"
      activateAccountContentCipher(
        await AccountContentCipher.createForTesting(otherId, encryptedAccountDatabaseName(otherId))
      )
      const get = originalDb.externalIdentities.get.bind(originalDb.externalIdentities)
      const put = originalDb.externalIdentities.put.bind(originalDb.externalIdentities)
      const intercepted =
        boundary === "lookup"
          ? jest.spyOn(originalDb.externalIdentities, "get").mockImplementationOnce((key) =>
              get(key).then((row) => {
                activateAccountDatabase(otherId)
                return row
              })
            )
          : jest.spyOn(originalDb.externalIdentities, "put").mockImplementationOnce((row, key) =>
              put(row, key).then((id) => {
                activateAccountDatabase(otherId)
                return id
              })
            )
      try {
        await expect(
          linkSignedInIdentities({
            userId: "usr_profile_a",
            identities: [{ provider: "github", subject: "profile-a" }],
          })
        ).rejects.toThrow()
        expect(await getDb().externalIdentities.toArray()).toEqual([])
      } finally {
        intercepted.mockRestore()
        await getDb().delete()
        clearAccountDatabaseSelection()
        lockAccountContentCipher()
      }
      expect(await getDb().externalIdentities.toArray()).toEqual([])
    }
  )
})
