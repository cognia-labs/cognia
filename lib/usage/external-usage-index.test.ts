// The orchestrator's job is to be conservative with data it did not fully see.
// Most of these tests are about the deletion gate and the freshness TTL.

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  getUsageSourceState,
  putUsageSourceState,
  emptyUsageSourceState,
  USAGE_SCAN_PARSER_VERSION,
} from "@/lib/db/usage-source-states"
import {
  __resetDynamicSessionSourcesForTesting,
  registerSessionSource,
} from "@/lib/session-import/registry"
import type {
  AgentSessionSourceAdapter,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "@/lib/session-import/types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  coverageOf,
  describeUsageSources,
  listExternalUsageRows,
  persistScanRows,
  refreshExternalUsageIndex,
  scanDue,
  scanOneSource,
  USAGE_SCAN_TTL_MS,
} from "./external-usage-index"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetDynamicSessionSourcesForTesting()
})
afterAll(dbFixture.dispose)

const NOW = 1_800_000_000_000

const input: SessionScanInput = {
  fs: {
    exists: async () => true,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  },
  home: "/home/u",
}

function summary(id: string, at: number): SessionSummary {
  return {
    ref: { sourceId: "plug:fake", originalSessionId: id, locator: `/x/${id}` },
    title: "t",
    sourceId: "plug:fake",
    messageCount: 1,
    updatedAt: at,
  }
}

function adapter(
  sessions: SessionSummary[],
  over: Partial<AgentSessionSourceAdapter> = {}
): AgentSessionSourceAdapter {
  return {
    id: "fake",
    displayName: "Fake",
    labelKey: "fake",
    acceptedExtensions: [".jsonl"],
    scanRoots: () => ["/x"],
    detect: () => "no",
    listSessions: async () => sessions,
    parseSession: async (ref: SessionRef) =>
      ({
        session: { id: "s", model: "gpt-x" },
        messages: [
          {
            id: `${ref.originalSessionId}-1`,
            role: "assistant",
            createdAt: NOW,
            metadata: { usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.5 } },
          },
        ],
      }) as never,
    ...over,
  }
}

function externalRow(over: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: "ext:plug:fake:s1:m1",
    sessionId: "ext:plug:fake:s1",
    at: NOW,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 1,
    durationMs: 0,
    surface: "imported",
    imported: true,
    sourceId: "plug:fake",
    ...over,
  }
}

describe("scanDue", () => {
  it("is due when nothing has been scanned", () => {
    expect(scanDue(null, NOW)).toBe(true)
  })

  it("is not due for a fresh source inside its TTL", () => {
    const state = { ...emptyUsageSourceState("x"), status: "fresh" as const, lastScanAt: NOW }
    expect(scanDue(state, NOW + 1000)).toBe(false)
  })

  it("is due again once the TTL elapses", () => {
    const state = { ...emptyUsageSourceState("x"), status: "fresh" as const, lastScanAt: NOW }
    expect(scanDue(state, NOW + USAGE_SCAN_TTL_MS)).toBe(true)
  })

  it("always retries a degraded source", () => {
    const state = { ...emptyUsageSourceState("x"), status: "partial" as const, lastScanAt: NOW }
    expect(scanDue(state, NOW + 1)).toBe(true)
  })

  it("restarts a source parsed by an older parser", () => {
    const state = {
      ...emptyUsageSourceState("x"),
      status: "fresh" as const,
      lastScanAt: NOW,
      parserVersion: USAGE_SCAN_PARSER_VERSION - 1,
    }
    expect(scanDue(state, NOW + 1)).toBe(true)
  })

  it("honours force", () => {
    const state = { ...emptyUsageSourceState("x"), status: "fresh" as const, lastScanAt: NOW }
    expect(scanDue(state, NOW, true)).toBe(true)
  })
})

describe("persistScanRows", () => {
  const row = (session: string, id: string, sourceId = "plug:fake") =>
    externalRow({
      messageId: `ext:${sourceId}:${session}:${id}`,
      sessionId: `ext:${sourceId}:${session}`,
      sourceId,
      sourceSessionId: session,
    })

  it("writes rows and reports the count", async () => {
    const res = await persistScanRows("plug:fake", [row("s1", "m1")], { parsedSessions: ["s1"] })
    expect(res.written).toBe(1)
    expect(await getDb().sessionUsage.count()).toBe(1)
  })

  it("replaces exactly the sessions it read, and keeps every other session's rows (F05)", async () => {
    await persistScanRows("plug:fake", [row("s1", "old"), row("s2", "kept")], {
      parsedSessions: ["s1", "s2"],
    })
    // s1 was read again and no longer has "old"; s2 was not read this time.
    const res = await persistScanRows("plug:fake", [row("s1", "new")], { parsedSessions: ["s1"] })
    expect(res.removed).toBe(1)
    expect((await getDb().sessionUsage.toArray()).map((r) => r.messageId).sort()).toEqual([
      "ext:plug:fake:s1:new",
      "ext:plug:fake:s2:kept",
    ])
  })

  it("retires a session confirmed gone", async () => {
    await persistScanRows("plug:fake", [row("s1", "m1"), row("s2", "m1")], {
      parsedSessions: ["s1", "s2"],
    })
    await persistScanRows("plug:fake", [], { parsedSessions: [], goneSessions: ["s2"] })
    expect((await getDb().sessionUsage.toArray()).map((r) => r.sourceSessionId)).toEqual(["s1"])
  })

  it("never touches another source's rows", async () => {
    await persistScanRows("other", [row("s1", "o1", "other")], { parsedSessions: ["s1"] })
    await persistScanRows("plug:fake", [], { parsedSessions: ["s1"], goneSessions: ["s1"] })
    expect(await getDb().sessionUsage.count()).toBe(1)
  })

  it("keeps external spend out of the budget projection entirely", async () => {
    await persistScanRows("plug:fake", [row("s1", "m1")], { parsedSessions: ["s1"] })
    expect(await getDb().providerCostDaily.count()).toBe(0)
  })
})

describe("coverageOf", () => {
  it("reports the oldest and newest turn", () => {
    expect(coverageOf([externalRow({ at: 5 }), externalRow({ at: 9 })])).toEqual({
      from: 5,
      to: 9,
    })
  })

  it("is empty for no rows", () => {
    expect(coverageOf([])).toEqual({ from: null, to: null })
  })
})

describe("scanOneSource", () => {
  it("indexes a source and marks it fresh", async () => {
    const res = await scanOneSource(adapter([summary("s1", NOW)]), input, { now: NOW })
    expect(res).toMatchObject({ status: "fresh", complete: true, parsed: 1, failed: 0 })
    const state = await getUsageSourceState("fake")
    expect(state?.status).toBe("fresh")
    expect(state?.rowCount).toBe(1)
    expect(state?.lastSuccessAt).toBe(NOW)
  })

  it("skips a fresh source inside its TTL without re-reading", async () => {
    const listSessions = jest.fn(async () => [summary("s1", NOW)])
    await putUsageSourceState({
      ...emptyUsageSourceState("fake"),
      status: "fresh",
      lastScanAt: NOW,
    })
    const res = await scanOneSource(adapter([], { listSessions }), input, { now: NOW })
    expect(res.skipped).toBe("fresh")
    expect(listSessions).not.toHaveBeenCalled()
  })

  it("records a picker-only source as such and reads nothing", async () => {
    const listSessions = jest.fn(async () => [])
    const res = await scanOneSource(adapter([], { pickerOnly: true, listSessions }), input, {
      now: NOW,
    })
    expect(res.skipped).toBe("picker-only")
    expect(listSessions).not.toHaveBeenCalled()
    expect((await getUsageSourceState("fake"))?.status).toBe("picker-only")
  })

  it("marks an unreadable source unavailable and keeps the rows it already had", async () => {
    await persistScanRows("fake", [externalRow({ sourceId: "fake", sourceSessionId: "s1" })], {
      parsedSessions: ["s1"],
    })
    const res = await scanOneSource(
      adapter([], {
        listSessions: async () => {
          throw new Error("ENOENT")
        },
      }),
      input,
      { now: NOW }
    )
    expect(res.status).toBe("unavailable")
    expect(res.complete).toBe(false)
    expect(await getDb().sessionUsage.count()).toBe(1)
  })

  it("marks a source with a corrupt transcript partial rather than fresh", async () => {
    const res = await scanOneSource(
      adapter([summary("s1", NOW), summary("s2", NOW - 1)], {
        parseSession: async (ref: SessionRef) => {
          if (ref.originalSessionId === "s1") throw new Error("corrupt")
          return {
            session: { id: "s", model: "m" },
            messages: [
              {
                id: "s2-1",
                role: "assistant",
                createdAt: NOW,
                metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
              },
            ],
          } as never
        },
      }),
      input,
      { now: NOW }
    )
    expect(res.status).toBe("partial")
    expect(res.failed).toBe(1)
    expect((await getUsageSourceState("fake"))?.degradedReason).toBe("read-failed")
  })

  it("does not prune when a bound stopped the run short", async () => {
    await persistScanRows(
      "fake",
      [externalRow({ messageId: "stale", sourceId: "fake", sourceSessionId: "old" })],
      { parsedSessions: ["old"] }
    )
    const res = await scanOneSource(adapter([summary("s1", NOW)]), input, {
      now: NOW,
      query: { maxSessions: 0 },
    })
    expect(res.complete).toBe(false)
    expect(await getDb().sessionUsage.get("stale")).toBeDefined()
  })
})

describe("scanOneSource retirement (F05)", () => {
  /** An adapter whose parse of `failing` sessions throws. */
  const scanning = (ids: string[], failing: string[] = []) =>
    adapter(
      ids.map((id) => summary(id, NOW)),
      {
        parseSession: async (ref: SessionRef) => {
          if (failing.includes(ref.originalSessionId)) throw new Error("locked")
          return {
            session: { id: "s", model: "gpt-x" },
            messages: [
              {
                id: `${ref.originalSessionId}-1`,
                role: "assistant",
                createdAt: NOW,
                metadata: { usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.5 } },
              },
            ],
          } as never
        },
      }
    )
  const sessions = async () =>
    [...new Set((await getDb().sessionUsage.toArray()).map((r) => r.sourceSessionId))].sort()
  const forced = { now: NOW, force: true }

  it("keeps a session whose transcript failed to parse this time", async () => {
    await scanOneSource(scanning(["s1"]), input, forced)
    const res = await scanOneSource(scanning(["s1"], ["s1"]), input, forced)
    expect(res.status).toBe("partial")
    expect(await sessions()).toEqual(["s1"])
  })

  it("keeps everything when the source lists nothing (root not visible)", async () => {
    await scanOneSource(scanning(["s1", "s2"]), input, forced)
    const res = await scanOneSource(scanning([]), input, forced)
    expect(res.status).toBe("unavailable")
    expect(await sessions()).toEqual(["s1", "s2"])
    expect((await getUsageSourceState("fake"))?.degradedReason).toBe("root-missing")
  })

  it("retires a vanished session only when two listings in a row miss it", async () => {
    await scanOneSource(scanning(["s1", "s2"]), input, forced)
    await scanOneSource(scanning(["s1"]), input, forced)
    // One absence can be a file that was briefly unreadable.
    expect(await sessions()).toEqual(["s1", "s2"])
    expect((await getUsageSourceState("fake"))?.absentSessions).toEqual(["s2"])
    // Back again: no longer pending.
    await scanOneSource(scanning(["s1", "s2"]), input, forced)
    expect((await getUsageSourceState("fake"))?.absentSessions).toEqual([])
    await scanOneSource(scanning(["s1"]), input, forced)
    await scanOneSource(scanning(["s1"]), input, forced)
    expect(await sessions()).toEqual(["s1"])
  })

  it("never retires history outside a narrowed query window", async () => {
    const old = { ...summary("old", NOW - 10 * 86_400_000) }
    const wide = adapter([summary("s1", NOW), old])
    await scanOneSource(wide, input, forced)
    const narrow = { ...forced, query: { sinceMs: NOW - 86_400_000 } }
    await scanOneSource(wide, input, narrow)
    await scanOneSource(wide, input, narrow)
    expect(await sessions()).toEqual(["old", "s1"])
  })

  it("resumes across refreshes without dropping what an earlier refresh read", async () => {
    const many = Array.from({ length: 5 }, (_, i) => `s${i}`)
    // One session per batch and the batch ceiling cut each refresh short.
    const query = { maxSessions: 1 }
    for (let i = 0; i < 6; i++) await scanOneSource(scanning(many), input, { ...forced, query })
    expect(await sessions()).toEqual(many)
  })

  it("writes neither rows nor source state into an account that became active mid-scan (F27)", async () => {
    const { activateAccountDatabase } = await import("@/lib/db/schema")
    let release!: () => void
    const parked = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const atParse = new Promise<void>((resolve) => (reached = resolve))
    const slow = adapter([summary("s1", NOW)], {
      parseSession: async () => {
        reached()
        await parked
        return {
          session: { id: "s", model: "gpt-x" },
          messages: [
            {
              id: "m",
              role: "assistant",
              createdAt: NOW,
              metadata: { usage: { inputTokens: 1, outputTokens: 1, totalCostUsd: 0.1 } },
            },
          ],
        } as never
      },
    })
    const scan = scanOneSource(slow, input, forced)
    await atParse
    activateAccountDatabase("acct_scan_switch_b", "local")
    try {
      release()
      await expect(scan).rejects.toMatchObject({ name: "UsageLedgerDatabaseChangedError" })
      expect(await getDb().sessionUsage.count()).toBe(0)
      expect(await getDb().usageSourceStates.count()).toBe(0)
    } finally {
      await getDb().delete()
      const { clearAccountDatabaseSelection } = await import("@/lib/db/schema")
      clearAccountDatabaseSelection()
    }
  })
})

describe("refreshExternalUsageIndex", () => {
  it("scans every registered source and reports each one", async () => {
    registerSessionSource(adapter([summary("s1", NOW)], { id: "one" }), { pluginId: "p" })
    registerSessionSource(adapter([summary("s2", NOW)], { id: "two" }), { pluginId: "p" })
    const res = await refreshExternalUsageIndex(input, {
      sourceIds: ["p:one", "p:two"],
      now: NOW,
    })
    expect(res.sources.map((s) => s.sourceId)).toEqual(["p:one", "p:two"])
    expect(res.sources.every((s) => s.status === "fresh")).toBe(true)
  })

  it("keeps going when one source throws outright", async () => {
    registerSessionSource(
      adapter([], {
        id: "boom",
        listSessions: async () => {
          throw new Error("nope")
        },
        parseSession: async () => {
          throw new Error("nope")
        },
      }),
      { pluginId: "p" }
    )
    registerSessionSource(adapter([summary("s1", NOW)], { id: "ok" }), { pluginId: "p" })
    const res = await refreshExternalUsageIndex(input, {
      sourceIds: ["p:boom", "p:ok"],
      now: NOW,
    })
    expect(res.sources.find((s) => s.sourceId === "p:ok")?.status).toBe("fresh")
    expect(res.sources.find((s) => s.sourceId === "p:boom")?.status).toBe("unavailable")
  })

  it("does nothing when the id filter matches no source", async () => {
    const res = await refreshExternalUsageIndex(input, { sourceIds: ["nope"], now: NOW })
    expect(res.sources).toEqual([])
  })
})

describe("listExternalUsageRows", () => {
  it("returns only external rows, newest first", async () => {
    await getDb().sessionUsage.bulkPut([
      externalRow({ messageId: "e1", at: NOW - 10 }),
      externalRow({ messageId: "e2", at: NOW }),
      externalRow({ messageId: "local", sourceId: undefined, imported: false }),
    ])
    const rows = await listExternalUsageRows()
    expect(rows.map((r) => r.messageId)).toEqual(["e2", "e1"])
  })

  it("honours the since filter", async () => {
    await getDb().sessionUsage.bulkPut([
      externalRow({ messageId: "old", at: NOW - 10_000 }),
      externalRow({ messageId: "new", at: NOW }),
    ])
    expect((await listExternalUsageRows({ sinceMs: NOW - 5 })).map((r) => r.messageId)).toEqual([
      "new",
    ])
  })

  it("honours the source filter", async () => {
    await getDb().sessionUsage.bulkPut([
      externalRow({ messageId: "a", sourceId: "codex" }),
      externalRow({ messageId: "b", sourceId: "cursor" }),
    ])
    expect((await listExternalUsageRows({ sourceIds: ["codex"] })).map((r) => r.messageId)).toEqual(
      ["a"]
    )
  })
})

describe("describeUsageSources", () => {
  it("reports every registered source, scanned or not", async () => {
    const described = await describeUsageSources()
    // The eleven first-party sources are always listed, so a source that has
    // never been scanned still gets a row saying so.
    expect(described.length).toBeGreaterThanOrEqual(11)
    expect(described.every((d) => typeof d.displayName === "string")).toBe(true)
    expect(described.some((d) => d.supportsScan === false)).toBe(true)
  })
})
