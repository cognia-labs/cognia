/** @jest-environment node */
import type { ClaudeEvent } from "@cognia/agent-config-types"
import type { BackgroundDeliveryLane } from "./result-delivery"

const registered: BackgroundDeliveryLane[] = []
const unregisterLane = jest.fn()
const onBackgroundJobSettled = jest.fn(async () => undefined)
const maybeDrainBackgroundResults = jest.fn()
const consumerStop = jest.fn()
const startJobSettlementConsumer = jest.fn((_deps: Record<string, unknown>) => ({
  reconcile: async () => undefined,
  stop: consumerStop,
}))
const runHostAutomatedTurn = jest.fn(async () => true)
let frameHandler: ((event: ClaudeEvent) => void) | undefined
const unlistenFrames = jest.fn()
const openSubmissions = new Map<string, number>()
const resyncRegister = jest.fn(() => () => undefined)

jest.mock("./result-delivery", () => ({
  registerBackgroundDeliveryLane: (lane: BackgroundDeliveryLane) => {
    registered.push(lane)
    return unregisterLane
  },
  onBackgroundJobSettled: (...args: unknown[]) => onBackgroundJobSettled(...(args as [])),
  maybeDrainBackgroundResults: (...args: unknown[]) => maybeDrainBackgroundResults(...(args as [])),
}))
jest.mock("./host-delivery-lane", () => {
  const actual = jest.requireActual("./host-delivery-lane")
  return {
    ...actual,
    runHostAutomatedTurn: (...args: unknown[]) => runHostAutomatedTurn(...(args as [])),
  }
})
jest.mock("./job-settlement-consumer", () => ({
  startJobSettlementConsumer: (deps: Record<string, unknown>) => startJobSettlementConsumer(deps),
}))
jest.mock("@/lib/jobs/background-jobs", () => ({
  listBackgroundJobSettlements: async () => ({ jobs: [], monitors: [] }),
}))
jest.mock("@/lib/tauri/events", () => ({ onTauriEvent: async () => () => undefined }))
jest.mock("@/lib/tauri/resync-coordinator", () => ({
  remoteEventResyncCoordinator: {
    register: (...args: unknown[]) => resyncRegister(...(args as [])),
  },
}))
jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: async (handler: (event: ClaudeEvent) => void) => {
    frameHandler = handler
    return unlistenFrames
  },
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: async (id: string) => (id === "gone" ? undefined : { id }),
}))
jest.mock("@/lib/db/work-submissions", () => ({
  listWorkSubmissions: async ({ sessionId }: { sessionId: string }) => {
    const left = openSubmissions.get(sessionId) ?? 0
    if (left > 0) openSubmissions.set(sessionId, left - 1)
    return left > 0 ? [{ id: "work:x" }] : []
  },
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "cognia-acct-1" }) }))
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  runtimeRefForSession: () => ({ kind: "builtin" }),
}))

import { start } from "./runtime-brain"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  registered.length = 0
  openSubmissions.clear()
  frameHandler = undefined
})

it("registers the Host's lane and consumes the supervisor's job ends", async () => {
  const stop = await start()
  expect(registered).toHaveLength(1)
  const lane = registered[0]!
  expect(lane.consumerId()).toBe("brain:cognia-acct-1")
  await expect(lane.isReachable("chat-1")).resolves.toBe(true)
  await expect(lane.isReachable("gone")).resolves.toBe(false)
  await expect(lane.isIdle("chat-1")).resolves.toBe(true)
  await lane.send("framed", "chat-1", "delivery-1", ["execution:job:r1"])
  expect(runHostAutomatedTurn).toHaveBeenCalledWith({
    sessionId: "chat-1",
    text: "framed",
    deliveryId: "delivery-1",
    personalRunIds: ["execution:job:r1"],
  })
  const consumerDeps = startJobSettlementConsumer.mock.calls[0]![0]
  expect(consumerDeps.host).toBe("renderer")
  await (consumerDeps.onSettled as (record: unknown) => Promise<void>)({ runId: "shell-job:j" })
  expect(onBackgroundJobSettled).toHaveBeenCalledWith({ runId: "shell-job:j" })
  ;(consumerDeps.registerResync as (domain: string, resolver: () => Promise<void>) => void)(
    "jobs",
    async () => undefined
  )
  expect(resyncRegister).toHaveBeenCalledWith("jobs", expect.any(Function))
  stop()
  expect(unlistenFrames).toHaveBeenCalled()
  expect(consumerStop).toHaveBeenCalled()
  expect(unregisterLane).toHaveBeenCalled()
})

it("drains a conversation once its ended turn's submission has settled", async () => {
  const stop = await start()
  openSubmissions.set("chat-1", 1)
  frameHandler!({ type: "session_ended", sessionId: "chat-1" } as ClaudeEvent)
  await flush()
  expect(maybeDrainBackgroundResults).not.toHaveBeenCalled()
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(maybeDrainBackgroundResults).toHaveBeenCalledWith("chat-1", { turnSettled: true })
  stop()
})

it("records an in-process shell's end from its settled frame", async () => {
  const stop = await start()
  frameHandler!({
    type: "background_job_settled",
    sessionId: "chat-1",
    settlement: {
      jobId: "job-7",
      status: "exited",
      exitCode: 0,
      endedAtMs: 2_000,
      startedAtMs: 1_000,
      command: "sleep 5 && echo done",
      delivery: { sessionId: "chat-1", notify: "on_exit" },
    },
  } as unknown as ClaudeEvent)
  await flush()
  stop()
  expect(onBackgroundJobSettled).toHaveBeenCalledWith(
    expect.objectContaining({ runId: "shell-job:job-7", kind: "shell-job", sessionId: "chat-1" })
  )
  expect(maybeDrainBackgroundResults).not.toHaveBeenCalled()
})

it("ignores frames after it stopped", async () => {
  const stop = await start()
  stop()
  frameHandler!({ type: "session_ended", sessionId: "chat-1" } as ClaudeEvent)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(maybeDrainBackgroundResults).not.toHaveBeenCalled()
})
