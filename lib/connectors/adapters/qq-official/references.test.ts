import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { recordQQReference, findQQReference } from "./references"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const scope = { adapterId: "qq-1", scene: "group" as const, sceneId: "group" }

describe("QQ durable quote references", () => {
  it("stores both directions independently of adapter instance memory", async () => {
    await recordQQReference(scope, "real-id", "REFIDX_own==")
    const db = getDb()
    db.close()
    await db.open()
    expect(await findQQReference(scope, { messageId: "real-id" })).toEqual({
      messageId: "real-id",
      referenceIndex: "REFIDX_own==",
    })
    expect(await findQQReference(scope, { referenceIndex: "REFIDX_own==" })).toEqual({
      messageId: "real-id",
      referenceIndex: "REFIDX_own==",
    })
    expect(
      await findQQReference({ ...scope, adapterId: "other" }, { messageId: "real-id" })
    ).toBeUndefined()
    expect(
      await findQQReference({ ...scope, sceneId: "other" }, { referenceIndex: "REFIDX_own==" })
    ).toBeUndefined()
    expect(
      await findQQReference({ ...scope, scene: "c2c" }, { messageId: "real-id" })
    ).toBeUndefined()
    expect(
      (await getDb().inboundLedger.toArray()).every((row) => row.namespace === "qq-reference")
    ).toBe(true)
  })

  it("fails conservatively on conflicting mappings and concurrent duplicate records", async () => {
    await Promise.all([
      recordQQReference(scope, "first", "REFIDX_same"),
      recordQQReference(scope, "first", "REFIDX_same"),
    ])
    expect(await findQQReference(scope, { messageId: "first" })).toBeDefined()
    await recordQQReference(scope, "second", "REFIDX_same")
    expect(await findQQReference(scope, { messageId: "first" })).toBeUndefined()
    expect(await findQQReference(scope, { messageId: "second" })).toBeUndefined()
    expect(await findQQReference(scope, { referenceIndex: "REFIDX_same" })).toBeUndefined()
    await recordQQReference(scope, "first", "REFIDX_same")
    expect(await findQQReference(scope, { messageId: "first" })).toBeUndefined()
  })

  it("bounds retained mappings and never stores blank or control-character indexes", async () => {
    await recordQQReference(scope, "bad", "\nsecret")
    expect(await findQQReference(scope, { messageId: "bad" })).toBeUndefined()
    for (let i = 0; i < 4; i++) await recordQQReference(scope, `id-${i}`, `REFIDX_${i}`, 4)
    expect(
      await getDb().inboundLedger.where("namespace").equals("qq-reference").count()
    ).toBeLessThanOrEqual(4)
    expect(await findQQReference(scope, { messageId: "id-3" })).toBeDefined()
  })
})
