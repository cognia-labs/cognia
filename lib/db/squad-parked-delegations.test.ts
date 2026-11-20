/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { CURRENT_SCHEMA } from "./schema"
import {
  claimParkedDelegation,
  deleteParkedDelegation,
  listParkedDelegations,
  putParkedDelegation,
  type SquadParkedDelegationRow,
} from "./squad-parked-delegations"

const row = (id: string, createdAt: number): SquadParkedDelegationRow => ({
  id,
  sourceTeamId: "squad-1",
  sourceTaskId: "task-1",
  targetType: "background",
  targetId: `bg_${id}`,
  reason: "later",
  manual: true,
  createdAt,
  run: { kind: "background", prompt: "Summarise <EMAIL_001>", targetId: `bg_${id}` },
  redacted: true,
})

describe("squad parked delegation store", () => {
  let db: Dexie
  beforeEach(async () => {
    db = new Dexie(`squad-parked-delegations-${crypto.randomUUID()}`)
    db.version(1).stores({ squadParkedDelegations: CURRENT_SCHEMA.squadParkedDelegations! })
    await db.open()
  })
  afterEach(async () => {
    await db.delete()
  })

  it("lists every parked delegation, oldest first", async () => {
    await putParkedDelegation(db, row("b", 3))
    await putParkedDelegation(db, row("a", 1))
    await putParkedDelegation(db, row("c", 3))
    expect((await listParkedDelegations(db)).map((kept) => kept.id)).toEqual(["a", "b", "c"])
  })

  it("replaces a parked delegation written again under its id", async () => {
    await putParkedDelegation(db, row("a", 1))
    await putParkedDelegation(db, { ...row("a", 1), reason: "rewritten" })
    expect(await listParkedDelegations(db)).toEqual([{ ...row("a", 1), reason: "rewritten" }])
  })

  it("hands a parked delegation to one claim only", async () => {
    await putParkedDelegation(db, row("a", 1))
    const [first, second] = await Promise.all([
      claimParkedDelegation(db, "a"),
      claimParkedDelegation(db, "a"),
    ])
    expect([first, second].filter(Boolean)).toEqual([row("a", 1)])
    expect(await listParkedDelegations(db)).toEqual([])
  })

  it("claims nothing for a delegation that is not kept", async () => {
    await expect(claimParkedDelegation(db, "missing")).resolves.toBeUndefined()
  })

  it("forgets one parked delegation, and forgetting a missing one is a no-op", async () => {
    await putParkedDelegation(db, row("a", 1))
    await putParkedDelegation(db, row("b", 2))
    await deleteParkedDelegation(db, "a")
    await deleteParkedDelegation(db, "missing")
    expect((await listParkedDelegations(db)).map((kept) => kept.id)).toEqual(["b"])
  })
})
