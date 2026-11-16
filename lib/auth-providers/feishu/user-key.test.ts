/** @jest-environment node */
import {
  larkAuthorizedUsers,
  larkPendingCredential,
  larkPerson,
  larkUserCredentials,
  larkUserKey,
} from "./user-key"

describe("Lark user keys", () => {
  it("names a person by the SHA-256 of their open_id, as the Host store does", async () => {
    const key = await larkUserKey("ou_member")
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await larkUserKey("ou_member")).toBe(key)
    expect(await larkUserKey("ou_owner")).not.toBe(key)
    expect(larkUserCredentials(key)).toEqual([
      `user_token.${key}`,
      `user_refresh_token.${key}`,
      `user_authorization_epoch.${key}`,
    ])
  })

  it("names a pending sign-in by its own state", async () => {
    const pending = await larkPendingCredential("lark:adp:nonce")
    expect(pending).toMatch(/^oauth_pending\.[0-9a-f]{64}$/)
    expect(await larkPendingCredential("lark:adp:other")).not.toBe(pending)
  })

  it("reads only well-formed authorization records", () => {
    const key = "a".repeat(64)
    const user = { openId: "ou_a", expiresAtMs: 1, refreshExpiresAtMs: 2 }
    expect(
      larkAuthorizedUsers({
        authorizedUsers: { [key]: user, "not-a-key": user, ["b".repeat(64)]: { name: "x" } },
      })
    ).toEqual({ [key]: user })
    expect(larkAuthorizedUsers({ authorizedUsers: [user] })).toEqual({})
    expect(larkAuthorizedUsers({})).toEqual({})
  })

  it("names the person as acting identities do", () => {
    expect(larkPerson("adp", { openId: "ou_a" })).toEqual({
      kind: "platform",
      platform: "lark",
      adapterId: "adp",
      remoteUserId: "ou_a",
    })
    expect(larkPerson("adp", { openId: "ou_a", unionId: "on_a" })).toMatchObject({
      unionId: "on_a",
    })
  })
})
