/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "@/lib/db/schema"

import {
  createUsageWriteOutbox,
  dexieUsageWriteOutboxStore,
  USAGE_OUTBOX_HELD_RETRY_MS,
  type UsageWriteOutboxRow,
  type UsageWriteOutboxStore,
} from "./usage-write-outbox"

function row(messageId: string, costUsd = 0): SessionUsageRow {
  return {
    messageId,
    sessionId: "s1",
    at: 1,
    inputTokens: 16_500,
    outputTokens: 120,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    durationMs: 0,
    surface: "chat",
  }
}

function harness(
  options: {
    failCommits?: number
    storeFails?: boolean
    /** Called before each commit; may throw to fail it. */
    beforeCommit?: (usage: SessionUsageRow) => Promise<void> | void
  } = {}
) {
  let now = 1_000
  let commitFailures = options.failCommits ?? 0
  const committed: string[] = []
  /** The figure each id ends up with, in commit order. */
  const ledger = new Map<string, number>()
  const kept = new Map<string, UsageWriteOutboxRow>()
  let storeFails = options.storeFails ?? false
  const timers: Array<{ at: number; callback: () => void; cleared: boolean }> = []
  const logs: Array<[string, string]> = []
  const store: UsageWriteOutboxStore = {
    put: async (record) => {
      if (storeFails) throw new Error("store closed")
      kept.set(record.id, record)
    },
    get: async (id) => kept.get(id),
    delete: async (id) => void kept.delete(id),
    due: async (at) =>
      [...kept.values()].filter((r) => r.state === "pending" && r.nextAttemptAt <= at),
    all: async () => [...kept.values()],
    nextPendingAt: async () => {
      const pending = [...kept.values()].filter((r) => r.state === "pending")
      return pending.length ? Math.min(...pending.map((r) => r.nextAttemptAt)) : undefined
    },
  }
  const outbox = createUsageWriteOutbox({
    commit: async (usage) => {
      await options.beforeCommit?.(usage)
      if (commitFailures > 0) {
        commitFailures -= 1
        throw new Error("DatabaseClosedError")
      }
      committed.push(usage.messageId)
      ledger.set(usage.messageId, usage.costUsd)
    },
    store,
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    log: (level, message) => logs.push([level, message]),
  })
  /** Advance the clock and fire every timer due by then. */
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => !t.cleared && t.at <= now)) {
      timer.cleared = true
      timer.callback()
    }
    // Let the drain the timer started run to completion.
    await outbox.drain()
  }
  return {
    outbox,
    committed,
    ledger,
    kept,
    logs,
    timers,
    advance,
    failNext: (count: number) => {
      commitFailures = count
    },
    setStoreFails: (fails: boolean) => {
      storeFails = fails
    },
  }
}

describe("usage write outbox (ADR-0253 §10)", () => {
  it("writes a row directly and keeps nothing when the write succeeds", async () => {
    const h = harness()
    await h.outbox.book(row("m1"))
    expect(h.committed).toEqual(["m1"])
    expect(h.kept.size).toBe(0)
    expect(h.logs).toEqual([])
  })

  it("keeps a row whose write failed and writes it on the retry", async () => {
    const h = harness({ failCommits: 1 })
    await h.outbox.book(row("m1"))
    expect(h.committed).toEqual([])
    expect(h.kept.get("m1")).toMatchObject({ state: "pending", attempts: 1 })
    expect(h.logs[0]?.[0]).toBe("warn")

    await h.advance(120_000)
    expect(h.committed).toEqual(["m1"])
    expect(h.kept.size).toBe(0)
  })

  it("dead-letters after the retry budget but keeps the row for the next start", async () => {
    const h = harness({ failCommits: 100 })
    await h.outbox.book(row("m1"))
    for (let i = 0; i < 6; i++) await h.advance(120_000)
    expect(h.kept.get("m1")).toMatchObject({ state: "deadlettered" })
    expect(h.logs.some(([level]) => level === "error")).toBe(true)
    // A due-only drain leaves it; a start's full drain writes it.
    h.failNext(0)
    await h.outbox.drain()
    expect(h.committed).toEqual([])
    await h.outbox.drain({ everything: true })
    expect(h.committed).toEqual(["m1"])
    expect(h.kept.size).toBe(0)
  })

  it("holds a row in memory when even the outbox cannot keep it, and retries both", async () => {
    const h = harness({ failCommits: 1, storeFails: true })
    await h.outbox.book(row("m1"))
    expect(h.outbox.heldCount()).toBe(1)
    expect(h.logs[0]).toEqual(["error", expect.stringContaining("retrying in memory")])
    h.setStoreFails(false)
    await h.advance(USAGE_OUTBOX_HELD_RETRY_MS)
    expect(h.committed).toEqual(["m1"])
    expect(h.outbox.heldCount()).toBe(0)
  })

  it("retries what an earlier run kept when it starts", async () => {
    const h = harness()
    h.kept.set("old", {
      id: "old",
      row: row("old"),
      state: "pending",
      attempts: 2,
      nextAttemptAt: 999_999,
      createdAt: 1,
      updatedAt: 1,
    })
    await h.outbox.drain({ everything: true })
    expect(h.committed).toEqual(["old"])
    expect(h.kept.size).toBe(0)
  })

  it("never replays an older version over a newer one written since (F21)", async () => {
    const h = harness({ failCommits: 1 })
    // $0.25 fails and is kept; the corrected $0.75 then writes directly.
    await h.outbox.book(row("m1", 0.25))
    expect(h.kept.get("m1")?.row.costUsd).toBe(0.25)
    await h.outbox.book(row("m1", 0.75))
    expect(h.ledger.get("m1")).toBe(0.75)
    // The direct write retired the kept older version.
    expect(h.kept.size).toBe(0)
    await h.advance(120_000)
    await h.outbox.drain({ everything: true })
    expect(h.ledger.get("m1")).toBe(0.75)
    expect(h.committed).toEqual(["m1"])
  })

  it("skips a kept version a direct write superseded while the drain was reading (F21)", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let firstDirect = true
    const h = harness({
      beforeCommit: async (usage) => {
        // The newer direct write is in flight when the drain reaches the id.
        if (usage.costUsd === 0.75 && firstDirect) {
          firstDirect = false
          await gate
        }
      },
    })
    h.kept.set("m1", {
      id: "m1",
      row: row("m1", 0.25),
      state: "pending",
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const direct = h.outbox.book(row("m1", 0.75))
    const drained = h.outbox.drain({ everything: true })
    release()
    await Promise.all([direct, drained])
    expect(h.ledger.get("m1")).toBe(0.75)
    expect(h.kept.size).toBe(0)
  })

  it("arms the next kept row's retry after an earlier one's timer drains (F21)", async () => {
    const h = harness()
    const kept = (id: string, nextAttemptAt: number) => ({
      id,
      row: row(id),
      state: "pending" as const,
      attempts: 1,
      nextAttemptAt,
      createdAt: 1,
      updatedAt: 1,
    })
    // A is due first, B well after it.
    h.kept.set("a", kept("a", 2_000))
    h.kept.set("b", kept("b", 50_000))
    await h.outbox.drain()
    await h.advance(1_000)
    expect(h.committed).toEqual(["a"])
    // B has a live timer for its own retry; it does not wait for the next start.
    expect(h.timers.some((t) => !t.cleared && t.at === 50_000)).toBe(true)
    await h.advance(48_000)
    expect(h.committed).toEqual(["a", "b"])
  })

  it("keeps nothing in, and replays nothing into, an account that is no longer active (F27)", async () => {
    const foreign = Object.assign(new Error("switched"), {
      name: "UsageLedgerDatabaseChangedError",
    })
    const h = harness({
      beforeCommit: () => {
        throw foreign
      },
    })
    await h.outbox.book(row("m1"))
    // Not parked in whatever table is active now; held for its own account.
    expect(h.kept.size).toBe(0)
    expect(h.outbox.heldCount()).toBe(1)
    h.kept.set("k", {
      id: "k",
      row: row("k"),
      state: "pending",
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await h.outbox.drain({ everything: true })
    // The drain stopped at the switch: the kept row waits, untouched.
    expect(h.kept.get("k")).toMatchObject({ attempts: 1 })
    expect(h.committed).toEqual([])
  })

  it("does nothing once stopped", async () => {
    const h = harness({ failCommits: 1 })
    await h.outbox.book(row("m1"))
    h.outbox.stop()
    await h.advance(120_000)
    expect(h.committed).toEqual([])
    expect(h.kept.get("m1")).toBeDefined()
  })
})

describe("the account database's outbox store", () => {
  beforeEach(async () => {
    activateAccountDatabase("acct_usage_outbox", "local")
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase("acct_usage_outbox", "local")
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("keeps, finds due pending rows only, and clears", async () => {
    const store = dexieUsageWriteOutboxStore(getDb().name)
    const base = { attempts: 1, createdAt: 1, updatedAt: 1 }
    await store.put({ ...base, id: "due", row: row("due"), state: "pending", nextAttemptAt: 10 })
    await store.put({
      ...base,
      id: "later",
      row: row("later"),
      state: "pending",
      nextAttemptAt: 99,
    })
    await store.put({
      ...base,
      id: "dead",
      row: row("dead"),
      state: "deadlettered",
      nextAttemptAt: 1,
    })
    expect((await store.due(50)).map((r) => r.id)).toEqual(["due"])
    expect((await store.all()).map((r) => r.id).sort()).toEqual(["dead", "due", "later"])
    expect(await store.get("later")).toMatchObject({ row: { inputTokens: 16_500 } })
    expect(await store.nextPendingAt()).toBe(10)
    await store.delete("due")
    expect(await store.get("due")).toBeUndefined()
    expect(await store.nextPendingAt()).toBe(99)
  })

  it("never touches another account's table once that account is active (F27)", async () => {
    const store = dexieUsageWriteOutboxStore(getDb().name)
    activateAccountDatabase("acct_usage_outbox_b", "local")
    try {
      await expect(
        store.put({
          id: "x",
          row: row("x"),
          state: "pending",
          attempts: 1,
          nextAttemptAt: 1,
          createdAt: 1,
          updatedAt: 1,
        })
      ).rejects.toMatchObject({ name: "UsageLedgerDatabaseChangedError" })
      expect(await getDb().usageWriteOutbox.count()).toBe(0)
    } finally {
      await getDb().delete()
      __resetDbForTesting()
      activateAccountDatabase("acct_usage_outbox", "local")
    }
  })
})
