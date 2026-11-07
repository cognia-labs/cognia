import { JOB_RECONCILE_WINDOW_MS } from "./job-settlement"
import {
  JOB_EXITED_EVENT,
  MONITOR_FIRED_EVENT,
  startJobSettlementConsumer,
  type JobSettlementConsumerDeps,
} from "./job-settlement-consumer"
import type { BackgroundTaskJournalRecord } from "./registry-core"

const exit = {
  jobId: "job-1",
  status: "exited",
  exitCode: 0,
  endedAtMs: 9_000,
  startedAtMs: 1_000,
  command: "sleep 5 && echo done",
  delivery: { sessionId: "chat-1", notify: "on_exit" as const },
}
const monitor = {
  id: "mon-1",
  status: "fired",
  condition: { kind: "jobExit", jobId: "job-1" },
  createdAtMs: 1_000,
  settledAtMs: 2_000,
  delivery: { sessionId: "chat-1", state: "pending" as const },
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: Partial<JobSettlementConsumerDeps> = {}) {
  const handlers = new Map<string, (payload: unknown) => void>()
  const unsubscribed: string[] = []
  const recorded: BackgroundTaskJournalRecord[] = []
  const resolvers = new Map<string, () => Promise<void>>()
  const deps: JobSettlementConsumerDeps = {
    host: "renderer",
    subscribe: (async (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler)
      return () => unsubscribed.push(event)
    }) as JobSettlementConsumerDeps["subscribe"],
    listSettlements: jest.fn(async () => ({ jobs: [], monitors: [] })),
    onSettled: jest.fn(async (record: BackgroundTaskJournalRecord) => {
      recorded.push(record)
    }),
    registerResync: (domain, resolver) => {
      resolvers.set(domain, resolver)
      return () => resolvers.delete(domain)
    },
    now: () => 10 * 60 * 60 * 1000,
    ...overrides,
  }
  return { deps, handlers, unsubscribed, recorded, resolvers }
}

describe("startJobSettlementConsumer", () => {
  it("records ends from both events, and only ends a conversation is owed", async () => {
    const h = harness()
    startJobSettlementConsumer(h.deps)
    await flush()
    h.handlers.get(JOB_EXITED_EVENT)?.(exit)
    h.handlers.get(JOB_EXITED_EVENT)?.({ ...exit, jobId: "scheduled", delivery: undefined })
    h.handlers.get(MONITOR_FIRED_EVENT)?.(monitor)
    await flush()
    expect(h.recorded.map((record) => record.runId)).toEqual(["shell-job:job-1", "monitor:mon-1"])
  })

  it("reconciles what the supervisor kept once subscribed, within the window", async () => {
    const listSettlements = jest.fn(async () => ({ jobs: [exit], monitors: [monitor] }))
    const h = harness({ listSettlements })
    startJobSettlementConsumer(h.deps)
    await flush()
    await flush()
    expect(listSettlements).toHaveBeenCalledWith({
      sinceMs: 10 * 60 * 60 * 1000 - JOB_RECONCILE_WINDOW_MS,
    })
    expect(h.recorded.map((record) => record.runId)).toEqual(["shell-job:job-1", "monitor:mon-1"])
  })

  it("reconciles again when the transport reports missed jobs events", async () => {
    const listSettlements = jest.fn(async () => ({ jobs: [exit], monitors: [] }))
    const h = harness({ listSettlements })
    startJobSettlementConsumer(h.deps)
    await flush()
    await flush()
    await h.resolvers.get("jobs")?.()
    expect(listSettlements).toHaveBeenCalledTimes(2)
    // The outbox write is idempotent: the consumer hands the end over again.
    expect(h.recorded).toHaveLength(2)
  })

  it("stops listening and drops its resync on stop", async () => {
    const h = harness()
    const consumer = startJobSettlementConsumer(h.deps)
    await flush()
    consumer.stop()
    expect(h.unsubscribed.sort()).toEqual([JOB_EXITED_EVENT, MONITOR_FIRED_EVENT].sort())
    expect(h.resolvers.has("jobs")).toBe(false)
    h.handlers.get(JOB_EXITED_EVENT)?.(exit)
    await consumer.reconcile()
    expect(h.recorded).toEqual([])
  })

  it("keeps going when one settlement fails to record", async () => {
    const warn = jest.fn()
    const onSettled = jest
      .fn<Promise<void>, [BackgroundTaskJournalRecord]>()
      .mockRejectedValueOnce(new Error("dexie"))
      .mockResolvedValue(undefined)
    const h = harness({
      onSettled,
      warn,
      listSettlements: async () => ({ jobs: [exit, { ...exit, jobId: "job-2" }], monitors: [] }),
    })
    startJobSettlementConsumer(h.deps)
    await flush()
    await flush()
    await flush()
    expect(onSettled).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith("background job settlement failed", expect.any(Error))
  })
})
