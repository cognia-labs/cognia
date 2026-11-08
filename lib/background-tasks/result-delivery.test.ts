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
  registerBackgroundDeliveryLane,
  registerBackgroundResultNotifyStrings,
  registerImRoomDeliveryLane,
  registerRoomDeliveryLane,
  type BackgroundReplaySend,
} from "./result-delivery"
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
import { squadHandoffOutboxRecord } from "@/lib/background-tasks/squad-handoff-outbox"

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
const claimBackgroundJobDelivery = jest.fn(async (_input: unknown) => true)
const notify = jest.fn(async () => "n1")

/** The lane a test registers: reachable and idle as the two mocks say. */
function registerBackgroundReplaySend(send: BackgroundReplaySend): () => void {
  return registerBackgroundDeliveryLane({
    isReachable: () => isSessionOpen(),
    isIdle: () => sessionStatusOf() === "idle",
    send,
    consumerId: () => "test-consumer",
  })
}
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
jest.mock("@/lib/jobs/background-jobs", () => ({
  claimBackgroundJobDelivery: (input: unknown) => claimBackgroundJobDelivery(input),
  listBackgroundJobSettlements: async () => ({ jobs: [], monitors: [] }),
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
    expect(claimDelivery).toHaveBeenCalledWith("job", "job-mine", "test-consumer")
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

describe("the delivery lane", () => {
  const jobEnd = () =>
    outboxRecordFromJobExit(
      {
        jobId: "job-lane",
        status: "exited",
        exitCode: 0,
        endedAtMs: 1_000,
        startedAtMs: 500,
        command: "sleep 5 && echo done",
        outputTail: "done\n",
        delivery: { sessionId: "chat-1", notify: "on_exit" },
      },
      "renderer"
    )!

  it("asks an asynchronous lane whether the conversation is reachable and idle", async () => {
    const send = jest.fn().mockResolvedValue(true)
    let idle = false
    registerBackgroundDeliveryLane({
      isReachable: async () => true,
      isIdle: async () => idle,
      send,
      consumerId: () => "brain:account-db",
    })
    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()
    expect(send).not.toHaveBeenCalled()
    idle = true
    maybeDrainBackgroundResults("chat-1", { turnSettled: true })
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("claims job ends under the registered lane's consumer id", async () => {
    let now = 50_000
    __setBackgroundJobDeliveryDepsForTesting({
      now: () => now,
      isBudgetExhausted: async () => false,
      inlineMonitors: async () => new Set(),
      schedule: () => 0,
      cancel: () => undefined,
    })
    const record = jobEnd()
    listBackgroundTaskRecords.mockImplementation(async () => [record])
    const send = jest.fn().mockResolvedValue(true)
    registerBackgroundDeliveryLane({
      isReachable: () => true,
      isIdle: () => true,
      send,
      consumerId: () => "brain:account-db",
    })
    await onBackgroundJobSettled(record)
    await flush()
    now += WAKE_COALESCE_MS
    await attemptBackgroundResultDelivery("chat-1")
    expect(claimBackgroundJobDelivery).toHaveBeenCalledWith({
      kind: "job",
      id: "job-lane",
      consumer: "brain:account-db",
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("delivers nothing and claims nothing with no lane registered", async () => {
    const record = jobEnd()
    listBackgroundTaskRecords.mockImplementation(async () => [record])
    await attemptBackgroundResultDelivery("chat-1")
    expect(claimBackgroundJobDelivery).not.toHaveBeenCalled()
    expect(reserveBackgroundTaskDelivery).not.toHaveBeenCalled()
  })

  it("stops using a lane once it is unregistered", async () => {
    const send = jest.fn().mockResolvedValue(true)
    const unregister = registerBackgroundDeliveryLane({
      isReachable: () => true,
      isIdle: () => true,
      send,
      consumerId: () => "renderer:x",
    })
    unregister()
    onBackgroundRunSettled("run-2", meta(), settle())
    await flush()
    expect(send).not.toHaveBeenCalled()
  })
})

describe("a character-team room's results (ADR-0252 §4)", () => {
  let now = 200_000
  const timers: Array<{ run: () => void; at: number }> = []
  let journal: BackgroundTaskJournalRecord[] = []
  const room = { id: "room-1", kind: "team", teamId: "team-1" }

  const handoffEnd = (
    squadRunId = "execution:team:r1",
    outcome: "completed" | "failed" | "cancelled" = "completed",
    proposerId = "ava"
  ) =>
    squadHandoffOutboxRecord({
      roomId: "room-1",
      brief: "Write a hello script",
      startedAt: now - 60_000,
      settledAt: now,
      ...(outcome === "completed" ? { resultText: "hello.sh written" } : {}),
      facts: {
        proposerId,
        toolUseId: "tu-1",
        squadId: "sq-1",
        squadName: "Builders",
        delegationRunId: "execution:delegation:room-handoff:tu-1",
        squadRunId,
        outcome,
      },
    })

  async function settleHandoff(record: BackgroundTaskJournalRecord) {
    journal = [...journal.filter((row) => row.runId !== record.runId), record]
    await onBackgroundJobSettled(record)
    await flush()
  }

  async function advance(ms: number) {
    now += ms
    for (const timer of timers.splice(0).filter((candidate) => candidate.at <= now)) timer.run()
    await flush()
  }

  const lanes = () => {
    const chat = jest.fn().mockResolvedValue(true)
    const roomSend = jest.fn().mockResolvedValue(true)
    registerBackgroundReplaySend(chat)
    const unregister = registerRoomDeliveryLane({
      isReachable: () => true,
      isIdle: () => true,
      send: roomSend,
      consumerId: () => "room:db",
    })
    return { chat, roomSend, unregister }
  }

  beforeEach(() => {
    now = 200_000
    timers.length = 0
    journal = []
    getSession.mockResolvedValue(room)
    listBackgroundTaskRecords.mockImplementation(async () =>
      journal.filter((row) => row.deliveryState === "pending")
    )
    updateBackgroundTaskRecord.mockImplementation((async (runId: string, patch: object) => {
      journal = journal.map((row) => (row.runId === runId ? { ...row, ...patch } : row))
    }) as never)
    __setBackgroundJobDeliveryDepsForTesting({
      now: () => now,
      isBudgetExhausted: async () => false,
      inlineMonitors: async () => new Set(),
      claimDelivery: async () => true,
      schedule: (run, ms) => {
        timers.push({ run, at: now + ms })
        return timers.length
      },
      cancel: () => undefined,
    })
  })

  it("wakes the room for the proposers through the room's lane, never the chat lane", async () => {
    const { chat, roomSend } = lanes()
    await settleHandoff(handoffEnd("execution:team:r1", "completed", "ava"))
    await settleHandoff(handoffEnd("execution:team:r2", "failed", "bee"))
    // A wake: the coalescing window comes first.
    expect(roomSend).not.toHaveBeenCalled()
    await advance(WAKE_COALESCE_MS)
    expect(chat).not.toHaveBeenCalled()
    expect(roomSend).toHaveBeenCalledTimes(1)
    const [framed, sessionId, , personalRunIds, targets] = roomSend.mock.calls[0]
    expect(sessionId).toBe("room-1")
    expect(framed).toContain('Squad "Builders" (run execution:team:r1) finished')
    expect(framed).toContain("hello.sh written")
    expect(framed).toContain("(run execution:team:r2) failed")
    expect(personalRunIds).toEqual([])
    expect(targets).toEqual({ memberIds: ["ava", "bee"] })
    expect(journal.every((row) => row.deliveryState === "delivered")).toBe(true)
  })

  it("keeps a room's results while it has no lane here, and owes a stopped run nothing", async () => {
    const { chat, roomSend, unregister } = lanes()
    unregister()
    await settleHandoff(handoffEnd())
    await advance(WAKE_COALESCE_MS)
    expect(chat).not.toHaveBeenCalled()
    expect(journal[0]?.deliveryState).toBe("pending")

    journal = []
    registerRoomDeliveryLane({
      isReachable: () => true,
      isIdle: () => true,
      send: roomSend,
      consumerId: () => "room:db",
    })
    await settleHandoff(handoffEnd("execution:team:r9", "cancelled"))
    await advance(WAKE_COALESCE_MS)
    expect(roomSend).not.toHaveBeenCalled()
  })

  it("brings an IM group's result back into the group, and keeps it while no IM lane runs here", async () => {
    getSession.mockResolvedValue({
      id: "room-1",
      platformBinding: {
        platform: "lark",
        adapterId: "a1",
        conversationKey: "lark:a1:oc_1",
        scopeKind: "group",
      },
    })
    const { chat, roomSend } = lanes()
    await settleHandoff(handoffEnd())
    await advance(WAKE_COALESCE_MS)
    // Neither the chat lane (a desktop turn nobody in the group sees) nor the
    // desktop room's.
    expect(chat).not.toHaveBeenCalled()
    expect(roomSend).not.toHaveBeenCalled()
    expect(journal[0]?.deliveryState).toBe("pending")

    const imSend = jest.fn().mockResolvedValue(true)
    registerImRoomDeliveryLane({
      isReachable: () => true,
      isIdle: () => true,
      send: imSend,
      consumerId: () => "im-room:db",
    })
    maybeDrainBackgroundResults("room-1", { turnSettled: true })
    await advance(WAKE_COALESCE_MS)
    expect(imSend).toHaveBeenCalledTimes(1)
    const [framed, sessionId, , , targets] = imSend.mock.calls[0]
    expect(sessionId).toBe("room-1")
    expect(framed).toContain("hello.sh written")
    expect(targets).toEqual({ memberIds: ["ava"] })
    expect(chat).not.toHaveBeenCalled()
    expect(journal.every((row) => row.deliveryState === "delivered")).toBe(true)
  })

  it("waits for a busy room's turn boundary", async () => {
    let idle = false
    const roomSend = jest.fn().mockResolvedValue(true)
    registerRoomDeliveryLane({
      isReachable: () => true,
      isIdle: () => idle,
      send: roomSend,
      consumerId: () => "room:db",
    })
    await settleHandoff(handoffEnd())
    await advance(WAKE_COALESCE_MS)
    expect(roomSend).not.toHaveBeenCalled()
    idle = true
    maybeDrainBackgroundResults("room-1", { turnSettled: true })
    await flush()
    expect(roomSend).toHaveBeenCalledTimes(1)
  })
})
