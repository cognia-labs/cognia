/** @jest-environment jsdom */
import { subscribeExternalIdleEvents } from "./agent-chat-external-subscriptions"

type Listener = (event: Record<string, unknown>) => void
const listeners = new Map<string, Listener>()
const removeListener = jest.fn()
const manager = {
  addEventListener: jest.fn((agentId: string, listener: Listener) => {
    listeners.set(agentId, listener)
    return removeListener
  }),
  setSessionHostFacts: jest.fn(),
}
jest.mock("@/lib/ai/agent/external/manager", () => ({ getExternalAgentManager: () => manager }))

let runtimeListener: (() => void) | null = null
const runtime = { sessionExternalLinks: {} as Record<string, unknown> }
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useAgentRuntimeStore: {
    getState: () => runtime,
    subscribe: (fn: () => void) => {
      runtimeListener = fn
      return () => {
        runtimeListener = null
      }
    },
  },
}))
const setSessionError = jest.fn()
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => ({ setSessionError }) } }))

const consumed: unknown[] = []
const dispose = jest.fn(async () => undefined)
jest.mock("./agent-chat-turn-helpers", () => ({
  createExternalIdleEventConsumer: () =>
    Object.assign(
      async (event: unknown) => {
        consumed.push(event)
      },
      { dispose }
    ),
}))

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function context() {
  return {
    registry: {} as never,
    eventQueuesRef: { current: new Map<string, Promise<void>>() },
    externalTurnSettlementsRef: { current: new Map<string, Promise<void>>() },
    externalToolHostsRef: { current: new Map() },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  listeners.clear()
  consumed.length = 0
  runtime.sessionExternalLinks = { s1: { agentId: "codex", sessionId: "ext-1" } }
})

it("consumes a local link's out-of-band events, in order, and ignores the rest", async () => {
  const ctx = context()
  const teardown = subscribeExternalIdleEvents(ctx)
  await flush()
  const listener = listeners.get("codex")!

  listener({ type: "text", delivery: "out_of_band", sessionId: "ext-1" })
  listener({ type: "text", delivery: "in_band", sessionId: "ext-1" })
  listener({ type: "text", delivery: "out_of_band", sessionId: "other" })
  await ctx.eventQueuesRef.current.get("s1")
  expect(consumed).toHaveLength(1)

  teardown()
  expect(removeListener).toHaveBeenCalled()
  expect(dispose).toHaveBeenCalled()
})

it("drops a link that went away and pauses its idle tool host", async () => {
  const ctx = context()
  const pause = jest.fn(async () => undefined)
  ctx.externalToolHostsRef.current.set("s1", { host: { pause }, agentId: "codex" })
  subscribeExternalIdleEvents(ctx)
  await flush()

  runtime.sessionExternalLinks = {}
  runtimeListener?.()
  expect(removeListener).toHaveBeenCalled()
  expect(manager.setSessionHostFacts).toHaveBeenCalledWith("codex", "s1", null)
  expect(pause).toHaveBeenCalled()
})

it("keeps the tool host of a link whose owned turn is still settling", async () => {
  const ctx = context()
  const pause = jest.fn(async () => undefined)
  ctx.externalToolHostsRef.current.set("s1", { host: { pause }, agentId: "codex" })
  ctx.externalTurnSettlementsRef.current.set("s1", new Promise(() => undefined))
  subscribeExternalIdleEvents(ctx)
  await flush()

  runtime.sessionExternalLinks = {}
  runtimeListener?.()
  expect(pause).not.toHaveBeenCalled()
})

it("records a failing background event on the session", async () => {
  const ctx = context()
  subscribeExternalIdleEvents(ctx)
  await flush()
  consumed.push = () => {
    throw new Error("broken")
  }
  const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
  listeners.get("codex")!({ type: "text", delivery: "out_of_band", sessionId: "ext-1" })
  await ctx.eventQueuesRef.current.get("s1")
  expect(setSessionError).toHaveBeenCalledWith("s1", "broken")
  error.mockRestore()
})
