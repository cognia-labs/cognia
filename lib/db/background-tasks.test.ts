jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { getDb, type BackgroundTaskJournalRow } from "./schema"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import { activateAccountDatabase, clearAccountDatabaseSelection } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  BACKGROUND_TASK_LEASE_TTL_MS,
  backgroundTaskStatus,
  clearSettledBackgroundTasks,
  reserveBackgroundTaskDelivery,
  admitBackgroundDispatch,
  createDexieBackgroundTaskJournal,
  getBackgroundTaskRecord,
  interruptBackgroundTasksOnBoot,
  listBackgroundTaskRecords,
  pruneBackgroundTaskRecords,
  recordBackgroundTaskStart,
  recordBackgroundTaskSettle,
  updateBackgroundTaskRecord,
  upsertBackgroundJobSettlement,
} from "./background-tasks"
import {
  JOB_RECONCILE_WINDOW_MS,
  outboxRecordFromJobExit,
  outboxRecordFromMonitor,
} from "@/lib/background-tasks/job-settlement"
import {
  SQUAD_HANDOFF_RECONCILE_WINDOW_MS,
  squadHandoffOutboxRecord,
} from "@/lib/background-tasks/squad-handoff-outbox"

/**
 * A stored entry. A renderer entry stores no status (its run is the status),
 * so a `status` given here is written as the outbox facts that read back as
 * it with no run row: `done` and `error` are a recorded result, `interrupted`
 * an entry whose host stopped first. A CLI entry stores its status as given.
 */
function row(overrides: Partial<BackgroundTaskJournalRow> = {}): BackgroundTaskJournalRow {
  const stored: BackgroundTaskJournalRow = {
    runId: "bg_1",
    kind: "subagent",
    subagentId: "reviewer",
    prompt: "check this",
    sessionId: "ses_1",
    host: "renderer",
    status: "running",
    startedAt: 1000,
    ...overrides,
  }
  if (stored.host !== "renderer") return stored
  const { status, ...outbox } = stored
  if (status === "running") return outbox
  const settledAt = outbox.settledAt ?? 3000
  return {
    ...outbox,
    settledAt,
    ...(status === "interrupted" ? { interruptedAt: outbox.interruptedAt ?? settledAt } : {}),
    ...(status === "error" && !outbox.error ? { error: "failed" } : {}),
  }
}

/** What the registry hands a journal at start: an entry with its status. */
function started(overrides: Partial<BackgroundTaskJournalRow> = {}): BackgroundTaskJournalRecord {
  return { ...row(overrides), status: "running" }
}

const expiredLease = { ownerId: "previous-window", epoch: 1, expiresAt: 2000 }
const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().backgroundTasks.clear()
})
afterAll(dbFixture.dispose)

describe("background task journal table", () => {
  it("is registered in the latest Dexie schema", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(87)
    expect(db.backgroundTasks).toBeDefined()
  })

  it("round-trips start and settle transitions through the journal adapter", async () => {
    const journal = createDexieBackgroundTaskJournal()

    await journal.recordStart(started())
    await journal.recordSettle("bg_1", {
      status: "done",
      settledAt: 2000,
      resultText: "finished",
      usage: { inputTokens: 3, outputTokens: 5 },
    })

    await expect(getBackgroundTaskRecord("bg_1")).resolves.toMatchObject({
      runId: "bg_1",
      status: "done",
      resultText: "finished",
      usage: { inputTokens: 3, outputTokens: 5 },
    })
    await expect(listBackgroundTaskRecords({ host: "renderer" })).resolves.toHaveLength(1)
  })

  it("marks running rows interrupted on boot without touching settled history", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "running", status: "running", ownerLease: expiredLease }),
      row({ runId: "done", status: "done", settledAt: 1500, resultText: "ok" }),
    ])

    const flipped = await interruptBackgroundTasksOnBoot({ now: () => 3000 })

    await expect(getBackgroundTaskRecord("running")).resolves.toMatchObject({
      status: "interrupted",
      settledAt: 3000,
    })
    await expect(getBackgroundTaskRecord("done")).resolves.toMatchObject({
      status: "done",
      resultText: "ok",
    })
    // Returns only THIS boot's transitions so auto-resume never replays stale history.
    expect(flipped).toEqual([
      expect.objectContaining({ runId: "running", status: "interrupted", settledAt: 3000 }),
    ])
  })

  it("hands every row it interrupted to the caller once the flip has committed", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "leased", status: "running", ownerLease: expiredLease }),
      row({ runId: "unowned", status: "running" }),
      row({ runId: "done", status: "done", settledAt: 1500 }),
    ])
    const seen: string[] = []
    const onInterrupted = jest.fn(async (rows: { runId: string }[]) => {
      // Committed: the caller reads the flipped rows.
      for (const flipped of rows)
        expect((await getBackgroundTaskRecord(flipped.runId))?.status).toBe("interrupted")
      seen.push(...rows.map((flipped) => flipped.runId))
    })

    await interruptBackgroundTasksOnBoot({ now: () => 3000, onInterrupted })

    expect(seen.sort()).toEqual(["leased", "unowned"])
    // Nothing flipped, nothing reported.
    await interruptBackgroundTasksOnBoot({ now: () => 4000, onInterrupted })
    expect(onInterrupted).toHaveBeenCalledTimes(1)
  })

  it("persists the optional journal extensions (mode/delivery/resume lineage)", async () => {
    const journal = createDexieBackgroundTaskJournal()

    await journal.recordStart(
      started({
        mode: "background",
        toolsEnabled: false,
        resumeOfRunId: "bg_0",
        resumeAttempt: 2,
        pluginId: "p1",
        label: "sweeper",
      })
    )
    await journal.update("bg_1", {
      status: "done",
      settledAt: 2000,
      resultText: "ok",
      collectedAt: 2500,
      deliveryState: "pending",
      resumedByRunId: "bg_2",
    })

    await expect(getBackgroundTaskRecord("bg_1")).resolves.toMatchObject({
      mode: "background",
      toolsEnabled: false,
      resumeOfRunId: "bg_0",
      resumeAttempt: 2,
      pluginId: "p1",
      label: "sweeper",
      collectedAt: 2500,
      deliveryState: "pending",
      resumedByRunId: "bg_2",
    })
  })

  it("clears settled history while preserving running rows", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "running", status: "running" }),
      row({ runId: "error", status: "error", settledAt: 2000, error: "boom" }),
      row({ runId: "interrupted", status: "interrupted", settledAt: 3000 }),
    ])

    await clearSettledBackgroundTasks()

    await expect(listBackgroundTaskRecords()).resolves.toEqual([
      expect.objectContaining({ runId: "running", status: "running" }),
    ])
  })

  it("clears settled history for one host without deleting the other host", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "renderer-done", host: "renderer", status: "done", settledAt: 2000 }),
      row({ runId: "cli-done", host: "cli", status: "done", settledAt: 2000 }),
    ])

    await clearSettledBackgroundTasks({ host: "renderer" })

    await expect(listBackgroundTaskRecords()).resolves.toEqual([
      expect.objectContaining({ runId: "cli-done", host: "cli", status: "done" }),
    ])
  })
})

describe("the outbox and its read model (ADR-0252 §2)", () => {
  const open = row({ runId: "x" })
  const settled = row({ runId: "x", status: "done" })
  const failed = row({ runId: "x", status: "error" })
  const interrupted = row({ runId: "x", status: "interrupted" })

  it.each([
    ["an open entry of a running run", open, "running", "running"],
    ["a recorded result of a run still settling", settled, "running", "running"],
    ["a recorded result of a completed run", settled, "completed", "done"],
    ["a recorded result of a failed run", settled, "failed", "error"],
    ["a recorded result of a cancelled run", settled, "cancelled", "error"],
    // The run ended, the result has not landed: a collect must keep waiting.
    ["an open entry of a completed run", open, "completed", "running"],
    [
      "an entry whose host stopped, its run cancelled after",
      interrupted,
      "cancelled",
      "interrupted",
    ],
    ["an entry whose host stopped, its run still open", interrupted, "running", "interrupted"],
  ] as const)("reads %s as its run says", (_name, entry, run, status) => {
    expect(backgroundTaskStatus(entry, { status: run })).toBe(status)
  })

  it("reads an entry with no run row (its launch was refused) from its result", () => {
    expect(backgroundTaskStatus(open, undefined)).toBe("running")
    expect(backgroundTaskStatus(settled, undefined)).toBe("done")
    expect(backgroundTaskStatus(failed, undefined)).toBe("error")
    expect(backgroundTaskStatus(interrupted, undefined)).toBe("interrupted")
  })

  it("reads a CLI entry from the status it stores", () => {
    const cli = row({ runId: "x", host: "cli", status: "error", settledAt: 2000 })
    expect(backgroundTaskStatus(cli, { status: "completed" })).toBe("error")
  })

  it("stores no status on a renderer entry, start to settle", async () => {
    const journal = createDexieBackgroundTaskJournal()
    await journal.recordStart({ ...row({ runId: "outbox" }), status: "running" })
    expect(await getDb().backgroundTasks.get("outbox")).not.toHaveProperty("status")
    await journal.recordSettle("outbox", { status: "done", settledAt: 2000, resultText: "ok" })
    const stored = await getDb().backgroundTasks.get("outbox")
    expect(stored).not.toHaveProperty("status")
    expect(stored).toMatchObject({ settledAt: 2000, resultText: "ok" })
  })

  it("keeps the status a CLI entry stores", async () => {
    const journal = createDexieBackgroundTaskJournal()
    await journal.recordStart({ ...row({ runId: "cli", host: "cli" }), status: "running" })
    await journal.recordSettle("cli", { status: "error", settledAt: 2000, error: "boom" })
    expect(await getDb().backgroundTasks.get("cli")).toMatchObject({ status: "error" })
  })

  it("clears a status written before the outbox when the entry is next updated", async () => {
    await getDb().backgroundTasks.put({ ...row({ runId: "legacy" }), status: "running" })
    await updateBackgroundTaskRecord("legacy", { collectedAt: 1500 })
    expect(await getDb().backgroundTasks.get("legacy")).not.toHaveProperty("status")
  })

  it("lists entries with their run's status and follows the run", async () => {
    const { startToolExecutionRun, finishToolExecutionRun } =
      await import("@/lib/execution/acting-authority")
    await startToolExecutionRun("ses_1", { runId: "execution:job:joined" })
    await getDb().backgroundTasks.put(
      row({ runId: "joined", status: "done", settledAt: 2000, resultText: "ok" })
    )
    await expect(getBackgroundTaskRecord("joined")).resolves.toMatchObject({ status: "running" })
    await expect(listBackgroundTaskRecords({ status: "running" })).resolves.toHaveLength(1)

    await finishToolExecutionRun("execution:job:joined", true)

    await expect(getBackgroundTaskRecord("joined")).resolves.toMatchObject({ status: "error" })
    await expect(listBackgroundTaskRecords({ status: "running" })).resolves.toEqual([])
    await expect(listBackgroundTaskRecords({ status: "error" })).resolves.toEqual([
      expect.objectContaining({ runId: "joined", resultText: "ok" }),
    ])
  })
})

describe("pruneBackgroundTaskRecords", () => {
  const DAY = 24 * 60 * 60 * 1000

  it("drops settled rows past maxAge but never running rows", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "old-running", status: "running", startedAt: 0 }),
      row({ runId: "old-done", status: "done", startedAt: 0, settledAt: 1000 }),
      row({ runId: "fresh-done", status: "done", startedAt: 20 * DAY, settledAt: 20 * DAY }),
    ])

    const removed = await pruneBackgroundTaskRecords({ now: 21 * DAY, maxAgeMs: 14 * DAY })

    expect(removed).toBe(1)
    const remaining = await listBackgroundTaskRecords()
    expect(remaining.map((r) => r.runId).sort()).toEqual(["fresh-done", "old-running"])
  })

  it("uses startedAt for age when a row never settled", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      // A CLI entry keeps its status; this one never recorded a settle time.
      row({ runId: "stale-interrupted", host: "cli", status: "interrupted", startedAt: 0 }),
    ])

    const removed = await pruneBackgroundTaskRecords({ now: 15 * DAY, maxAgeMs: 14 * DAY })

    expect(removed).toBe(1)
    await expect(listBackgroundTaskRecords()).resolves.toEqual([])
  })

  it("trims the settled backlog to the newest maxItems", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "s1", status: "done", startedAt: 1000, settledAt: 1100 }),
      row({ runId: "s2", status: "done", startedAt: 2000, settledAt: 2100 }),
      row({ runId: "s3", status: "done", startedAt: 3000, settledAt: 3100 }),
      row({ runId: "live", status: "running", startedAt: 500 }),
    ])

    const removed = await pruneBackgroundTaskRecords({ now: 4000, maxAgeMs: 0, maxItems: 2 })

    expect(removed).toBe(1)
    const remaining = await listBackgroundTaskRecords()
    expect(remaining.map((r) => r.runId).sort()).toEqual(["live", "s2", "s3"])
  })

  it("scopes pruning to a host when given one", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "renderer-old", host: "renderer", status: "done", startedAt: 0, settledAt: 0 }),
      row({ runId: "cli-old", host: "cli", status: "done", startedAt: 0, settledAt: 0 }),
    ])

    await pruneBackgroundTaskRecords({ now: 30 * DAY, host: "renderer" })

    await expect(listBackgroundTaskRecords()).resolves.toEqual([
      expect.objectContaining({ runId: "cli-old" }),
    ])
  })
})

function admissionRow(overrides: Partial<BackgroundTaskJournalRow> = {}) {
  return row({
    mode: "background",
    toolsEnabled: false,
    recovery: {
      version: 1,
      phase: "accepted",
      namespaceId: getDb().name,
      hostId: "host-1",
      contextFingerprint: "frozen",
      executionSessionId: "child-bg-1",
      caller: {
        parentDepth: 0,
        maxDepth: 2,
        maxConcurrent: 0,
        parentChain: [],
        budgetRoot: "dispatch:ses_1",
      },
      target: { id: "reviewer", name: "Reviewer", description: "Review", prompt: "review" },
      sideEffect: "none",
    },
    ...overrides,
  })
}

describe("durable background admission", () => {
  beforeEach(async () => {
    await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
  })

  it("commits a persistent owned child with its admission and marks before dispatch", async () => {
    const handle = await admitBackgroundDispatch(admissionRow())
    expect(await getDb().sessions.get("child-bg-1")).toMatchObject({
      programmaticCreator: "background-task",
      kind: "subagent",
      parentSessionId: "ses_1",
      attachedChild: { lifecycleOwnerSessionId: "ses_1" },
    })
    expect((await getBackgroundTaskRecord("bg_1"))?.recovery?.phase).toBe("accepted")
    await handle.markDispatched()
    expect((await getBackgroundTaskRecord("bg_1"))?.recovery?.phase).toBe("dispatched")
    await handle.journal.recordSettle("bg_1", { status: "done", settledAt: 2, resultText: "saved" })
    expect(await getBackgroundTaskRecord("bg_1")).toMatchObject({
      status: "done",
      resultText: "saved",
    })
  })

  it("fails closed on duplicate admission without overwriting prior evidence", async () => {
    await admitBackgroundDispatch(admissionRow())
    await expect(admitBackgroundDispatch(admissionRow())).rejects.toThrow("already exists")
    expect((await listBackgroundTaskRecords()).length).toBe(1)
  })

  it("claims one replacement atomically and reuses the persistent child", async () => {
    await admitBackgroundDispatch(admissionRow())
    await getDb().backgroundTasks.update("bg_1", {
      interruptedAt: 3000,
      settledAt: 3000,
      ownerLease: expiredLease,
    })
    const outcomes = await Promise.allSettled([
      admitBackgroundDispatch(admissionRow({ runId: "retry-1" }), "bg_1", "accepted"),
      admitBackgroundDispatch(admissionRow({ runId: "retry-2" }), "bg_1", "accepted"),
    ])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect((await getBackgroundTaskRecord("bg_1"))?.resumedByRunId).toMatch(/^retry-/)
    expect(await getDb().sessions.where("parentSessionId").equals("ses_1").count()).toBe(1)
  })

  it("refuses a deleted parent at admission and between commit and execution", async () => {
    await getDb().sessions.delete("ses_1")
    await expect(admitBackgroundDispatch(admissionRow())).rejects.toThrow("parent no longer exists")
    expect(await getDb().sessions.get("child-bg-1")).toBeUndefined()
    await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
    const handle = await admitBackgroundDispatch(admissionRow())
    await getDb().sessions.delete("ses_1")
    await expect(handle.markDispatched()).rejects.toThrow("no longer executable")
  })
})

it("rejects stale accepted recovery proof if dispatch began before boot interruption", async () => {
  await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
  const original = await admitBackgroundDispatch(admissionRow())
  await original.markDispatched()
  await getDb().backgroundTasks.update("bg_1", {
    interruptedAt: 3000,
    settledAt: 3000,
    ownerLease: expiredLease,
  })
  await expect(
    admitBackgroundDispatch(admissionRow({ runId: "retry-stale" }), "bg_1", "accepted")
  ).rejects.toThrow("already claimed or changed")
  expect(await getBackgroundTaskRecord("retry-stale")).toBeUndefined()
  await expect(original.markDispatched()).rejects.toThrow("no longer executable")
})

it("retains durable cancellation across a crash before provider settlement", async () => {
  await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
  const handle = await admitBackgroundDispatch(admissionRow())
  await handle.markDispatched()
  await handle.requestCancel()
  await interruptBackgroundTasksOnBoot({ now: () => Date.now() + BACKGROUND_TASK_LEASE_TTL_MS })
  expect(await getBackgroundTaskRecord("bg_1")).toMatchObject({
    status: "interrupted",
    cancelRequestedAt: expect.any(Number),
  })
  await expect(
    admitBackgroundDispatch(admissionRow({ runId: "cancelled-retry" }), "bg_1", "dispatched")
  ).rejects.toThrow("already claimed or changed")
})

it("enforces the canonical handoff guard at admission and the execution boundary", async () => {
  const db = getDb()
  const parent = { id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 }
  const handoffLock = { ticketId: "handoff", state: "frozen" as const, at: 1 }
  await db.sessions.put({ ...parent, handoffLock })
  await expect(admitBackgroundDispatch(admissionRow())).rejects.toThrow("read-only while handoff")
  expect(await getBackgroundTaskRecord("bg_1")).toBeUndefined()
  await db.sessions.put(parent)
  const handle = await admitBackgroundDispatch(admissionRow())
  await db.sessions.update(parent.id, { handoffLock })
  await expect(handle.markDispatched()).rejects.toThrow("read-only while handoff")
  expect((await getBackgroundTaskRecord("bg_1"))?.recovery?.phase).toBe("accepted")
})

it("commits recoverable parent delivery together with the terminal output", async () => {
  await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
  const handle = await admitBackgroundDispatch(admissionRow())
  await handle.markDispatched()
  await handle.journal.recordSettle("bg_1", {
    status: "done",
    resultText: "persisted result",
    settledAt: 2000,
  })
  // A reload here loses the settle listener, but must still drain the result.
  expect(await getBackgroundTaskRecord("bg_1")).toMatchObject({
    status: "done",
    resultText: "persisted result",
    deliveryState: "pending",
  })
})

it("reconciles a running row only once across overlapping boot passes", async () => {
  await getDb().backgroundTasks.put(row({ ownerLease: expiredLease }))
  const reconciled = await Promise.all([
    interruptBackgroundTasksOnBoot(),
    interruptBackgroundTasksOnBoot(),
  ])
  expect(reconciled.flat()).toHaveLength(1)
})

it("keeps versioned interrupted recovery discoverable after a crash during boot", async () => {
  await getDb().backgroundTasks.bulkPut([
    admissionRow({ status: "interrupted", settledAt: 2000, ownerLease: expiredLease }),
    row({ runId: "legacy", status: "interrupted" }),
    admissionRow({ runId: "claimed", status: "interrupted", resumedByRunId: "next" }),
    admissionRow({ runId: "cancelled", status: "interrupted", cancelRequestedAt: 2000 }),
  ])
  const recovered = await interruptBackgroundTasksOnBoot({ recoverInterrupted: true })
  expect(recovered.map((item) => item.runId)).toEqual(["bg_1"])
  expect(recovered[0].settledAt).toBe(2000)
})

it("reserves one stable delivery batch across reload and later completions", async () => {
  const db = getDb()
  await db.backgroundTasks.put(row({ runId: "a", status: "done", deliveryState: "pending" }))
  expect(await reserveBackgroundTaskDelivery("ses_1", ["a"], "delivery-a")).toEqual({
    deliveryId: "delivery-a",
    runIds: ["a"],
  })
  await db.backgroundTasks.put(row({ runId: "b", status: "done", deliveryState: "pending" }))
  expect(await reserveBackgroundTaskDelivery("ses_1", ["a", "b"], "delivery-ab")).toEqual({
    deliveryId: "delivery-a",
    runIds: ["a"],
  })
  await db.backgroundTasks.update("a", { deliveryState: "delivered" })
  expect(await reserveBackgroundTaskDelivery("ses_1", ["a", "b"], "delivery-b")).toEqual({
    deliveryId: "delivery-b",
    runIds: ["b"],
  })
  expect(await reserveBackgroundTaskDelivery("wrong-session", ["b"], "wrong")).toBeNull()
})

it("finds the same unclaimed interrupted admission on the next boot", async () => {
  await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
  await admitBackgroundDispatch(admissionRow(), undefined, undefined, { now: () => 0 })
  const first = await interruptBackgroundTasksOnBoot({ recoverInterrupted: true })
  const second = await interruptBackgroundTasksOnBoot({ recoverInterrupted: true })
  expect(second).toEqual(first)
  await admitBackgroundDispatch(admissionRow({ runId: "resumed" }), second[0].runId, "accepted")
  const third = await interruptBackgroundTasksOnBoot({
    recoverInterrupted: true,
    isLive: (runId) => runId === "resumed",
  })
  expect(third).toEqual([])
})

describe("renderer owner leases", () => {
  it("preserves another window's live work and renews through the same ownership", async () => {
    let at = 1000
    const owner = createDexieBackgroundTaskJournal({ ownerId: "window-a", now: () => at })
    const other = createDexieBackgroundTaskJournal({ ownerId: "window-b", now: () => at })
    await owner.recordStart(started())
    expect(await interruptBackgroundTasksOnBoot({ now: () => at })).toEqual([])
    expect(await other.renewLease("bg_1")).toBe(false)
    await expect(other.recordSettle("bg_1", { status: "done" })).rejects.toThrow("ownership")
    at += BACKGROUND_TASK_LEASE_TTL_MS - 1
    expect(await owner.renewLease("bg_1")).toBe(true)
    const deadline = at + BACKGROUND_TASK_LEASE_TTL_MS
    expect((await getBackgroundTaskRecord("bg_1"))?.ownerLease).toEqual({
      ownerId: "window-a",
      epoch: 1,
      expiresAt: deadline,
    })
    at = deadline
    expect(await owner.renewLease("bg_1")).toBe(false)
    await expect(owner.recordSettle("bg_1", { status: "done" })).rejects.toThrow("ownership")
    expect(await interruptBackgroundTasksOnBoot({ now: () => at })).toHaveLength(1)
  })

  it("parks legacy rows without treating absence of a lease as proof of death", async () => {
    await getDb().backgroundTasks.bulkPut([
      admissionRow(),
      admissionRow({ runId: "legacy-interrupted", status: "interrupted" }),
    ])
    expect(await interruptBackgroundTasksOnBoot({ recoverInterrupted: true })).toEqual([])
    expect(await getBackgroundTaskRecord("bg_1")).toMatchObject({
      status: "interrupted",
      error: "Background task ownership is unknown; automatic recovery is unavailable.",
    })
    expect(await interruptBackgroundTasksOnBoot({ recoverInterrupted: true })).toEqual([])
  })

  it("fences a late owner from a recovered child and advances the epoch atomically", async () => {
    let at = 1000
    await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
    const old = await admitBackgroundDispatch(admissionRow(), undefined, undefined, {
      ownerId: "window-a",
      now: () => at,
    })
    at += BACKGROUND_TASK_LEASE_TTL_MS
    await interruptBackgroundTasksOnBoot({ now: () => at })
    const results = await Promise.allSettled(
      ["window-b", "window-c"].map((ownerId) =>
        admitBackgroundDispatch(admissionRow({ runId: ownerId }), "bg_1", "accepted", {
          ownerId,
          now: () => at,
        })
      )
    )
    const winner = results.find((result) => result.status === "fulfilled")
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    if (winner?.status !== "fulfilled") throw new Error("Missing winning admission")
    const runId = (await getBackgroundTaskRecord("bg_1"))!.resumedByRunId!
    expect((await getBackgroundTaskRecord(runId))?.ownerLease?.epoch).toBe(2)
    await winner.value.markDispatched()
    const child = await getDb().sessions.get("child-bg-1")
    await expect(old.journal.recordSettle("bg_1", { status: "done" })).rejects.toThrow(
      "no longer active"
    )
    await expect(old.journal.recordSettle(runId, { status: "done" })).rejects.toThrow(
      "no longer active"
    )
    await expect(old.requestCancel()).rejects.toThrow("no longer active")
    await expect(old.markDispatched()).rejects.toThrow("no longer executable")
    expect(await old.renewLease()).toBe(false)
    expect(await getDb().sessions.get("child-bg-1")).toEqual(child)
    await winner.value.journal.recordSettle(runId, { status: "done", resultText: "new owner" })
    expect((await getBackgroundTaskRecord(runId))?.resultText).toBe("new owner")
  })

  it("does not revive an expired lease, even before another owner claims it", async () => {
    let at = 1000
    await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
    const handle = await admitBackgroundDispatch(admissionRow(), undefined, undefined, {
      ownerId: "window-a",
      now: () => at,
    })
    at += BACKGROUND_TASK_LEASE_TTL_MS
    expect(await handle.renewLease()).toBe(false)
    await expect(handle.markDispatched()).rejects.toThrow("no longer executable")
    await expect(handle.requestCancel()).rejects.toThrow("no longer active")
    await expect(handle.journal.recordSettle("bg_1", { status: "done" })).rejects.toThrow(
      "no longer active"
    )
    expect((await getBackgroundTaskRecord("bg_1"))?.status).toBe("running")
  })

  it("stops renewal after cancellation but accepts the owner's terminal cancellation result", async () => {
    await getDb().sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
    const handle = await admitBackgroundDispatch(admissionRow(), undefined, undefined, {
      ownerId: "window-a",
      now: () => 1000,
    })
    await handle.requestCancel()
    expect(await handle.renewLease()).toBe(false)
    await expect(handle.markDispatched()).rejects.toThrow("no longer executable")
    await handle.journal.recordSettle("bg_1", { status: "error", error: "Cancelled" })
    expect(await getBackgroundTaskRecord("bg_1")).toMatchObject({
      status: "error",
      error: "Cancelled",
      cancelRequestedAt: 1000,
    })
  })

  it("binds writers to the account captured at admission", async () => {
    const db = getDb()
    const generic = createDexieBackgroundTaskJournal({ ownerId: "window-a", now: () => 1000 })
    await generic.recordStart(started({ runId: "generic" }))
    await db.sessions.put({ id: "ses_1", title: "Parent", createdAt: 1, updatedAt: 1 })
    const handle = await admitBackgroundDispatch(admissionRow(), undefined, undefined, {
      ownerId: "window-a",
      now: () => 1000,
    })
    activateAccountDatabase(`owner-lease-test-${crypto.randomUUID()}`)
    const otherDb = getDb()
    try {
      await expect(generic.update("generic", { collectedAt: 1000 })).rejects.toThrow(
        "scope changed"
      )
      expect(await generic.renewLease("generic")).toBe(false)
      expect(await handle.renewLease()).toBe(false)
      await expect(generic.recordSettle("generic", { status: "done" })).rejects.toThrow("ownership")
      await expect(handle.journal.recordSettle("bg_1", { status: "done" })).rejects.toThrow(
        "scope changed"
      )
      await expect(handle.requestCancel()).rejects.toThrow("scope changed")
      await expect(handle.markDispatched()).rejects.toThrow("scope changed")
    } finally {
      await otherDb.delete()
      clearAccountDatabaseSelection()
    }
    // Nothing was settled through the stale scope: every entry is still open.
    expect(
      (await getDb().backgroundTasks.toArray()).every((record) => record.settledAt === undefined)
    ).toBe(true)
  })

  it("rejects the same owner under a newer epoch and prevents unowned execution updates", async () => {
    const owner = createDexieBackgroundTaskJournal({ ownerId: "window-a", now: () => 1000 })
    await owner.recordStart(started())
    await getDb().backgroundTasks.update("bg_1", {
      ownerLease: { ownerId: "window-a", epoch: 2, expiresAt: 100_000 },
    })
    expect(await owner.renewLease("bg_1")).toBe(false)
    await expect(owner.recordSettle("bg_1", { status: "done" })).rejects.toThrow("ownership")
    await expect(owner.update("bg_1", { status: "interrupted" })).rejects.toThrow("ownership")
    expect((await getBackgroundTaskRecord("bg_1"))?.status).toBe("running")
  })

  it("does not let a paused in-memory owner exempt an expired persisted lease", async () => {
    await getDb().backgroundTasks.put(row({ ownerLease: expiredLease }))
    const interrupted = await interruptBackgroundTasksOnBoot({
      now: () => expiredLease.expiresAt,
      isLive: () => true,
    })
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0].status).toBe("interrupted")
  })

  it("keeps a generic cancellation receipt writable after stopping its heartbeat", async () => {
    const owner = createDexieBackgroundTaskJournal({ ownerId: "window-a", now: () => 1000 })
    await owner.recordStart(started())
    await owner.update("bg_1", { cancelRequestedAt: 1000 })
    expect(await owner.renewLease("bg_1")).toBe(false)
    await owner.recordSettle("bg_1", { status: "error", error: "Cancelled" })
    expect((await getBackgroundTaskRecord("bg_1"))?.error).toBe("Cancelled")
  })

  it("does not let unowned helpers overwrite leased execution evidence", async () => {
    const owner = createDexieBackgroundTaskJournal({ ownerId: "window-a", now: () => 1000 })
    await owner.recordStart(started())
    await expect(recordBackgroundTaskStart(row({ status: "done" }))).rejects.toThrow()
    await expect(recordBackgroundTaskSettle("bg_1", { status: "done" })).rejects.toThrow(
      "ownership"
    )
    await expect(updateBackgroundTaskRecord("bg_1", { status: "done" })).rejects.toThrow(
      "ownership"
    )
    expect((await getBackgroundTaskRecord("bg_1"))?.status).toBe("running")
    await owner.recordSettle("bg_1", { status: "done", resultText: "owner result" })
    expect((await getBackgroundTaskRecord("bg_1"))?.resultText).toBe("owner result")
  })
})

describe("shell-job and monitor entries (ADR-0249)", () => {
  const exit = (overrides: Record<string, unknown> = {}) =>
    outboxRecordFromJobExit(
      {
        jobId: "job-1",
        status: "exited",
        exitCode: 0,
        endedAtMs: 5_000,
        startedAtMs: 1_000,
        command: "sleep 5 && echo done",
        outputTail: "done\n",
        delivery: { sessionId: "ses_1", notify: "on_exit" },
        ...overrides,
      },
      "renderer"
    )!
  const monitor = (state: "pending" | "inline") =>
    outboxRecordFromMonitor(
      {
        id: "mon-1",
        status: "fired",
        condition: { kind: "jobExit", jobId: "job-1" },
        createdAtMs: 1_000,
        settledAtMs: 2_000,
        detail: "job job-1 exited",
        delivery: { sessionId: "ses_1", state },
      },
      "renderer"
    )!

  it("writes an end once, whichever report arrives first, and stores its own status", async () => {
    // The exit can land before the agent ever saw the start ACK: the end alone
    // carries the conversation, so the first report writes the settled entry.
    await expect(upsertBackgroundJobSettlement(exit())).resolves.toMatchObject({ kind: "created" })
    await expect(upsertBackgroundJobSettlement(exit())).resolves.toMatchObject({ kind: "known" })
    const stored = await getDb().backgroundTasks.get("shell-job:job-1")
    expect(stored).toMatchObject({ status: "done", deliveryState: "pending", settledAt: 5_000 })
    await expect(getBackgroundTaskRecord("shell-job:job-1")).resolves.toMatchObject({
      status: "done",
      job: { kind: "shell-job", exitCode: 0 },
    })
  })

  it("lets a monitor end move to skipped once the blocking call returned it inline", async () => {
    await upsertBackgroundJobSettlement(monitor("pending"))
    await expect(upsertBackgroundJobSettlement(monitor("inline"))).resolves.toMatchObject({
      record: { deliveryState: "skipped" },
    })
    // A claimed batch is never taken back.
    await getDb().backgroundTasks.clear()
    await upsertBackgroundJobSettlement(monitor("pending"))
    await reserveBackgroundTaskDelivery("ses_1", ["monitor:mon-1"], "delivery-1")
    await expect(upsertBackgroundJobSettlement(monitor("inline"))).resolves.toMatchObject({
      record: { deliveryState: "pending", deliveryId: "delivery-1" },
    })
  })

  it("reserves job entries in the same delivery batches as run results", async () => {
    await upsertBackgroundJobSettlement(exit())
    await getDb().backgroundTasks.put(row({ runId: "a", status: "done", deliveryState: "pending" }))
    await expect(
      reserveBackgroundTaskDelivery("ses_1", ["a", "shell-job:job-1"], "delivery-1")
    ).resolves.toEqual({ deliveryId: "delivery-1", runIds: ["a", "shell-job:job-1"] })
  })

  it("refuses an entry that is not a job's", async () => {
    await expect(upsertBackgroundJobSettlement(started())).rejects.toThrow(
      /Not a settled outbox entry/
    )
  })

  it("keeps job entries inside the reconciliation window when pruning", async () => {
    const now = 30 * 24 * 60 * 60 * 1000
    await upsertBackgroundJobSettlement(exit({ endedAtMs: now - 1_000, startedAtMs: now - 2_000 }))
    await upsertBackgroundJobSettlement(
      exit({ jobId: "job-old", endedAtMs: now - JOB_RECONCILE_WINDOW_MS - 1, startedAtMs: 0 })
    )
    await expect(pruneBackgroundTaskRecords({ now, maxAgeMs: 1, maxItems: 0 })).resolves.toBe(1)
    expect((await listBackgroundTaskRecords()).map((record) => record.runId)).toEqual([
      "shell-job:job-1",
    ])
  })
})

describe("squad-handoff entries (ADR-0252 §4)", () => {
  const handoff = (squadRunId: string, settledAt: number) =>
    squadHandoffOutboxRecord({
      roomId: "room-1",
      brief: "Write a hello script",
      startedAt: settledAt - 1_000,
      settledAt,
      resultText: "hello.sh written",
      facts: {
        proposerId: "ava",
        toolUseId: "tu-1",
        squadId: "sq-1",
        squadName: "Builders",
        delegationRunId: "execution:delegation:room-handoff:tu-1",
        squadRunId,
        outcome: "completed",
      },
    })

  it("writes an attempt's end once, keeps its own status, and reserves it for delivery", async () => {
    await expect(
      upsertBackgroundJobSettlement(handoff("execution:team:r1", 5_000))
    ).resolves.toMatchObject({ kind: "created" })
    await expect(
      upsertBackgroundJobSettlement(handoff("execution:team:r1", 6_000))
    ).resolves.toMatchObject({ kind: "known", record: { settledAt: 5_000 } })
    // No `execution:job:` row stands behind it: the entry's status is its own.
    await expect(getBackgroundTaskRecord("squad-handoff:execution:team:r1")).resolves.toMatchObject(
      {
        status: "done",
        squadHandoff: { proposerId: "ava" },
      }
    )
    await expect(
      reserveBackgroundTaskDelivery("room-1", ["squad-handoff:execution:team:r1"], "delivery-1")
    ).resolves.toEqual({ deliveryId: "delivery-1", runIds: ["squad-handoff:execution:team:r1"] })
  })

  it("keeps entries inside the hand-off window when pruning, so reconciliation never writes one twice", async () => {
    const now = 40 * 24 * 60 * 60 * 1000
    await upsertBackgroundJobSettlement(
      handoff("execution:team:recent", now - JOB_RECONCILE_WINDOW_MS - 1)
    )
    await upsertBackgroundJobSettlement(
      handoff("execution:team:old", now - SQUAD_HANDOFF_RECONCILE_WINDOW_MS - 1)
    )
    await expect(pruneBackgroundTaskRecords({ now, maxAgeMs: 1, maxItems: 0 })).resolves.toBe(1)
    expect((await listBackgroundTaskRecords()).map((record) => record.runId)).toEqual([
      "squad-handoff:execution:team:recent",
    ])
  })

  it("is never flipped to interrupted at boot", async () => {
    await upsertBackgroundJobSettlement(handoff("execution:team:r1", 5_000))
    await interruptBackgroundTasksOnBoot({ host: "renderer" })
    await expect(getBackgroundTaskRecord("squad-handoff:execution:team:r1")).resolves.toMatchObject(
      {
        status: "done",
      }
    )
  })
})
