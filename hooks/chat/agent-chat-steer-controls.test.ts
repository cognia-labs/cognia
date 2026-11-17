import type { useChatStore } from "@/stores/chat"
import { steerArmed } from "@/lib/chat/steer-runtime"
import { flushChatSteer, interruptChatTurnAndSteer } from "./agent-chat-steer-controls"

const drainSteerVia = jest.fn()
jest.mock("./agent-chat-events", () => ({
  drainSteerVia: (...args: unknown[]) => drainSteerVia(...args),
}))

const enqueueHostStateIntentIfAvailable = jest.fn(async (..._args: unknown[]) => false)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...args: unknown[]) =>
    enqueueHostStateIntentIfAvailable(...args),
}))

const cancelRouterFusionTurn = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/router-fusion/gate/chat-events", () => ({
  cancelRouterFusionTurn: (...args: unknown[]) => cancelRouterFusionTurn(...args),
}))

const fusionChatTurnActive = jest.fn((..._args: unknown[]) => false)
const stopFusionChatTurn = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./router-fusion-chat-turn", () => ({
  fusionChatTurnActive: (...args: unknown[]) => fusionChatTurnActive(...args),
  stopFusionChatTurn: (...args: unknown[]) => stopFusionChatTurn(...args),
}))

let queue: unknown[] = []
const setSessionDiagnostic = jest.fn()
jest.mock("@/stores/chat/chat-store", () => {
  const actual = jest.requireActual("@/stores/chat/chat-store")
  return {
    ...actual,
    useChatStore: Object.assign(() => undefined, {
      getState: () => ({ activeSessionId: "chat", sessions: { chat: { steerQueue: queue } } }),
    }),
  }
})

function context(overrides: Record<string, unknown> = {}) {
  return {
    store: { getState: () => ({ setSessionDiagnostic }) } as unknown as typeof useChatStore,
    refuseCapturedTurn: jest.fn(() => false),
    sendRef: { current: jest.fn() },
    externalGatewayAbortRef: { current: new Map<string, AbortController>() },
    hostStateTurnsRef: { current: new Set<string>() },
    abortRunningTurn: jest.fn(async () => undefined),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  fusionChatTurnActive.mockReturnValue(false)
  enqueueHostStateIntentIfAvailable.mockResolvedValue(false)
  steerArmed.clear()
  queue = []
})

it("does nothing when no steer is queued", async () => {
  const ctx = context()
  await interruptChatTurnAndSteer(ctx, "chat")
  expect(ctx.abortRunningTurn).not.toHaveBeenCalled()
  expect(steerArmed.has("chat")).toBe(false)
})

it("arms the steer and cuts the turn short through Stop's dispatch", async () => {
  queue = [{ id: "s1" }]
  enqueueHostStateIntentIfAvailable.mockResolvedValue(true)
  const ctx = context()

  await interruptChatTurnAndSteer(ctx, "chat")

  expect(steerArmed.has("chat")).toBe(true)
  expect(enqueueHostStateIntentIfAvailable).toHaveBeenCalledWith({
    sessionId: "chat",
    action: { kind: "turn.abort" },
  })
  expect(ctx.hostStateTurnsRef.current.has("chat")).toBe(true)
  expect(ctx.abortRunningTurn).toHaveBeenCalledWith("chat", true)
  expect(cancelRouterFusionTurn).toHaveBeenCalledWith("chat")
})

it("stops a verified fusion turn instead of aborting a runtime", async () => {
  queue = [{ id: "s1" }]
  fusionChatTurnActive.mockReturnValue(true)
  const ctx = context()

  await interruptChatTurnAndSteer(ctx, "chat")

  expect(stopFusionChatTurn).toHaveBeenCalled()
  expect(ctx.abortRunningTurn).not.toHaveBeenCalled()
})

it("disarms and reports when the interrupt fails", async () => {
  queue = [{ id: "s1" }]
  const ctx = context({ abortRunningTurn: jest.fn(async () => Promise.reject(new Error("boom"))) })
  jest.spyOn(console, "error").mockImplementation(() => undefined)

  await interruptChatTurnAndSteer(ctx, "chat")

  expect(steerArmed.has("chat")).toBe(false)
  expect(setSessionDiagnostic).toHaveBeenCalledWith("chat", expect.anything())
})

it("refuses both controls on a turn another surface captured", async () => {
  queue = [{ id: "s1" }]
  const ctx = context({ refuseCapturedTurn: jest.fn(() => true) })

  await interruptChatTurnAndSteer(ctx, "chat")
  flushChatSteer(ctx, "chat")

  expect(ctx.abortRunningTurn).not.toHaveBeenCalled()
  expect(drainSteerVia).not.toHaveBeenCalled()
})

it("drains the queue through the send ref on flush", () => {
  const ctx = context()
  flushChatSteer(ctx, "chat")
  expect(drainSteerVia).toHaveBeenCalledWith("chat", ctx.sendRef)
})
