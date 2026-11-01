import "fake-indexeddb/auto"

import { decideNextAttempt, MAX_ATTEMPTS } from "@/lib/queue/retry-policy"

import { FusionDB } from "./fusion-db"
import {
  cancelFusionOutboxWake,
  drainFusionOutbox,
  FUSION_OUTBOX_RETRY_POLICY,
  type DrainOptions,
  type OutboxAppliers,
  type OutboxContext,
} from "./outbox"
import type { FusionOutboxRow } from "./types"

let counter = 0
const databases: FusionDB[] = []
function freshDb(): FusionDB {
  const db = new FusionDB(`fusion-outbox-test-${++counter}`)
  databases.push(db)
  return db
}

function effect(
  effectId: string,
  createdAt: number,
  kind: FusionOutboxRow["kind"] = "usage_row"
): FusionOutboxRow {
  return {
    effectId,
    runId: "run-1",
    kind,
    payload: { n: createdAt },
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt,
    nextAttemptAt: createdAt,
    appliedAt: null,
  }
}

describe("drainFusionOutbox", () => {
  let clock: number
  let wakes: Array<{ delayMs: number; fire: () => void; cancel: jest.Mock }>
  let options: DrainOptions
  const success: OutboxAppliers = {
    usage_row: async () => "applied",
    execution_run_milestone: async () => "applied",
    execution_run_projection: async () => "applied",
    session_message: async () => "applied",
  }
  const policy = { baseDelayMs: 15_000, maxDelayMs: 15 * 60_000 }

  beforeEach(() => {
    clock = 1_000
    wakes = []
    options = {
      now: () => clock,
      random: () => 0,
      scheduleWake: (delayMs, fire) => {
        const cancel = jest.fn()
        wakes.push({ delayMs, fire, cancel })
        return cancel
      },
    }
  })

  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
    jest.restoreAllMocks()
  })

  it("applies pending effects in creation order and marks them", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([
      effect("b", 2),
      effect("a", 1),
      effect("c", 3, "execution_run_milestone"),
    ])
    const seen: string[] = []
    const appliers: OutboxAppliers = {
      usage_row: async (row) => {
        seen.push(row.effectId)
        return "applied"
      },
      execution_run_milestone: async (row) => {
        seen.push(row.effectId)
        return "skipped"
      },
      execution_run_projection: async (row) => {
        seen.push(row.effectId)
        return "applied"
      },
      session_message: async () => "applied",
    }
    expect(await drainFusionOutbox(db, appliers, { now: () => 99 })).toEqual({
      applied: 2,
      skipped: 1,
      failed: 0,
    })
    expect(seen).toEqual(["a", "b", "c"])
    expect(await db.fusionOutbox.get("a")).toMatchObject({
      status: "applied",
      attempts: 1,
      appliedAt: 99,
    })
    expect((await db.fusionOutbox.get("c"))?.status).toBe("skipped")
    expect(await drainFusionOutbox(db, appliers)).toEqual({ applied: 0, skipped: 0, failed: 0 })
  })

  it("keeps a failing effect pending with its error and retries it later", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("a", 1))
    let fail = true
    const appliers: OutboxAppliers = {
      usage_row: async () => {
        if (fail) throw new Error("account db closed")
        return "applied"
      },
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async () => "applied",
    }
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(1)
    expect(await db.fusionOutbox.get("a")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "account db closed",
      nextAttemptAt: clock + 15_000,
    })
    fail = false
    expect(await drainFusionOutbox(db, appliers, options)).toEqual({
      applied: 0,
      skipped: 0,
      failed: 0,
    })
    clock += 15_000
    expect((await drainFusionOutbox(db, appliers, options)).applied).toBe(1)
  })

  it("leaves every row untouched and schedules no wake when the target does not match", async () => {
    const db = freshDb()
    const row = effect("a", 1)
    await db.fusionOutbox.add(row)
    const apply = jest.fn(async (_row: FusionOutboxRow) => "applied" as const)
    const targetMatches = jest.fn(() => false)
    expect(
      await drainFusionOutbox(db, { ...success, usage_row: apply }, { ...options, targetMatches })
    ).toEqual({ applied: 0, skipped: 0, failed: 0 })
    expect(targetMatches).toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(await db.fusionOutbox.get(row.effectId)).toEqual(row)
    expect(wakes).toHaveLength(0)
  })

  it("backs off local failures through the cap-th attempt, then dead-letters with a diagnostic", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("poison", 1))
    // HTTP classifier wording must not discard a recoverable local DB error.
    const error = new Error("schema validation failed in account database")
    const apply = jest.fn(async () => {
      throw error
    })
    const appliers = { ...success, usage_row: apply }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts += 1) {
      const expected = decideNextAttempt({
        attempts,
        error,
        nowMs: clock,
        random: () => 0,
        policy: FUSION_OUTBOX_RETRY_POLICY,
        forceRetryable: true,
      })
      expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(1)
      expect(await db.fusionOutbox.get("poison")).toMatchObject({
        ...expected,
        status: expected.status === "deadlettered" ? "deadletter" : "pending",
        ...(expected.status === "deadlettered" ? { deadletteredAt: clock } : {}),
      })
      if (expected.status === "pending") {
        expect(wakes.at(-1)?.delayMs).toBe(expected.nextAttemptAt - clock)
        expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(0)
        clock = expected.nextAttemptAt
      }
    }
    expect(apply).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(FUSION_OUTBOX_RETRY_POLICY).toEqual(policy)
    expect(warn).toHaveBeenCalledWith("[router-fusion] outbox effect dead-lettered", {
      effectId: "poison",
      runId: "run-1",
      kind: "usage_row",
      attempts: MAX_ATTEMPTS,
      lastError: error.message,
    })
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(0)
  })

  it("does not starve a new effect behind 600 failed effects at the same clock", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd(Array.from({ length: 600 }, (_, i) => effect(`poison-${i}`, i)))
    const apply = jest.fn(async (row: FusionOutboxRow) => {
      if (row.effectId !== "new") throw new Error("account db closed")
      return "applied" as const
    })
    const appliers = { ...success, usage_row: apply }
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(500)
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(100)
    expect((await db.fusionOutbox.toArray()).every((row) => row.attempts === 1)).toBe(true)
    await db.fusionOutbox.add(effect("new", clock))
    expect(await drainFusionOutbox(db, appliers, options)).toEqual({
      applied: 1,
      skipped: 0,
      failed: 0,
    })
    expect(apply).toHaveBeenCalledTimes(601)
  })

  it("uses due-time order, includes the due boundary, and respects the batch limit", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([
      { ...effect("old", 1), nextAttemptAt: clock + 1 },
      { ...effect("first", 3), nextAttemptAt: clock - 1 },
      { ...effect("second", 2), nextAttemptAt: clock },
    ])
    const seen: string[] = []
    const appliers = {
      ...success,
      usage_row: async (row: FusionOutboxRow) => {
        seen.push(row.effectId)
        return "applied" as const
      },
    }
    await drainFusionOutbox(db, appliers, { ...options, limit: 1 })
    expect(seen).toEqual(["first"])
    await drainFusionOutbox(db, appliers, options)
    expect(seen).toEqual(["first", "second"])
    expect((await db.fusionOutbox.get("old"))?.attempts).toBe(0)
  })

  it("wakes a due retry with the same artifact reader and no new writes", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("answer", 1, "session_message"))
    const readArtifact = jest.fn(async () => "answer content")
    let retried!: () => void
    const retryObserved = new Promise<void>((resolve) => {
      retried = resolve
    })
    const apply = jest
      .fn()
      .mockRejectedValueOnce(new Error("account db closed"))
      .mockImplementationOnce(async (_row, context) => {
        expect(await context.readArtifact("artifact")).toBe("answer content")
        retried()
        return "applied"
      })
    const appliers = { ...success, session_message: apply }
    const readerOptions = { ...options, readArtifact }
    await drainFusionOutbox(db, appliers, readerOptions)
    expect(wakes).toHaveLength(1)
    const wake = wakes[0]
    clock += wake.delayMs
    wake.fire()
    await retryObserved
    // Join the wake's drain only after observing that it invoked the applier.
    await drainFusionOutbox(db, appliers, readerOptions)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(readArtifact).toHaveBeenCalledWith("artifact")
    expect((await db.fusionOutbox.get("answer"))?.status).toBe("applied")
    expect(wakes).toHaveLength(1)
  })

  it("defers behind an older pending message in the same session, even from another run", async () => {
    const db = freshDb()
    const input = {
      ...effect("input", 1, "session_message"),
      payload: { sessionId: "s1" },
      nextAttemptAt: clock + 15_000,
    }
    const answer = {
      ...effect("answer", 2, "session_message"),
      runId: "run-2",
      payload: { sessionId: "s1" },
    }
    await db.fusionOutbox.bulkAdd([
      input,
      answer,
      { ...effect("other-session", 3, "session_message"), payload: { sessionId: "s2" } },
    ])
    const apply = jest.fn(async (_row: FusionOutboxRow) => "applied" as const)
    const appliers = { ...success, session_message: apply }
    expect(await drainFusionOutbox(db, appliers, options)).toEqual({
      applied: 1,
      skipped: 0,
      failed: 0,
    })
    expect(await db.fusionOutbox.get(answer.effectId)).toEqual({
      ...answer,
      nextAttemptAt: input.nextAttemptAt,
    })
    expect(wakes.map((wake) => wake.delayMs)).toEqual([15_000])

    // A predecessor that exhausted its retries no longer holds up the session.
    await db.fusionOutbox.update(input.effectId, { status: "deadletter", deadletteredAt: clock })
    clock += 15_000
    await drainFusionOutbox(db, appliers, options)
    expect(apply.mock.calls.map(([row]) => row.effectId)).toEqual(["other-session", "answer"])
    expect(wakes).toHaveLength(1)
  })

  it("names the later session messages that proceed once an input dead-letters", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([
      { ...effect("input", 1, "session_message"), payload: { sessionId: "s1" } },
      { ...effect("answer", 2, "session_message"), payload: { sessionId: "s1" } },
      { ...effect("other", 3, "session_message"), payload: { sessionId: "s2" } },
    ])
    await db.fusionOutbox.update("input", { attempts: MAX_ATTEMPTS - 1 })
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const appliers = {
      ...success,
      session_message: jest.fn(async (row: FusionOutboxRow) => {
        if (row.effectId === "input") throw new Error("account database rejected the message")
        return "applied" as const
      }),
    }
    await drainFusionOutbox(db, appliers, options)
    expect((await db.fusionOutbox.get("input"))?.status).toBe("deadletter")
    expect(warn).toHaveBeenCalledWith(
      "[router-fusion] outbox effect dead-lettered",
      expect.objectContaining({
        effectId: "input",
        sessionMessagesProceedingWithoutIt: ["answer"],
      })
    )
  })

  it("does not spin a wake behind a predecessor waiting for an artifact reader", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([
      { ...effect("input", 1, "session_message"), payload: { sessionId: "s1" } },
      { ...effect("answer", 2, "session_message"), payload: { sessionId: "s1" } },
    ])
    const apply = jest.fn(async (_row: FusionOutboxRow, context: OutboxContext) => {
      await context.readArtifact("artifact")
      return "applied" as const
    })
    const appliers = { ...success, session_message: apply }
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect((await db.fusionOutbox.get("answer"))?.attempts).toBe(0)
    expect(wakes).toHaveLength(0)
    await drainFusionOutbox(db, appliers, { ...options, readArtifact: async () => "content" })
    expect(apply.mock.calls.map(([row]) => row.effectId)).toEqual(["input", "input", "answer"])
    expect(wakes).toHaveLength(0)
  })

  it("orders equal-due transcript effects by creation before applying the batch limit", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([
      {
        ...effect("input", 1, "session_message"),
        payload: { sessionId: "s1" },
        nextAttemptAt: clock,
      },
      {
        ...effect("answer", 2, "session_message"),
        payload: { sessionId: "s1" },
        nextAttemptAt: clock,
      },
    ])
    const apply = jest.fn(async (_row: FusionOutboxRow) => "applied" as const)
    const appliers = { ...success, session_message: apply }
    const limited = { ...options, limit: 1 }
    await drainFusionOutbox(db, appliers, limited)
    expect(apply.mock.calls.map(([row]) => row.effectId)).toEqual(["input"])
    expect(wakes.map((wake) => wake.delayMs)).toEqual([0])
    wakes[0].fire()
    await drainFusionOutbox(db, appliers, limited)
    expect(apply.mock.calls.map(([row]) => row.effectId)).toEqual(["input", "answer"])
    expect(wakes).toHaveLength(1)
  })

  it("replaces the database's single wake on a later drain and cancels it on close", async () => {
    const db = freshDb()
    await db.fusionOutbox.add({ ...effect("later", 1), nextAttemptAt: clock + 30_000 })
    await drainFusionOutbox(db, success, options)
    await db.fusionOutbox.add({ ...effect("earlier", 2), nextAttemptAt: clock + 10_000 })
    await drainFusionOutbox(db, success, options)
    expect(wakes.map((wake) => wake.delayMs)).toEqual([30_000, 10_000])
    expect(wakes[0].cancel).toHaveBeenCalledTimes(1)
    // A callback already queued when cancelled cannot resurrect an old drain.
    wakes[0].fire()
    expect(wakes).toHaveLength(2)
    db.close()
    expect(wakes[1].cancel).toHaveBeenCalledTimes(1)
  })

  it("cancels a wake explicitly without affecting another database", async () => {
    const first = freshDb()
    const second = freshDb()
    for (const db of [first, second]) {
      await db.fusionOutbox.add({ ...effect("later", 1), nextAttemptAt: clock + 1 })
      await drainFusionOutbox(db, success, options)
    }
    const where = jest.spyOn(first.fusionOutbox, "where")
    cancelFusionOutboxWake(first)
    cancelFusionOutboxWake(first)
    wakes[0].fire()
    expect(where).not.toHaveBeenCalled()
    expect(wakes[0].cancel).toHaveBeenCalledTimes(1)
    expect(wakes[1].cancel).not.toHaveBeenCalled()
  })

  it("catches and logs a failed wake instead of rejecting without a handler", async () => {
    const db = freshDb()
    await db.fusionOutbox.add({ ...effect("later", 1), nextAttemptAt: clock + 1 })
    await drainFusionOutbox(db, success, options)
    const error = new Error("account switched")
    jest.spyOn(db.fusionOutbox, "where").mockImplementation(() => {
      throw error
    })
    let logged!: () => void
    const observed = new Promise<void>((resolve) => {
      logged = resolve
    })
    const warn = jest.spyOn(console, "warn").mockImplementation(() => logged())
    clock += 1
    wakes[0].fire()
    await observed
    expect(warn).toHaveBeenCalledWith("[router-fusion] outbox wake failed", error)
  })

  it.each(["future_kind", "toString"])(
    "dead-letters unknown kind %s immediately without scheduling retries",
    async (kind) => {
      const db = freshDb()
      await db.fusionOutbox.add(effect("unknown", 1, kind as FusionOutboxRow["kind"]))
      jest.spyOn(console, "warn").mockImplementation(() => {})
      expect((await drainFusionOutbox(db, success, options)).failed).toBe(1)
      expect(await db.fusionOutbox.get("unknown")).toMatchObject({
        status: "deadletter",
        attempts: 1,
        deadletteredAt: clock,
        lastError: `No outbox applier for ${kind}`,
      })
      expect(wakes).toHaveLength(0)
    }
  )

  it("[ACC:ISO-05] yields each effect once across a crash between apply and mark", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("usage:attempt-1", 1))
    // The target of an idempotent applier: keyed by effect, replace-in-place.
    const target = new Map<string, number>()
    const appliers: OutboxAppliers = {
      usage_row: async (row) => {
        target.set(row.effectId, (row.payload as { n: number }).n)
        return "applied"
      },
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async () => "applied",
    }
    // Crash window: the effect lands, the status update does not.
    const update = db.fusionOutbox.update.bind(db.fusionOutbox)
    const spy = jest
      .spyOn(db.fusionOutbox, "update")
      .mockImplementationOnce((() => Promise.reject(new Error("tab closed"))) as never)
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(1)
    spy.mockImplementation(update)
    expect(await db.fusionOutbox.get("usage:attempt-1")).toMatchObject({
      status: "pending",
      lastError: "tab closed",
    })
    // Replay on the next boot.
    clock += 15_000
    await drainFusionOutbox(db, appliers, options)
    expect([...target.entries()]).toEqual([["usage:attempt-1", 1]])
    expect((await db.fusionOutbox.get("usage:attempt-1"))?.status).toBe("applied")
    spy.mockRestore()
  })

  it.each([0, MAX_ATTEMPTS - 1])(
    "waits for an artifact reader without spending attempt %s",
    async (attempts) => {
      const db = freshDb()
      await db.fusionOutbox.add({
        ...effect("session:run-1:answer", 1, "session_message"),
        attempts,
      })
      const read: string[] = []
      const appliers: OutboxAppliers = {
        usage_row: async () => "applied",
        execution_run_milestone: async () => "applied",
        execution_run_projection: async () => "applied",
        session_message: async (_row, context) => {
          const content = await context.readArtifact("answer-artifact")
          read.push(String(content))
          return "applied"
        },
      }
      expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(1)
      expect((await db.fusionOutbox.get("session:run-1:answer"))?.lastError).toContain(
        "no artifact reader"
      )
      expect(await db.fusionOutbox.get("session:run-1:answer")).toMatchObject({
        status: "pending",
        attempts,
        nextAttemptAt: 1,
      })
      // Waking with the same readerless context cannot make progress.
      expect(wakes).toHaveLength(0)

      const drained = await drainFusionOutbox(db, appliers, {
        ...options,
        readArtifact: async (id) => (id === "answer-artifact" ? "the answer" : null),
      })
      expect(drained.applied).toBe(1)
      expect(read).toEqual(["the answer"])
    }
  )

  it("keeps retry wakes working behind 600 effects waiting for an artifact reader", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd(
      Array.from({ length: 600 }, (_, i) => effect(`answer-${i}`, i, "session_message"))
    )
    await db.fusionOutbox.add(effect("usage", 600))
    let retried!: () => void
    const retryObserved = new Promise<void>((resolve) => {
      retried = resolve
    })
    const apply = jest
      .fn()
      .mockRejectedValueOnce(new Error("account db closed"))
      .mockImplementationOnce(async () => {
        retried()
        return "applied"
      })
    const appliers: OutboxAppliers = {
      ...success,
      usage_row: apply,
      session_message: async (_row, context) => {
        await context.readArtifact("answer")
        return "applied"
      },
    }
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(500)
    expect(wakes[0].delayMs).toBe(0)
    expect((await drainFusionOutbox(db, appliers, options)).failed).toBe(101)
    expect(wakes.at(-1)?.delayMs).toBe(15_000)
    clock += 15_000
    wakes.at(-1)!.fire()
    await retryObserved
    await drainFusionOutbox(db, appliers, options)
    expect(apply).toHaveBeenCalledTimes(2)
    const waiting = await db.fusionOutbox.where("status").equals("pending").toArray()
    expect(waiting).toHaveLength(600)
    expect(waiting.every((row) => row.attempts === 0 && row.nextAttemptAt === row.createdAt)).toBe(
      true
    )
    expect(wakes).toHaveLength(2)
    expect(
      (
        await drainFusionOutbox(db, appliers, {
          ...options,
          limit: 600,
          readArtifact: async () => "answer",
        })
      ).applied
    ).toBe(600)
  })

  function transcriptEffect(
    phase: "input" | "answer",
    createdAt: number,
    nextAttemptAt = createdAt
  ): FusionOutboxRow {
    return {
      ...effect(`session:run-same-ms:${phase}`, createdAt, "session_message"),
      payload: { runId: "run-same-ms", sessionId: "session-same-ms", phase },
      nextAttemptAt,
    }
  }

  it("keeps an answer behind its input when both were created in the same millisecond", async () => {
    const db = freshDb()
    // The input failed once and is backing off; the answer shares its createdAt.
    await db.fusionOutbox.bulkAdd([
      { ...transcriptEffect("input", 500, clock + 15_000), attempts: 1 },
      transcriptEffect("answer", 500),
    ])
    const applied: string[] = []
    const appliers = {
      ...success,
      session_message: async (row: FusionOutboxRow) => {
        applied.push(String(row.payload.phase))
        return "applied" as const
      },
    }

    await drainFusionOutbox(db, appliers, options)
    expect(applied).toEqual([])
    expect(await db.fusionOutbox.get("session:run-same-ms:answer")).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: clock + 15_000,
    })

    clock += 15_000
    await drainFusionOutbox(db, appliers, { ...options, limit: 1 })
    await drainFusionOutbox(db, appliers, { ...options, limit: 1 })
    expect(applied).toEqual(["input", "answer"])
  })

  it("leaves an effect pending when the account changed while its applier ran", async () => {
    const db = freshDb()
    await db.fusionOutbox.bulkAdd([effect("first", 1), effect("second", 2)])
    let accountIsCurrent = true
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const appliers = {
      ...success,
      usage_row: async () => {
        // The switch lands while the applier is awaiting the account database.
        accountIsCurrent = false
        return "applied" as const
      },
    }

    const result = await drainFusionOutbox(db, appliers, {
      ...options,
      targetMatches: () => accountIsCurrent,
    })

    expect(result).toEqual({ applied: 0, skipped: 0, failed: 0 })
    expect(await db.fusionOutbox.get("first")).toMatchObject({ status: "pending", attempts: 0 })
    expect(await db.fusionOutbox.get("second")).toMatchObject({ status: "pending", attempts: 0 })
    expect(wakes).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      "[router-fusion] account changed while an outbox effect was applied",
      expect.objectContaining({ effectId: "first" })
    )
  })

  it("joins a drain that is already running instead of applying twice", async () => {
    const db = freshDb()
    await db.fusionOutbox.add(effect("a", 1))
    let calls = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const appliers: OutboxAppliers = {
      usage_row: async () => {
        calls += 1
        await barrier
        return "applied"
      },
      execution_run_milestone: async () => "applied",
      execution_run_projection: async () => "applied",
      session_message: async () => "applied",
    }
    const firstRun = drainFusionOutbox(db, appliers, options)
    const secondRun = drainFusionOutbox(db, appliers, options)
    expect(secondRun).toBe(firstRun)
    release()
    const [first, second] = await Promise.all([firstRun, secondRun])
    expect(calls).toBe(1)
    expect(first).toBe(second)
  })
})
