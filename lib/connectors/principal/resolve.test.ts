/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createFeishuPrincipal, upsertFeishuTenant } from "@/lib/db/feishu-principals"
import {
  getActiveRuntimeAccountId,
  hashOpenId,
  readIdentityScope,
  resolveConnectorPrincipal,
} from "./resolve"

const adapterRow = {
  settings: { larkPrincipalRegistry: true } as Record<string, unknown>,
  lastWhoamiResult: { botName: "bot", appId: "cli_1", openId: "ou_bot" },
}

const scope = { tenantKey: "tk_a", appId: "cli_1" }

async function seedResolved(accountId = "acct_a") {
  await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: accountId })
  return createFeishuPrincipal({
    tenantKey: "tk_a",
    appId: "cli_1",
    openId: "ou_1",
    cogniaAccountId: accountId,
    cogniaUserId: accountId,
  })
}

describe("resolveConnectorPrincipal", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("returns legacy for a platform without a principal registry", async () => {
    const result = await resolveConnectorPrincipal({
      platform: "telegram",
      adapterRow,
      remoteUserId: "u1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("legacy")
  })

  it("resolves through the platform vendor's registry", async () => {
    const principal = await seedResolved()
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_1",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result).toMatchObject({ status: "resolved", accountId: "acct_a" })
    expect(result.status === "resolved" && result.principal.id).toBe(principal.id)
  })

  it("fails closed through the vendor for an unknown sender", async () => {
    await seedResolved()
    const result = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow,
      remoteUserId: "ou_stranger",
      identityScope: scope,
      activeAccountId: "acct_a",
    })
    expect(result.status).toBe("unbound")
  })
})

describe("helpers", () => {
  it("hashOpenId is stable and hex", async () => {
    const a = await hashOpenId("ou_12345")
    const b = await hashOpenId("ou_12345")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    expect(await hashOpenId("ou_other")).not.toBe(a)
  })

  it("readIdentityScope tolerates malformed channelData", () => {
    expect(readIdentityScope(undefined)).toBeUndefined()
    expect(readIdentityScope({})).toBeUndefined()
    expect(readIdentityScope({ identityScope: "nope" })).toBeUndefined()
    expect(readIdentityScope({ identityScope: {} })).toBeUndefined()
    expect(readIdentityScope({ identityScope: { tenantKey: "tk", appId: 5 } })).toEqual({
      tenantKey: "tk",
      appId: undefined,
    })
  })

  it("readIdentityScope keeps a string union_id and drops anything else", () => {
    expect(
      readIdentityScope({ identityScope: { tenantKey: "tk", appId: "cli", unionId: "on_1" } })
    ).toEqual({ tenantKey: "tk", appId: "cli", unionId: "on_1" })
    expect(
      readIdentityScope({ identityScope: { tenantKey: "tk", appId: "cli", unionId: 7 } })
    ).toEqual({ tenantKey: "tk", appId: "cli" })
    expect(readIdentityScope({ identityScope: { tenantKey: "tk", unionId: "" } })).toEqual({
      tenantKey: "tk",
      appId: undefined,
    })
  })

  it("getActiveRuntimeAccountId derives from the active account database name", () => {
    expect(getActiveRuntimeAccountId()).toBe(process.env.COGNIA_LOCAL_ACCOUNT_ID ?? "local_acct_a")
  })
})
