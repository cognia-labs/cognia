/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

import { usePlanRunControls } from "./use-plan-run-controls"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const pausePlan = jest.fn().mockResolvedValue(null)
const resumePlan = jest.fn().mockResolvedValue(null)
const cancelPlan = jest.fn().mockResolvedValue(null)
const continueInSessionPlan = jest.fn()
const failInSessionStep = jest.fn().mockResolvedValue(null)
const completeChatHandoff = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({
    pausePlan,
    resumePlan,
    cancelPlan,
    continueInSessionPlan,
    failInSessionStep,
    completeChatHandoff,
  }),
}))
jest.mock("@/lib/agent/plan/turn-driver", () => ({
  chatPlanStepHooks: () => ({}),
}))
const send = jest.fn().mockResolvedValue(undefined)
const stop = jest.fn().mockResolvedValue(undefined)
let chatRuntime: { send: jest.Mock; stop: jest.Mock } | null = { send, stop }
jest.mock("@/hooks/chat/use-claude-chat", () => ({
  useOptionalClaudeChat: () => chatRuntime,
}))
const sessions: Record<string, { status: string }> = {}
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ sessions }) },
}))
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const step = (id: string, status: string) =>
  ({ id, title: id, kind: "agent_turn", status, order: 0, dependencies: [] }) as never

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Plan",
    source: "manual",
    executionMode: "auto",
    steps: [step("s0", "in_progress")],
    status: "executing",
    totalSteps: 1,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  chatRuntime = { send, stop }
  for (const key of Object.keys(sessions)) delete sessions[key]
})

describe("usePlanRunControls", () => {
  it("reads the strategy, halt and dispatch capability", () => {
    const halted = plan({
      status: "paused",
      stepHalt: { stepId: "s0", cause: "silent", detail: "", at: 1 },
    })
    const { result, rerender } = renderHook(({ p }) => usePlanRunControls("ses", p), {
      initialProps: { p: halted as AgentPlan | undefined },
    })
    expect(result.current).toMatchObject({ inSession: true, canDispatch: true })
    expect(result.current.halt?.cause).toBe("silent")
    rerender({ p: plan({ executionMode: "orchestrated" }) })
    expect(result.current).toMatchObject({ inSession: false, halt: undefined })
    rerender({ p: undefined })
    expect(result.current.inSession).toBe(false)
  })

  it("pauses and cancels through the runtime", async () => {
    const { result } = renderHook(() => usePlanRunControls("ses", plan()))
    act(() => result.current.pause())
    await waitFor(() => expect(pausePlan).toHaveBeenCalledWith("p1"))
    await waitFor(() => expect(result.current.busy).toBe(false))
    act(() => result.current.cancel())
    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith("p1"))
  })

  it("resumes an orchestrated plan through resumePlan", async () => {
    const { result } = renderHook(() =>
      usePlanRunControls("ses", plan({ status: "paused", executionMode: "orchestrated" }))
    )
    act(() => result.current.resume())
    await waitFor(() => expect(resumePlan).toHaveBeenCalledWith("p1"))
  })

  it("stops a stalled turn before continuing a halted plan", async () => {
    sessions.ses = { status: "streaming" }
    continueInSessionPlan.mockResolvedValue({
      kind: "continue",
      stepId: "s0",
      stepTitle: "s0",
      userMessage: "go",
      generationId: "g2",
    })
    const { result } = renderHook(() =>
      usePlanRunControls(
        "ses",
        plan({ status: "paused", stepHalt: { stepId: "s0", cause: "silent", detail: "", at: 1 } })
      )
    )
    act(() => result.current.continueWith("retry"))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(stop).toHaveBeenCalledWith("ses")
  })

  it("toasts when an action fails", async () => {
    pausePlan.mockRejectedValueOnce(new Error("db"))
    const { result } = renderHook(() => usePlanRunControls("ses", plan()))
    act(() => result.current.pause())
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("stepFailure.actionFailed"))
  })

  it("cancelling a handed-off plan stops the turn working on it", async () => {
    sessions.ses = { status: "streaming" }
    const handedOff = plan({
      executionMode: "orchestrated",
      metadata: { chatHandoff: { prompt: "go", mode: "default", startedAt: 1, bootId: "b" } },
    })
    const { result } = renderHook(() => usePlanRunControls("ses", handedOff))
    expect(result.current.handoff).toBe(true)
    act(() => result.current.cancel())
    await waitFor(() => expect(stop).toHaveBeenCalledWith("ses"))
    expect(cancelPlan).toHaveBeenCalledWith("p1")
    await waitFor(() => expect(result.current.busy).toBe(false))
    act(() => result.current.markDone())
    await waitFor(() => expect(completeChatHandoff).toHaveBeenCalledWith("p1"))
  })
})
