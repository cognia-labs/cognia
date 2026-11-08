/** @jest-environment jsdom */
import type { ConversationOverrideRow } from "./connector-types"
import {
  readConversationOverride,
  renameOnCreate,
  renameOnUpdate,
} from "./conversation-override-legacy"
import { patchConversationOverride, readForResolution } from "./conversation-overrides"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const KEY = "lark:adp_1:oc_legacy"

/** A row as a build before ADR-0252 §6 wrote it. */
const legacyRow = (extra: Record<string, unknown> = {}) =>
  ({
    id: "cov_legacy",
    conversationKey: KEY,
    sessionId: "s1",
    createdAt: 1,
    updatedAt: 1,
    teamId: "squad-old",
    ...extra,
  }) as unknown as ConversationOverrideRow

/** Bypass the hooks to plant what an old build left on disk. */
async function plantRaw(row: ConversationOverrideRow) {
  const db = getDb()
  await db.transaction("rw", db.conversationOverrides, async (tx) => {
    await tx.idbtrans.objectStore("conversationOverrides").put(row)
  })
}

describe("the pure translations", () => {
  it("reads the old names as the new ones, the new name winning, snapshot included", () => {
    expect(
      readConversationOverride(
        legacyRow({
          teamDisabled: true,
          assignmentPreviousRouting: { teamId: "squad-snap", characterId: "c1" },
        })
      )
    ).toEqual({
      id: "cov_legacy",
      conversationKey: KEY,
      sessionId: "s1",
      createdAt: 1,
      updatedAt: 1,
      squadId: "squad-old",
      squadDisabled: true,
      assignmentPreviousRouting: { squadId: "squad-snap", characterId: "c1" },
    })
    expect(readConversationOverride(legacyRow({ squadId: "squad-new" })).squadId).toBe("squad-new")
    const current = { ...legacyRow(), teamId: undefined } as ConversationOverrideRow
    delete (current as { teamId?: string }).teamId
    expect(readConversationOverride(current)).toBe(current)
  })

  it("renames a created row in place", () => {
    const row = legacyRow({ teamDisabled: false })
    renameOnCreate(row as never)
    expect(row).toMatchObject({ squadId: "squad-old", squadDisabled: false })
    expect(row).not.toHaveProperty("teamId")
    expect(row).not.toHaveProperty("teamDisabled")
  })

  it("moves an old row's binding on any update, and takes an old client's write as the new name", () => {
    expect(renameOnUpdate({ muted: true }, legacyRow() as never)).toEqual({
      squadId: "squad-old",
      teamId: undefined,
    })
    // A write that sets the new name itself is not overruled by the old one.
    expect(renameOnUpdate({ squadId: undefined }, legacyRow() as never)).toEqual({
      teamId: undefined,
    })
    expect(
      renameOnUpdate({ teamId: "squad-x", teamDisabled: undefined }, { id: "r" } as never)
    ).toEqual({
      squadId: "squad-x",
      teamId: undefined,
      squadDisabled: undefined,
      teamDisabled: undefined,
    })
    expect(renameOnUpdate({ muted: true }, { id: "r", squadId: "s" } as never)).toBeUndefined()
    expect(
      renameOnUpdate({}, { id: "r", assignmentPreviousRouting: { teamDisabled: true } } as never)
    ).toEqual({ assignmentPreviousRouting: { squadDisabled: true } })
  })
})

describe("the table's hooks", () => {
  it("answers an old row with the new names, and a later clear stays cleared", async () => {
    await plantRaw(legacyRow())
    expect((await readForResolution(KEY))?.squadId).toBe("squad-old")
    expect(await readForResolution(KEY)).not.toHaveProperty("teamId")

    await patchConversationOverride(KEY, { squadId: undefined, squadDisabled: true })
    const row = await readForResolution(KEY)
    expect(row?.squadId).toBeUndefined()
    expect(row?.squadDisabled).toBe(true)
    const stored = await getDb().transaction(
      "r",
      getDb().conversationOverrides,
      (tx) =>
        new Promise<unknown>((resolve) => {
          const request = tx.idbtrans.objectStore("conversationOverrides").get("cov_legacy")
          request.onsuccess = () => resolve(request.result)
        })
    )
    expect(stored).not.toHaveProperty("teamId")
  })

  it("stores a row an old client relayed under the new names", async () => {
    await getDb().conversationOverrides.put(legacyRow({ teamDisabled: true }))
    const stored = await getDb().transaction(
      "r",
      getDb().conversationOverrides,
      (tx) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const request = tx.idbtrans.objectStore("conversationOverrides").get("cov_legacy")
          request.onsuccess = () => resolve(request.result)
        })
    )
    expect(stored).toMatchObject({ squadId: "squad-old", squadDisabled: true })
    expect(stored).not.toHaveProperty("teamId")
    expect(stored).not.toHaveProperty("teamDisabled")
  })
})
