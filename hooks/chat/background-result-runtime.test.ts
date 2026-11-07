/**
 * @jest-environment jsdom
 */
import {
  __resetBackgroundResultRuntimeForTesting,
  __setBackgroundJobDeliveryDepsForTesting,
  attemptBackgroundResultDelivery,
  maybeDrainBackgroundResults,
  onBackgroundJobSettled,
  onBackgroundRunSettled,
  registerBackgroundReplaySend,
  registerBackgroundResultNotifyStrings,
} from "./background-result-runtime"
import type {
  BackgroundTaskJournalRecord,
  BackgroundTaskSettleInfo,
  BackgroundTaskStartMeta,
} from "@/lib/background-tasks/registry-core"
import {
  outboxRecordFromJobExit,
  outboxRecordFromMonitor,
} from "@/lib/background-tasks/job-settlement"
import { WAKE_CAP_PER_HOUR, WAKE_COALESCE_MS } from "@/lib/background-tasks/wake-policy"

const isSessionOpen = jest.fn(() => true)
const sessionStatusOf = jest.fn(() => "idle")
const listBackgroundTaskRecords = jest.fn(async (): Promise<unknown[]> => [])
const reserveBackgroundTaskDelivery = jest.fn(
  async (_sessionId: string, runIds: string[], deliveryId: string) => ({ runIds, deliveryId })
)
const updateBackgroundTaskRecord = jest.fn(async () => undefined)
const upsertBackgroundJobSettlement = jest.fn(async (record: BackgroundTaskJournalRecord) => ({
  kind: "created" as const,
  record,
}))
const getSession = jest.fn(async (): Promise<unknown> => ({ id: "chat-1" }))
const notify = jest.fn(async () => "n1")

jest.mock("./steer-runtime", () => ({
  isSessionOpen: (...args: unknown[]) => isSessionOpen(...(args as [])),
  sessionStatusOf: (...args: unknown[]) => sessionStatusOf(...(args as [])),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  listBackgroundTaskRecords: (...args: unknown[]) => listBackgroundTaskRecords(...(args as [])),
  updateBackgroundTaskRecord: (...args: unknown[]) => updateBackgroundTaskRecord(...(args as [])),
  reserveBackgroundTaskDelivery: (...args: Parameters<typeof reserveBackgroundTaskDelivery>) =>
    reserveBackgroundTaskDelivery(...args),
  upsertBackgroundJobSettlement: (record: BackgroundTaskJournalRecord) =>
    upsertBackgroundJobSettlement(record),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSession(...(args as [])),
}))
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notify(...(args as [])),
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

function meta(over: Partial<BackgroundTaskStartMeta> = {}): BackgroundTaskStartMeta {
  return {
    kind: "subagent",
    subagentId: "explore",
    prompt: "look",
    sessionId: "chat-1",
    host: "renderer",
    startedAt: 1_000,
    mode: "background",
    ...over,
  }
}

function settle(over: Partial<BackgroundTaskSettleInfo> = {}): BackgroundTaskSettleInfo {
  return { status: "done", settledAt: 4_000, resultText: "findings", ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetBackgroundResultRuntimeForTesting()
  isSessionOpen.mockReturnValue(true)
  sessionStatusOf.mockReturnValue("idle")
  getSession.mockResolvedValue({ id: "chat-1" })
  listBackgroundTaskRecords.mockResolvedValue([])
})

describe("onBackgroundRunSettled", () => {
  it("injects a framed turn into an open idle parent and marks the row delivered", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const [framed, sessionId, , personalRunIds] = send.mock.calls[0]
    expect(personalRunIds).toEqual(["execution:job:run-1"])
    expect(sessionId).toBe("chat-1")
    expect(framed).toContain("[background task update]")
    expect(framed).toContain('Subagent "explore" (runId run-1)')
    expect(framed).toContain("findings")
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })

  it("fires a completion notification with localized copy", async () => {
    registerBackgroundResultNotifyStrings({
      title: ({ subagentId, status, elapsed }) => `T:${subagentId}:${status}:${elapsed}`,
      body: ({ runId }) => `B:${runId}`,
    })
    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "session",
        level: "success",
        title: "T:explore:done:3s",
        body: "B:run-1",
        groupKey: "run-1",
      })
    )
  })

  it("uses the error level for failed runs and frames the cut-off text", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)

    onBackgroundRunSettled(
      "run-1",
      meta(),
      settle({ status: "error", resultText: "half done", error: "429 rate limit" })
    )
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }))
    const [framed] = send.mock.calls[0]
    expect(framed).toContain("(error):")
    expect(framed).toContain("half done")
    expect(framed).toContain("cut off by an error and did not finish: 429 rate limit")
  })

  it("stays pending while the parent is streaming, then drains at settle", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    sessionStatusOf.mockReturnValue("streaming")

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(updateBackgroundTaskRecord).not.toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )

    sessionStatusOf.mockReturnValue("idle")
    maybeDrainBackgroundResults("chat-1")
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("stays pending while the pane is closed, then drains on open", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    isSessionOpen.mockReturnValue(false)

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()
    expect(send).not.toHaveBeenCalled()

    isSessionOpen.mockReturnValue(true)
    maybeDrainBackgroundResults("chat-1")
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("marks entries orphaned (notification only) when the parent session is gone", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    getSession.mockResolvedValue(undefined)

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalled()
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "orphaned" })
    )
  })

  it("batches racing completions into ONE framed turn ordered by settledAt", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    sessionStatusOf.mockReturnValue("streaming") // hold both pending

    onBackgroundRunSettled(
      "run-b",
      meta({ subagentId: "b" }),
      settle({ settledAt: 6_000, resultText: "second" })
    )
    onBackgroundRunSettled(
      "run-a",
      meta({ subagentId: "a" }),
      settle({ settledAt: 5_000, resultText: "first" })
    )
    await flush()

    sessionStatusOf.mockReturnValue("idle")
    maybeDrainBackgroundResults("chat-1")
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const [framed] = send.mock.calls[0]
    expect(framed.indexOf("first")).toBeLessThan(framed.indexOf("second"))
  })

  it("ignores non-subagent kinds and non-terminal settles", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)

    onBackgroundRunSettled("p1", meta({ kind: "plugin-agent" }), settle())
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it("keeps entries pending when no replay send is registered", async () => {
    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(updateBackgroundTaskRecord).not.toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
    expect(updateBackgroundTaskRecord).not.toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })
})

describe("relaunch drain from journaled pending rows", () => {
  it("delivers journal rows with deliveryState pending when the session opens idle", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    listBackgroundTaskRecords.mockResolvedValue([
      {
        runId: "old-1",
        kind: "subagent",
        subagentId: "explore",
        prompt: "look",
        sessionId: "chat-1",
        host: "renderer",
        status: "done",
        startedAt: 1_000,
        settledAt: 2_000,
        resultText: "from a previous app run",
        deliveryState: "pending",
      },
      // Other sessions / non-pending rows are ignored.
      {
        runId: "other",
        kind: "subagent",
        subagentId: "explore",
        prompt: "look",
        sessionId: "chat-2",
        host: "renderer",
        status: "done",
        startedAt: 1_000,
        settledAt: 2_000,
        deliveryState: "pending",
      },
      {
        runId: "already",
        kind: "subagent",
        subagentId: "explore",
        prompt: "look",
        sessionId: "chat-1",
        host: "renderer",
        status: "done",
        startedAt: 1_000,
        settledAt: 2_000,
        deliveryState: "delivered",
      },
    ])

    await attemptBackgroundResultDelivery("chat-1")

    expect(send).toHaveBeenCalledTimes(1)
    const [framed] = send.mock.calls[0]
    expect(framed).toContain("from a previous app run")
    expect(framed).not.toContain("runId other")
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "old-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })

  it("no-ops for empty session ids and when nothing is pending", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)

    await attemptBackgroundResultDelivery("")
    await attemptBackgroundResultDelivery("chat-1")

    expect(send).not.toHaveBeenCalled()
  })
})

it("keeps a result pending when the registered send refuses durable acceptance", async () => {
  const send = jest.fn(async () => false)
  registerBackgroundReplaySend(send)
  onBackgroundRunSettled("declined", meta(), settle())
  await flush()
  expect(updateBackgroundTaskRecord).not.toHaveBeenCalledWith(
    "declined",
    expect.objectContaining({ deliveryState: "delivered" })
  )
  send.mockResolvedValue(true)
  await attemptBackgroundResultDelivery("chat-1")
  expect(send).toHaveBeenCalledTimes(2)
})

it("does not lose a new completion that arrives while an older batch awaits acceptance", async () => {
  let accept!: (value: boolean) => void
  const send = jest
    .fn()
    .mockResolvedValue(true)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve
        })
    )
    .mockResolvedValue(true)
  registerBackgroundReplaySend(send)
  onBackgroundRunSettled("first", meta(), settle())
  await flush()
  onBackgroundRunSettled("second", meta(), settle({ settledAt: 5000 }))
  accept(true)
  await flush()
  await attemptBackgroundResultDelivery("chat-1")
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][0]).toContain("runId second")
})

it("ignores a late settle listener after the journal batch was already delivered", async () => {
  const send = jest.fn().mockResolvedValue(true)
  registerBackgroundReplaySend(send)
  listBackgroundTaskRecords.mockResolvedValue([
    { ...meta(), runId: "already", ...settle(), deliveryState: "delivered" },
  ])
  onBackgroundRunSettled("already", meta(), settle())
  await flush()
  expect(send).not.toHaveBeenCalled()
  expect(updateBackgroundTaskRecord).not.toHaveBeenCalled()
})

it("keeps the reserved identity when the receipt write fails after acceptance", async () => {
  const send = jest.fn().mockResolvedValue(true)
  registerBackgroundReplaySend(send)
  listBackgroundTaskRecords.mockResolvedValue([
    { ...meta(), runId: "saved", ...settle(), deliveryState: "pending" },
  ])
  updateBackgroundTaskRecord.mockRejectedValueOnce(new Error("journal busy"))
  await attemptBackgroundResultDelivery("chat-1")
  await attemptBackgroundResultDelivery("chat-1")
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[0][2]).toEqual(send.mock.calls[1][2])
})

describe("background job ends (ADR-0249)", () => {
  let now = 100_000
  const timers: Array<{ run: () => void; at: number }> = []
  const isBudgetExhausted = jest.fn(async (_projectId: string | undefined) => false)
  const inlineMonitors = jest.fn(
    async (_sessionId: string, _ids: readonly string[]) => new Set<string>()
  )
  const claimDelivery = jest.fn(async (_kind: "job" | "monitor", _id: string) => true)
  let journal: BackgroundTaskJournalRecord[] = []

  const jobEnd = (jobId = "job-1", overrides: Record<string, unknown> = {}) =>
    outboxRecordFromJobExit(
      {
        jobId,
        status: "exited",
        exitCode: 0,
        endedAtMs: now,
        startedAtMs: now - 5_000,
        command: "sleep 5 && echo done",
        outputTail: "done\n",
        delivery: { sessionId: "chat-1", notify: "on_exit" },
        ...overrides,
      },
      "renderer"
    )!

  async function settleJob(record: BackgroundTaskJournalRecord) {
    journal = [...journal.filter((row) => row.runId !== record.runId), record]
    await onBackgroundJobSettled(record)
    await flush()
  }

  async function advance(ms: number) {
    now += ms
    for (const timer of timers.splice(0).filter((candidate) => candidate.at <= now)) timer.run()
    await flush()
  }

  beforeEach(() => {
    now = 100_000
    timers.length = 0
    journal = []
    isBudgetExhausted.mockReset().mockResolvedValue(false)
    inlineMonitors.mockReset().mockResolvedValue(new Set())
    listBackgroundTaskRecords.mockImplementation(async () =>
      journal.filter((row) => row.deliveryState === "pending")
    )
    updateBackgroundTaskRecord.mockImplementation((async (runId: string, patch: object) => {
      journal = journal.map((row) => (row.runId === runId ? { ...row, ...patch } : row))
    }) as never)
    claimDelivery.mockReset().mockResolvedValue(true)
    __setBackgroundJobDeliveryDepsForTesting({
      now: () => now,
      isBudgetExhausted,
      inlineMonitors,
      claimDelivery,
      schedule: (run, ms) => {
        timers.push({ run, at: now + ms })
        return timers.length
      },
      cancel: () => undefined,
    })
  })

  it("wakes an idle session with ends merged across the coalescing window", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    await settleJob(jobEnd("job-1"))
    expect(send).not.toHaveBeenCalled()
    await advance(3_000)
    await settleJob(jobEnd("job-2"))
    await advance(WAKE_COALESCE_MS)
    expect(send).toHaveBeenCalledTimes(1)
    const [framed, sessionId, , personalRunIds] = send.mock.calls[0]
    expect(sessionId).toBe("chat-1")
    expect(personalRunIds).toEqual([])
    expect(framed).toContain("(shellId job-1)")
    expect(framed).toContain("(shellId job-2)")
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "shell-job:job-2",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })

  it("records an end owed nothing without waking anyone", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    await settleJob(jobEnd("job-quiet", { delivery: { sessionId: "chat-1", notify: "none" } }))
    await advance(WAKE_COALESCE_MS)
    expect(upsertBackgroundJobSettlement).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it("does not wake a streaming session; a person's turn goes first, then the ends", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    sessionStatusOf.mockReturnValue("streaming")
    await settleJob(jobEnd())
    await advance(WAKE_COALESCE_MS)
    expect(send).not.toHaveBeenCalled()
    sessionStatusOf.mockReturnValue("idle")
    maybeDrainBackgroundResults("chat-1", { turnSettled: true })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("holds ends past the hourly cap, says so once, and sends them after another turn", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    for (let i = 0; i < WAKE_CAP_PER_HOUR; i += 1) {
      await settleJob(jobEnd(`job-${i}`))
      await advance(WAKE_COALESCE_MS)
      // The wake's own settle is not "another reason".
      maybeDrainBackgroundResults("chat-1", { turnSettled: true })
      await flush()
    }
    expect(send).toHaveBeenCalledTimes(WAKE_CAP_PER_HOUR)
    notify.mockClear()
    await settleJob(jobEnd("job-over"))
    await advance(WAKE_COALESCE_MS)
    maybeDrainBackgroundResults("chat-1")
    await flush()
    expect(send).toHaveBeenCalledTimes(WAKE_CAP_PER_HOUR)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: { kind: "session", id: "chat-1" }, level: "info" })
    )
    // A person's turn settles: the waiting end goes with that boundary.
    maybeDrainBackgroundResults("chat-1", { turnSettled: true })
    await flush()
    expect(send).toHaveBeenCalledTimes(WAKE_CAP_PER_HOUR + 1)
    expect(send.mock.calls.at(-1)?.[0]).toContain("(shellId job-over)")
  })

  it("does not wake a session over its budget", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    getSession.mockResolvedValue({ id: "chat-1", projectId: "proj-1" })
    isBudgetExhausted.mockResolvedValue(true)
    await settleJob(jobEnd())
    await advance(WAKE_COALESCE_MS)
    expect(isBudgetExhausted).toHaveBeenCalledWith("proj-1")
    expect(send).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "background-wake:chat-1:budget" })
    )
  })

  it("leaves out a monitor end the blocking call already returned inline", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    inlineMonitors.mockResolvedValue(new Set(["mon-1"]))
    const monitor = outboxRecordFromMonitor(
      {
        id: "mon-1",
        status: "fired",
        condition: { kind: "jobExit", jobId: "job-1" },
        createdAtMs: now - 1_000,
        settledAtMs: now,
        delivery: { sessionId: "chat-1", state: "pending" },
      },
      "renderer"
    )!
    await settleJob(monitor)
    await advance(WAKE_COALESCE_MS)
    expect(inlineMonitors).toHaveBeenCalledWith("chat-1", ["mon-1"])
    expect(send).not.toHaveBeenCalled()
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "monitor:mon-1",
      expect.objectContaining({ deliveryState: "skipped" })
    )
  })

  it("delivers an end twice reported only once", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    const end = jobEnd()
    await settleJob(end)
    upsertBackgroundJobSettlement.mockResolvedValueOnce({
      kind: "known" as never,
      record: { ...end, deliveryState: "delivered", deliveredAt: now },
    })
    await advance(WAKE_COALESCE_MS)
    await onBackgroundJobSettled(end)
    await advance(WAKE_COALESCE_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("delivers only the ends this device claimed and leaves the rest to their claimant", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    claimDelivery.mockImplementation(async (_kind, id) => id !== "job-elsewhere")
    await settleJob(jobEnd("job-mine"))
    await settleJob(jobEnd("job-elsewhere"))
    await advance(WAKE_COALESCE_MS)
    expect(claimDelivery).toHaveBeenCalledWith("job", "job-mine")
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toContain("(shellId job-mine)")
    expect(send.mock.calls[0][0]).not.toContain("job-elsewhere")
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "shell-job:job-elsewhere",
      expect.objectContaining({ deliveryState: "skipped" })
    )
  })

  it("keeps an end pending when the claim cannot be read", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    claimDelivery.mockRejectedValue(new Error("host unreachable"))
    await settleJob(jobEnd())
    await advance(WAKE_COALESCE_MS)
    expect(send).not.toHaveBeenCalled()
    expect(journal[0]?.deliveryState).toBe("pending")
  })

  it("lets a job end ride with a run's result without counting as a wake", async () => {
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(send)
    sessionStatusOf.mockReturnValue("streaming")
    await settleJob(jobEnd())
    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()
    sessionStatusOf.mockReturnValue("idle")
    maybeDrainBackgroundResults("chat-1", { turnSettled: true })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const [framed, , , personalRunIds] = send.mock.calls[0]
    expect(framed).toContain('Subagent "explore"')
    expect(framed).toContain("(shellId job-1)")
    expect(personalRunIds).toEqual(["execution:job:run-1"])
  })
})
