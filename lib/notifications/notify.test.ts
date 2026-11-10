import * as personalSinkHost from "@/lib/execution/personal-sink"
import { notify, type NotifyDeps, type NotifyDbPort } from "./notify"
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationRecord } from "@/types/notifications"
import { resolvePreferences } from "./preferences"
import { COALESCE_UNTIL_ARCHIVED } from "./dedup"

it("persists only Host-supplied provenance and retains both coalesced producers", async () => {
  const deps = baseDeps()
  const input = {
    source: "scheduler" as const,
    level: "info" as const,
    title: "Result",
    dedupeKey: "task-result",
  }
  await notify(input, deps, { personalContext: { executionRunId: "host-run" } })
  expect(deps.db.rows.get("fixed-id")?.personalContext).toEqual({ executionRunId: "host-run" })
  await notify(
    Object.assign(
      { ...input, body: "replacement", meta: { executionRunId: "forged-input" } },
      {
        personalContext: { executionRunId: "forged-public-input" },
      }
    ),
    deps,
    { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
  )
  expect(deps.db.rows.get("fixed-id")?.personalContext).toEqual({
    personalSources: [{ executionRunId: "host-run" }, { hostOrigin: "fixed-notice" }],
    receiptAttemptId: undefined,
  })
})

it("cannot replace a retained private href/meta's execution with a clean fixed-notice origin", async () => {
  const imDeliver = jest.fn(async () => {})
  const deps = baseDeps({
    imDeliver,
    loadPrefs: () => resolvePreferences({ globalDefaultChannels: ["center", "im"] }),
  })
  const input = {
    source: "scheduler" as const,
    level: "info" as const,
    title: "Result",
    dedupeKey: "run-result",
  }
  await notify(
    { ...input, href: "https://private.test/detail", meta: { private: "old detail" } },
    deps,
    {
      personalContext: { executionRunId: "private-run" },
    }
  )
  await notify({ ...input, title: "Fixed notice" }, deps, {
    personalContext: { hostOrigin: "fixed-notice" },
  })
  expect(imDeliver).toHaveBeenLastCalledWith(
    expect.objectContaining({
      href: "https://private.test/detail",
      meta: { private: "old detail" },
      personalContext: {
        personalSources: [{ executionRunId: "private-run" }, { hostOrigin: "fixed-notice" }],
        receiptAttemptId: undefined,
      },
    })
  )
})

it("projects local surfaces while leaving IM content for its own recipient check", async () => {
  const imDeliver = jest.fn(async () => {})
  const deps = baseDeps({
    imDeliver,
    loadPrefs: () => resolvePreferences({ globalDefaultChannels: ["center", "im"] }),
    projectLocal: async (record) => ({
      ...record,
      title: "Withheld",
      body: "Withheld",
      href: undefined,
      meta: undefined,
    }),
  })
  await notify(
    {
      source: "scheduler",
      level: "info",
      title: "Private title",
      body: "Private body",
      href: "/private",
      meta: { private: true },
    },
    deps,
    {
      personalContext: { executionRunId: "foreign-person-run" },
    }
  )
  expect(deps.db.rows.get("fixed-id")).toMatchObject({
    title: "Withheld",
    body: "Withheld",
    personalContext: { executionRunId: "foreign-person-run" },
  })
  expect(deps.db.rows.get("fixed-id")?.href).toBeUndefined()
  expect(imDeliver).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Private title",
      body: "Private body",
      personalContext: { executionRunId: "foreign-person-run" },
    })
  )
})

/** In-memory db port over a Map. */
function makeDb(): NotifyDbPort & {
  rows: Map<string, NotificationRecord>
  pruneCalls: number
  pruned: string[]
} {
  const rows = new Map<string, NotificationRecord>()
  return {
    rows,
    pruneCalls: 0,
    async findByDedupeKey(key, sinceMs) {
      const hits = [...rows.values()].filter(
        (r) => r.dedupeKey === key && r.updatedAt >= sinceMs && r.readState !== "done"
      )
      return hits.sort((a, b) => b.updatedAt - a.updatedAt)[0]
    },
    async putNotification(rec) {
      rows.set(rec.id, rec)
    },
    async patchNotification(id, patch) {
      const cur = rows.get(id)
      if (cur) rows.set(id, { ...cur, ...patch })
    },
    pruned: [],
    async pruneNotifications() {
      this.pruneCalls += 1
      return this.pruned
    },
  }
}

function baseDeps(over: Partial<NotifyDeps> = {}): NotifyDeps & { db: ReturnType<typeof makeDb> } {
  const db = makeDb()
  return {
    now: () => 10_000,
    loadPrefs: () =>
      resolvePreferences({ globalDefaultChannels: ["center", "toast", "os", "push"] }),
    db,
    newId: () => "fixed-id",
    tz: "UTC",
    ...over,
  } as NotifyDeps & { db: ReturnType<typeof makeDb> }
}

describe("notify — insert", () => {
  it("persists a center record and returns its id", async () => {
    const deps = baseDeps()
    const id = await notify({ source: "system", level: "info", title: "Hi" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(id).toBe("fixed-id")
    const row = deps.db.rows.get("fixed-id")!
    expect(row.title).toBe("Hi")
    expect(row.readState).toBe("unseen")
    expect(row.count).toBe(1)
  })

  it("stamps the V2 fact fields onto the record so it joins delivery intents", async () => {
    const deps = baseDeps()
    await notify(
      {
        source: "agent-team",
        level: "info",
        title: "Run done",
        logicalKey: "run:r1:terminal",
        category: "run.terminal",
        presentation: "full",
        operationKey: "op-123",
        scopeHint: { workspaceId: "ws-1", businessProjectId: "bp-1" },
      },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    const row = deps.db.rows.get("fixed-id")!
    expect(row.logicalKey).toBe("run:r1:terminal")
    expect(row.category).toBe("run.terminal")
    expect(row.presentation).toBe("full")
    expect(row.correlationId).toBe("op-123") // operationKey → correlationId join
    expect(row.scopeKey).toBeTruthy() // the fact's authorization domain is stamped
  })

  it("fans out to toast/os/push and records deliveredVia", async () => {
    const toast = jest.fn()
    const osNotify = jest.fn()
    const push = jest.fn()
    const deps = baseDeps({ toast, osNotify, push })
    await notify(
      { source: "system", level: "warning", title: "T", body: "B", href: "/inbox" },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    expect(toast).toHaveBeenCalledTimes(1)
    expect(osNotify).toHaveBeenCalledWith({ title: "T", body: "B", href: "/inbox" })
    expect(push).toHaveBeenCalledTimes(1)
    expect(deps.db.rows.get("fixed-id")!.deliveredVia.sort()).toEqual([
      "center",
      "os",
      "push",
      "toast",
    ])
  })

  it("fans out to the im channel when requested and records deliveredVia", async () => {
    const imDeliver = jest.fn()
    const deps = baseDeps({ imDeliver })
    await notify(
      {
        source: "connector",
        level: "info",
        title: "Task done",
        channels: ["center", "im"],
        sourceRef: { kind: "conversation", id: "telegram:tg-1:9" },
      },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    expect(imDeliver).toHaveBeenCalledTimes(1)
    expect(deps.db.rows.get("fixed-id")!.deliveredVia).toContain("im")
  })

  it("calls onRecord for the reactive store", async () => {
    const onRecord = jest.fn()
    await notify({ source: "system", level: "info", title: "T" }, baseDeps({ onRecord }), {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(onRecord.mock.calls[0][0].title).toBe("T")
  })

  it("triggers best-effort retention", async () => {
    const deps = baseDeps()
    await notify({ source: "system", level: "info", title: "T" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    await Promise.resolve()
    expect(deps.db.pruneCalls).toBe(1)
  })

  it("hands the rows retention deleted to the store, and stays quiet when none were", async () => {
    const onPruned = jest.fn()
    const quiet = baseDeps({ onPruned })
    await notify({ source: "system", level: "info", title: "T" }, quiet, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onPruned).not.toHaveBeenCalled()
    const deps = baseDeps({ onPruned })
    deps.db.pruned = ["old-1", "old-2"]
    await notify({ source: "system", level: "info", title: "T" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onPruned).toHaveBeenCalledWith(["old-1", "old-2"])
  })

  it("sets expiresAt from ttlMs", async () => {
    const deps = baseDeps()
    await notify({ source: "system", level: "info", title: "T", ttlMs: 5000 }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(deps.db.rows.get("fixed-id")!.expiresAt).toBe(15_000)
  })
})

describe("notify — channel gating", () => {
  it("suppresses OS when permission is denied", async () => {
    const osNotify = jest.fn()
    const deps = baseDeps({ osNotify, isOsPermitted: () => false })
    await notify({ source: "system", level: "warning", title: "T" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(osNotify).not.toHaveBeenCalled()
    expect(deps.db.rows.get("fixed-id")!.deliveredVia).not.toContain("os")
  })

  it("isolates a failing channel from the persist + other channels", async () => {
    const toast = jest.fn(() => {
      throw new Error("toast boom")
    })
    const push = jest.fn()
    const deps = baseDeps({ toast, push })
    const id = await notify({ source: "system", level: "warning", title: "T" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(deps.db.rows.get(id)).toBeDefined()
    expect(push).toHaveBeenCalled()
    expect(deps.db.rows.get(id)!.deliveredVia).not.toContain("toast")
    expect(deps.db.rows.get(id)!.deliveredVia).toContain("push")
  })

  it("DND keeps only center (non-critical)", async () => {
    const toast = jest.fn()
    const osNotify = jest.fn()
    const deps = baseDeps({
      toast,
      osNotify,
      loadPrefs: () =>
        resolvePreferences({
          globalDefaultChannels: ["center", "toast", "os"],
          quietHours: { enabled: true, start: "00:00", end: "23:59" },
        }),
    })
    await notify({ source: "system", level: "warning", title: "T" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(toast).not.toHaveBeenCalled()
    expect(osNotify).not.toHaveBeenCalled()
    expect(deps.db.rows.get("fixed-id")!.deliveredVia).toEqual(["center"])
  })

  it("critical bypasses DND and fires OS", async () => {
    const osNotify = jest.fn()
    const deps = baseDeps({
      osNotify,
      loadPrefs: () =>
        resolvePreferences({
          globalDefaultChannels: ["center"],
          quietHours: { enabled: true, start: "00:00", end: "23:59" },
        }),
    })
    await notify({ source: "agent-team", level: "critical", title: "Approval" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(osNotify).toHaveBeenCalledTimes(1)
  })
})

describe("notify — coalescing", () => {
  it("bumps an existing record within the window instead of inserting", async () => {
    const deps = baseDeps()
    let t = 10_000
    deps.now = () => t
    let n = 0
    deps.newId = () => `id-${n++}`
    await notify(
      { source: "connector", level: "info", title: "msg 1", dedupeKey: "conv:1" },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    t = 15_000
    const second = await notify(
      { source: "connector", level: "info", title: "msg 2", dedupeKey: "conv:1" },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    expect(second).toBe("id-0") // same record
    expect(deps.db.rows.size).toBe(1)
    const row = deps.db.rows.get("id-0")!
    expect(row.count).toBe(2)
    expect(row.title).toBe("msg 2")
    expect(row.readState).toBe("unseen")
  })

  it("inserts a fresh record once the coalesce window lapses", async () => {
    const deps = baseDeps()
    let t = 10_000
    deps.now = () => t
    let n = 0
    deps.newId = () => `id-${n++}`
    await notify({ source: "connector", level: "info", title: "a", dedupeKey: "k" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    t = 10_000 + 60_000 // beyond 45s window
    await notify({ source: "connector", level: "info", title: "b", dedupeKey: "k" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(deps.db.rows.size).toBe(2)
  })

  it("COALESCE_UNTIL_ARCHIVED keeps one updating row for a recurring producer", async () => {
    const deps = baseDeps()
    let t = 10_000
    deps.now = () => t
    let n = 0
    deps.newId = () => `id-${n++}`
    for (let run = 1; run <= 5; run += 1) {
      t = 10_000 + run * 5 * 60_000 // every five minutes, far past 45 s
      await notify(
        {
          source: "scheduler",
          level: "success",
          title: `run ${run}`,
          dedupeKey: "task:t1:complete",
          coalesceWindowMs: COALESCE_UNTIL_ARCHIVED,
        },
        deps,
        { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
      )
      // The user reads it between runs; the next run re-surfaces the SAME row.
      await deps.db.patchNotification("id-0", { readState: "read" })
    }
    expect(deps.db.rows.size).toBe(1)
    expect(deps.db.rows.get("id-0")).toMatchObject({ count: 5, title: "run 5" })
  })

  it("an archived recurring row lets the next occurrence start a fresh one", async () => {
    const deps = baseDeps()
    let n = 0
    deps.newId = () => `id-${n++}`
    const input = {
      source: "scheduler" as const,
      level: "error" as const,
      title: "failed",
      dedupeKey: "task:t1:error",
      coalesceWindowMs: COALESCE_UNTIL_ARCHIVED,
    }
    await notify(input, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    await deps.db.patchNotification("id-0", { readState: "done" })
    await notify(input, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(deps.db.rows.size).toBe(2)
    expect(deps.db.rows.get("id-1")).toMatchObject({ readState: "unseen", count: 1 })
  })

  it("escalates level on bump (info → error)", async () => {
    const deps = baseDeps()
    deps.newId = () => "one"
    await notify({ source: "scheduler", level: "info", title: "run", dedupeKey: "task:1" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    await notify(
      { source: "scheduler", level: "error", title: "run failed", dedupeKey: "task:1" },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    expect(deps.db.rows.get("one")!.level).toBe("error")
  })
})

describe("notify — defaults", () => {
  it("uses real defaults when prefs are absent", async () => {
    const deps = baseDeps({ loadPrefs: () => DEFAULT_NOTIFICATION_PREFERENCES })
    const toast = jest.fn()
    deps.toast = toast
    await notify({ source: "system", level: "info", title: "T" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    // default channels = center+toast → toast fires
    expect(toast).toHaveBeenCalled()
  })
})

describe("source workspace label", () => {
  it("keeps the workspace the caller named", async () => {
    const deps = baseDeps()
    await notify({ source: "system", level: "info", title: "x", projectId: "w1" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(deps.db.rows.get("fixed-id")!.projectId).toBe("w1")
  })

  it("inherits the conversation's workspace when the caller names none", async () => {
    const resolveSessionWorkspace = jest.fn(async () => "w-from-session")
    const deps = baseDeps({ resolveSessionWorkspace })
    await notify(
      { source: "session", level: "info", title: "x", sourceRef: { kind: "session", id: "s1" } },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    expect(resolveSessionWorkspace).toHaveBeenCalledWith("s1")
    expect(deps.db.rows.get("fixed-id")!.projectId).toBe("w-from-session")
  })

  it("leaves a machine-wide notification unlabelled", async () => {
    const resolveSessionWorkspace = jest.fn(async () => "nope")
    const deps = baseDeps({ resolveSessionWorkspace })
    await notify({ source: "system", level: "info", title: "update available" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(resolveSessionWorkspace).not.toHaveBeenCalled()
    expect(deps.db.rows.get("fixed-id")!.projectId).toBeUndefined()
  })

  it("delivers the notification even when the workspace cannot be resolved", async () => {
    // An unlabelled notification is far better than a lost one.
    const deps = baseDeps({
      resolveSessionWorkspace: async () => {
        throw new Error("db closed")
      },
    })
    const id = await notify(
      { source: "session", level: "info", title: "x", sourceRef: { kind: "session", id: "s1" } },
      deps,
      { personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice") }
    )
    expect(id).toBe("fixed-id")
    expect(deps.db.rows.get("fixed-id")!.projectId).toBeUndefined()
  })
})

describe("per-workspace routing (ADR-0204)", () => {
  const sessionInput = {
    source: "session" as const,
    level: "warning" as const,
    title: "x",
    sourceRef: { kind: "session" as const, id: "s1" },
  }

  it("resolves the workspace before routing when a workspace rule exists", async () => {
    const toast = jest.fn()
    const resolveSessionWorkspace = jest.fn(async () => "w1")
    const deps = baseDeps({
      toast,
      resolveSessionWorkspace,
      loadPrefs: () =>
        resolvePreferences({
          globalDefaultChannels: ["center", "toast"],
          perProject: { w1: { enabled: false } },
        }),
    })
    await notify(sessionInput, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(toast).not.toHaveBeenCalled()
    expect(resolveSessionWorkspace).toHaveBeenCalledTimes(1)
    expect(deps.db.rows.get("fixed-id")!.projectId).toBe("w1")
  })

  it("does not resolve the workspace for a coalesced bump when no rule exists", async () => {
    const resolveSessionWorkspace = jest.fn(async () => "w1")
    const deps = baseDeps({ resolveSessionWorkspace })
    await notify({ ...sessionInput, dedupeKey: "k" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    await notify({ ...sessionInput, dedupeKey: "k" }, deps, {
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    })
    expect(resolveSessionWorkspace).toHaveBeenCalledTimes(1)
  })
})
