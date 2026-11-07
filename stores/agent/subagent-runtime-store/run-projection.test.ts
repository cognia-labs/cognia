/**
 * @jest-environment jsdom
 */

import type { Subscription } from "dexie"
import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import type { SubAgent } from "@/types/agent/sub-agent"
import { useSubagentRuntimeStore } from "./index"
import { startSubagentRunProjection } from "./run-projection"

function entry(id: string, overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id,
    parentAgentId: "__chat__",
    name: "reviewer",
    description: "",
    task: "review",
    initialTask: "review",
    threadId: id,
    status: "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    retryCount: 0,
    order: 0,
    ...overrides,
  }
}

/** A manual live query: each subscription is held until the test emits. */
function manualLiveQuery() {
  const live: { query: () => Promise<unknown>; next: (value: unknown) => void; closed: boolean }[] =
    []
  const liveQuery = <T>(query: () => Promise<T>) => ({
    subscribe(observer: { next(value: T): void; error(error: unknown): void }): Subscription {
      const entry = {
        query: query as () => Promise<unknown>,
        next: observer.next as (value: unknown) => void,
        closed: false,
      }
      live.push(entry)
      return {
        unsubscribe: () => {
          entry.closed = true
        },
        closed: false,
      } as Subscription
    },
  })
  const emit = async () => {
    const current = live.filter((item) => !item.closed).at(-1)!
    current.next(await current.query())
  }
  return { liveQuery, live, emit }
}

const run = (status: ExecutionRun["status"], endedAt?: number) =>
  ({ status, ...(endedAt !== undefined ? { endedAt } : {}) }) as ExecutionRun

beforeEach(() => {
  useSubagentRuntimeStore.setState((s) => ({ ...s, subAgents: {}, runs: {} }))
})

it("gives a dispatched run its run row's status", async () => {
  const { liveQuery, emit } = manualLiveQuery()
  const readRuns = jest.fn(async (ids: string[]) =>
    ids.map((id) => (id === "execution:job:a" ? run("cancelled", 5000) : undefined))
  )
  useSubagentRuntimeStore.setState((s) => ({
    ...s,
    subAgents: { a: entry("a"), sdk: entry("sdk", { status: "running" }) },
  }))
  const stop = startSubagentRunProjection(useSubagentRuntimeStore, { readRuns, liveQuery })
  await emit()
  const state = useSubagentRuntimeStore.getState()
  expect(state.subAgents.a).toMatchObject({ status: "cancelled", completedAt: new Date(5000) })
  // No row (an in-turn SDK Task): its engine's status stands.
  expect(state.subAgents.sdk.status).toBe("running")
  expect(readRuns).toHaveBeenCalledWith(["execution:job:a", "execution:job:sdk"])
  stop()
})

it("re-issues its query when the tracked ids change, and stops on demand", async () => {
  const { liveQuery, live, emit } = manualLiveQuery()
  const readRuns = jest.fn(async (ids: string[]) => ids.map(() => run("running")))
  const stop = startSubagentRunProjection(useSubagentRuntimeStore, { readRuns, liveQuery })
  // Nothing tracked: nothing queried.
  expect(live).toHaveLength(0)
  useSubagentRuntimeStore.getState().upsert(entry("b"))
  expect(live).toHaveLength(1)
  await emit()
  expect(useSubagentRuntimeStore.getState().runs.b).toEqual({ status: "running" })
  // A progress write keeps the id set: no new query.
  useSubagentRuntimeStore.getState().setToolUses("b", 3)
  expect(live).toHaveLength(1)
  useSubagentRuntimeStore.getState().upsert(entry("c"))
  expect(live).toHaveLength(2)
  expect(live[0].closed).toBe(true)
  stop()
  expect(live[1].closed).toBe(true)
})
