/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { ClaudeEvent } from "@cognia/agent-config-types"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { handleEvent } from "@/hooks/chat/agent-chat-events"
import { SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { useChatStore } from "@/stores/chat"

// A turn whose `result` frame is not a finished turn — a provider failure, a
// partial reply that then failed, a step ceiling — must not settle as
// completed, fire the success hooks or advance the in-session plan. Driven
// through the real event handler and the real plan driver (`plan-turn-settle`).

const mockSettle = jest.fn(
  async (_sessionId: string, _input: { outcome: string; errorCode?: string }) => false
)
const mockFinishRun = jest.fn(
  async (_sessionId: string, _status: string, _ts?: number, _summary?: string) => {}
)
const mockPostReceive = jest.fn(async (..._args: unknown[]) => {})
const mockFinishPlan = jest.fn(async (..._args: unknown[]) => {})
let mockPlan: AgentPlan

jest.mock("@/lib/db/plans", () => ({
  getPlan: async () => mockPlan,
  updatePlan: async (_id: string, patch: Partial<AgentPlan>) => {
    mockPlan = { ...mockPlan, ...patch }
  },
  appendPlanEvent: async () => {},
}))
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({
    getExecutingPlanForSession: async () => mockPlan,
    registerAbortController: () => () => {},
    finishPlanRun: (...args: never[]) => mockFinishPlan(...args),
  }),
}))
jest.mock("@/lib/agent/plan/notify", () => ({ emitPlanStatus: async () => {} }))
jest.mock("@/lib/agent/plan/step-watchdog", () => ({ disarmPlanStepWatch() {} }))
jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  listMessages: async () => [],
  persistMessages: async () => {},
  commitMessageDelta: async () => {},
}))
jest.mock("@/lib/db/sessions", () => ({
  ...jest.requireActual("@/lib/db/sessions"),
  getSession: async () => undefined,
}))
jest.mock("@/lib/plugin/messaging/agent-hook-dispatch", () => ({
  ...jest.requireActual("@/lib/plugin/messaging/agent-hook-dispatch"),
  dispatchPostChatReceive: (...args: never[]) => mockPostReceive(...args),
  dispatchOnAssistantMessage: async () => undefined,
}))
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ getActiveGoalForSession: async () => undefined }),
}))
jest.mock("@/lib/loop/runtime", () => ({
  getLoopRuntime: () => ({ getActiveLoopForSession: async () => undefined }),
}))
jest.mock("@/hooks/chat/agent-chat-turn-tasks", () => ({
  ...jest.requireActual("@/hooks/chat/agent-chat-turn-tasks"),
  runMemoryTasks: jest.fn(),
  runUtilityModelTasks: jest.fn(),
}))
jest.mock("@/lib/work-submission/chat-adapter", () => ({
  ...jest.requireActual("@/lib/work-submission/chat-adapter"),
  settleChatTurnForSession: (...args: [string, { outcome: string }]) => mockSettle(...args),
}))
jest.mock("@/lib/execution/direct-chat-run", () => ({
  finishDirectChatExecutionRun: (...args: [string, string, number?, string?]) =>
    mockFinishRun(...args),
  projectDirectChatSdkMessage: async () => {},
}))
jest.mock("@/lib/claude/routing-fallback", () => ({ attemptRoutingFallback: async () => false }))

const sessionId = "turn-outcome-session"
const turnId = "turn-outcome-turn"

function setup() {
  jest.clearAllMocks()
  mockPlan = {
    id: "plan-1",
    sessionId,
    title: "Fixture plan",
    source: "manual",
    executionMode: "in_session",
    status: "executing",
    completedSteps: 0,
    totalSteps: 1,
    currentStepId: "s1",
    generationId: "g1",
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    createdAt: 10,
    updatedAt: 20,
    steps: [
      {
        id: "s1",
        kind: "agent_turn",
        title: "Verify all fixture rows",
        order: 0,
        dependencies: [],
        status: "in_progress",
      },
    ],
  }
  const store = useChatStore.getState()
  store.clear()
  store.setActiveSession(sessionId)
  store.setSessionStatus(sessionId, "streaming")
  store.replaceSessionMessages(sessionId, [
    {
      id: "fixture-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "Only one row was checked." }],
    },
  ])
  store.setLastSend(sessionId, { content: "Check all rows", options: { turnId }, attemptIndex: 0 })
  const registry = new SessionCoalescingRegistry({
    onCommit: (id, messages) => useChatStore.getState().replaceSessionMessages(id, messages),
    onPersist: async () => {},
    persistDelayMs: 0,
  })
  const coalescing = {
    messagesMirrorRef: { current: new Map() },
    registry,
    getExecutionHandle: () => undefined,
  }
  const handle = (event: ClaudeEvent) =>
    handleEvent(
      event,
      { current: sessionId },
      { current: [] },
      { current: new Map() },
      { current: new Map() },
      { current: null },
      coalescing
    )
  return { handle, registry }
}

afterEach(() => useChatStore.getState().clear())

it.each([
  [
    "a Claude 404 result",
    { subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 404 },
    "HTTP 404: fixture failed",
  ],
  [
    "an AI SDK reply that failed after partial output",
    { subtype: "error_during_execution", is_error: true },
    "socket hang up",
  ],
] as const)("%s is settled once, as failed, by its end", async (_name, result, error) => {
  const { handle, registry } = setup()
  try {
    await handle({
      type: "event",
      sessionId,
      turnId,
      event: { type: "result", ...result },
    } as ClaudeEvent)
    expect(mockSettle).not.toHaveBeenCalled()
    expect(mockPostReceive).not.toHaveBeenCalled()
    expect(mockPlan.steps[0]?.status).toBe("in_progress")

    await handle({
      type: "session_ended",
      sessionId,
      turnId,
      error,
      result: { type: "result", ...result },
    } as ClaudeEvent)
    expect(mockSettle.mock.calls.map(([, input]) => input.outcome)).toEqual(["failed"])
    expect(mockFinishRun).toHaveBeenCalledWith(sessionId, "failed", expect.any(Number), error)
    expect(mockPlan.steps[0]?.status).toBe("in_progress")
    expect(mockFinishPlan).not.toHaveBeenCalled()
  } finally {
    registry.clear()
  }
})

it("a step ceiling keeps its partial reply but settles the turn as failed", async () => {
  const { handle, registry } = setup()
  const capped = { type: "result", subtype: "error_max_turns", is_error: true }
  try {
    await handle({ type: "event", sessionId, turnId, event: capped } as ClaudeEvent)
    expect(mockSettle).not.toHaveBeenCalled()
    expect(mockPostReceive).not.toHaveBeenCalled()
    expect(mockPlan.steps[0]?.status).toBe("in_progress")

    await handle({ type: "session_ended", sessionId, turnId, result: capped } as ClaudeEvent)
    expect(mockSettle.mock.calls.map(([, input]) => input)).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "error_max_turns" }),
    ])
    expect(mockFinishRun).toHaveBeenCalledWith(
      sessionId,
      "failed",
      expect.any(Number),
      "error_max_turns"
    )
    expect(mockPlan.steps[0]?.status).toBe("in_progress")
    expect(useChatStore.getState().sessions[sessionId]?.status).toBe("idle")
    expect(
      useChatStore
        .getState()
        .sessions[sessionId]?.messages.some((message) => message.id === "fixture-assistant")
    ).toBe(true)
  } finally {
    registry.clear()
  }
})

it("a Stop settles the turn as cancelled", async () => {
  const { handle, registry } = setup()
  try {
    await handle({ type: "session_ended", sessionId, turnId, interrupted: true } as ClaudeEvent)
    expect(mockSettle.mock.calls.map(([, input]) => input.outcome)).toEqual(["cancelled"])
    expect(mockFinishRun).toHaveBeenCalledWith(
      sessionId,
      "cancelled",
      expect.any(Number),
      "interrupted"
    )
  } finally {
    registry.clear()
  }
})

it("a finished turn still completes the plan step and fires the success hooks", async () => {
  const { handle, registry } = setup()
  try {
    await handle({
      type: "event",
      sessionId,
      turnId,
      event: { type: "result", subtype: "success", is_error: false, terminal_reason: "completed" },
    } as unknown as ClaudeEvent)
    expect(mockSettle.mock.calls.map(([, input]) => input.outcome)).toContain("completed")
    expect(mockPostReceive).toHaveBeenCalledTimes(1)
    expect(mockPlan.steps[0]?.status).toBe("completed")
    expect(mockFinishPlan).toHaveBeenCalledWith("plan-1", "completed", "every plan step completed")
  } finally {
    registry.clear()
  }
})
