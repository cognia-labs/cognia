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
} from "./background-result-runtime"
import { outboxRecordFromJobExit } from "@/lib/background-tasks/job-settlement"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import { WAKE_COALESCE_MS } from "@/lib/background-tasks/wake-policy"

const isSessionOpen = jest.fn((_sessionId: string) => true)
const sessionStatusOf = jest.fn((_sessionId: string) => "idle")
const listBackgroundTaskRecords = jest.fn(async (): Promise<unknown[]> => [])
const claimBackgroundJobDelivery = jest.fn(async (_input: unknown) => true)

jest.mock("@/lib/chat/steer-runtime", () => ({
  isSessionOpen: (sessionId: string) => isSessionOpen(sessionId),
  sessionStatusOf: (sessionId: string) => sessionStatusOf(sessionId),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  listBackgroundTaskRecords: () => listBackgroundTaskRecords(),
  updateBackgroundTaskRecord: async () => undefined,
  reserveBackgroundTaskDelivery: async (_sessionId: string, runIds: string[], id: string) => ({
    runIds,
    deliveryId: id,
  }),
  upsertBackgroundJobSettlement: async (record: BackgroundTaskJournalRecord) => ({
    kind: "created",
    record,
  }),
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => ({ id: "chat-1" }) }))
jest.mock("@/lib/notifications/runtime", () => ({ notify: async () => "n1" }))
jest.mock("@/lib/jobs/background-jobs", () => ({
  claimBackgroundJobDelivery: (input: unknown) => claimBackgroundJobDelivery(input),
  listBackgroundJobSettlements: async () => ({ jobs: [], monitors: [] }),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const run = () =>
  onBackgroundRunSettled(
    "run-1",
    {
      kind: "subagent",
      subagentId: "explore",
      prompt: "look",
      sessionId: "chat-1",
      host: "renderer",
      startedAt: 1_000,
      mode: "background",
    },
    { status: "done", settledAt: 4_000, resultText: "findings" }
  )

beforeEach(() => {
  jest.clearAllMocks()
  __resetBackgroundResultRuntimeForTesting()
  window.localStorage.clear()
  isSessionOpen.mockReturnValue(true)
  sessionStatusOf.mockReturnValue("idle")
})

it("delivers into a conversation open and idle in this window", async () => {
  const send = jest.fn().mockResolvedValue(true)
  registerBackgroundReplaySend(send)
  run()
  await flush()
  expect(isSessionOpen).toHaveBeenCalledWith("chat-1")
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0][1]).toBe("chat-1")
})

it("keeps results while the conversation streams or is closed here", async () => {
  const send = jest.fn().mockResolvedValue(true)
  registerBackgroundReplaySend(send)
  sessionStatusOf.mockReturnValue("streaming")
  run()
  await flush()
  isSessionOpen.mockReturnValue(false)
  sessionStatusOf.mockReturnValue("idle")
  maybeDrainBackgroundResults("chat-1")
  await flush()
  expect(send).not.toHaveBeenCalled()
  isSessionOpen.mockReturnValue(true)
  maybeDrainBackgroundResults("chat-1", { turnSettled: true })
  await flush()
  expect(send).toHaveBeenCalledTimes(1)
})

it("claims job ends under one stable consumer id for this browser profile", async () => {
  let now = 10_000
  __setBackgroundJobDeliveryDepsForTesting({
    now: () => now,
    isBudgetExhausted: async () => false,
    inlineMonitors: async () => new Set(),
    schedule: () => 0,
    cancel: () => undefined,
  })
  registerBackgroundReplaySend(jest.fn().mockResolvedValue(true))
  const end = (jobId: string) =>
    outboxRecordFromJobExit(
      {
        jobId,
        status: "exited",
        exitCode: 0,
        endedAtMs: now,
        startedAtMs: now - 1_000,
        command: "sleep 5 && echo done",
        delivery: { sessionId: "chat-1", notify: "on_exit" },
      },
      "renderer"
    )!
  for (const jobId of ["job-a", "job-b"]) {
    const record = end(jobId)
    listBackgroundTaskRecords.mockImplementation(async () => [record])
    await onBackgroundJobSettled(record)
    await flush()
    now += WAKE_COALESCE_MS
    await attemptBackgroundResultDelivery("chat-1")
  }
  const consumers = claimBackgroundJobDelivery.mock.calls.map(
    ([input]) => (input as { consumer: string }).consumer
  )
  expect(consumers.length).toBeGreaterThanOrEqual(2)
  expect(consumers[0]).toMatch(/^renderer:/)
  expect(new Set(consumers).size).toBe(1)
  expect(window.localStorage.getItem("cognia.background-job-consumer")).toBe(consumers[0])
})

it("stops delivering once the controller unregisters its send", async () => {
  const send = jest.fn().mockResolvedValue(true)
  registerBackgroundReplaySend(send)()
  run()
  await flush()
  expect(send).not.toHaveBeenCalled()
})
