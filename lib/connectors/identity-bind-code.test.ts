import {
  HOST_OWNER_BIND_MAX_ATTEMPTS,
  __resetHostOwnerBindCodeForTesting,
  getActiveHostOwnerBindCodeMeta,
  issueHostOwnerBindCode,
  normalizeHostOwnerBindCode,
  redeemHostOwnerBindCode,
} from "./identity-bind-code"
import { isVerifiedHostOwnerPlatformUser } from "@/lib/db/platform-identities"
import { createDbTestFixture } from "@/lib/db/test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetHostOwnerBindCodeForTesting()
})
afterAll(dbFixture.dispose)

describe("identity-bind-code (F8)", () => {
  it("normalizes codes with or without leading /bind prefix", () => {
    expect(normalizeHostOwnerBindCode("  /bind bind-abcd-2345-6789 ")).toBe("BIND-ABCD-2345-6789")
    expect(normalizeHostOwnerBindCode("bind-abcd-2345-6789")).toBe("BIND-ABCD-2345-6789")
  })

  it("issues a single-use SHA-256 hashed challenge, binds the sender in private DM, and blocks replay", async () => {
    const issued = await issueHostOwnerBindCode({ now: 1_000, ttlMs: 60_000 })
    expect(issued.code).toMatch(/^BIND-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(issued.commandText).toBe(`/bind ${issued.code}`)
    expect(getActiveHostOwnerBindCodeMeta(2_000)).toEqual({
      expiresAt: 61_000,
      attemptsRemaining: HOST_OWNER_BIND_MAX_ATTEMPTS,
    })

    const redeemed = await redeemHostOwnerBindCode({
      code: issued.code.toLowerCase(),
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_owner",
      displayName: "Owner",
      isPrivateChannel: true,
      now: 5_000,
    })
    expect(redeemed.ok).toBe(true)
    expect(await isVerifiedHostOwnerPlatformUser("telegram", "u_owner")).toBe(true)
    expect(getActiveHostOwnerBindCodeMeta(5_000)).toBeNull()

    const replay = await redeemHostOwnerBindCode({
      code: issued.code,
      platform: "discord",
      adapterId: "dc-1",
      remoteUserId: "u_attacker",
      isPrivateChannel: true,
      now: 6_000,
    })
    expect(replay).toEqual({ ok: false, reason: "no_active_code" })
    expect(await isVerifiedHostOwnerPlatformUser("discord", "u_attacker")).toBe(false)
  })

  it("refuses group-chat redemption without burning the active code", async () => {
    const issued = await issueHostOwnerBindCode({ now: 1_000, ttlMs: 60_000 })
    const groupAttempt = await redeemHostOwnerBindCode({
      code: issued.code,
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_group",
      isPrivateChannel: false,
      now: 2_000,
    })
    expect(groupAttempt).toEqual({ ok: false, reason: "not_private" })
    expect(getActiveHostOwnerBindCodeMeta(2_000)?.attemptsRemaining).toBe(
      HOST_OWNER_BIND_MAX_ATTEMPTS
    )
  })

  it("invalidates the active code after 3 failed guesses and rejects expired codes", async () => {
    const issued = await issueHostOwnerBindCode({ now: 1_000, ttlMs: 10_000 })

    const first = await redeemHostOwnerBindCode({
      code: "BIND-2222-2222-2222",
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_1",
      isPrivateChannel: true,
      now: 2_000,
    })
    expect(first).toEqual({ ok: false, reason: "invalid_code", attemptsRemaining: 2 })

    const second = await redeemHostOwnerBindCode({
      code: "BIND-3333-3333-3333",
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_1",
      isPrivateChannel: true,
      now: 3_000,
    })
    expect(second).toEqual({ ok: false, reason: "invalid_code", attemptsRemaining: 1 })

    const third = await redeemHostOwnerBindCode({
      code: "BIND-4444-4444-4444",
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_1",
      isPrivateChannel: true,
      now: 4_000,
    })
    expect(third).toEqual({ ok: false, reason: "locked_out", attemptsRemaining: 0 })

    // Even the real code is now dead.
    const afterLockout = await redeemHostOwnerBindCode({
      code: issued.code,
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_owner",
      isPrivateChannel: true,
      now: 5_000,
    })
    expect(afterLockout).toEqual({ ok: false, reason: "no_active_code" })

    const expiring = await issueHostOwnerBindCode({ now: 10_000, ttlMs: 5_000 })
    const expired = await redeemHostOwnerBindCode({
      code: expiring.code,
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "u_owner",
      isPrivateChannel: true,
      now: 15_000,
    })
    expect(expired).toEqual({ ok: false, reason: "expired" })
  })
})
