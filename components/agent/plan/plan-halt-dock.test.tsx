/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanHaltDock } from "./plan-halt-dock"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const pausePlan = jest.fn().mockResolvedValue(null)
const resumePlan = jest.fn().mockResolvedValue(null)
const cancelPlan = jest.fn().mockResolvedValue(null)
const continueInSessionPlan = jest.fn()
const failInSessionStep = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({
    pausePlan,
    resumePlan,
    cancelPlan,
    continueInSessionPlan,
    failInSessionStep,
  }),
}))

const ensurePlanStepRecovery = jest.fn().mockResolvedValue(0)
jest.mock("@/lib/agent/plan/step-recovery", () => ({
  ensurePlanStepRecovery: () => ensurePlanStepRecovery(),
}))

jest.mock("@/lib/agent/plan/turn-driver", () => ({
  chatPlanStepHooks: (planId: string, sessionId: string) => ({
    hookContext: { agentRef: planId, sessionId },
  }),
}))

const send = jest.fn()
const stop = jest.fn().mockResolvedValue(undefined)
let chatRuntime: { send: jest.Mock; stop: jest.Mock } | null = { send, stop }
jest.mock("@/hooks/chat/use-claude-chat", () => ({
  useOptionalClaudeChat: () => chatRuntime,
}))

const chatSessions: Record<string, { status: string }> = {}
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ sessions: chatSessions }) },
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const mockPlan = jest.fn()
jest.mock("@/hooks/agent/use-session-plan", () => ({
  useSessionPlan: () => mockPlan(),
}))

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "exit_plan_mode",
    executionMode: "auto",
    steps: [],
    status: "executing",
    totalSteps: 0,
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
  send.mockResolvedValue(undefined)
  for (const key of Object.keys(chatSessions)) delete chatSessions[key]
})

/** A linear, in-session plan paused on its failed second step. */
function haltedPlan(over: Partial<AgentPlan> = {}): AgentPlan {
  return plan({
    source: "manual",
    status: "paused",
    steps: [
      { id: "s0", title: "a", kind: "agent_turn", status: "completed", order: 0, dependencies: [] },
      {
        id: "s1",
        title: "b",
        kind: "agent_turn",
        status: "failed",
        order: 1,
        dependencies: ["s0"],
        error: "boom",
      },
    ],
    stepHalt: { stepId: "s1", cause: "turn_failed", detail: "boom", at: 1 },
    ...over,
  })
}

describe("PlanHaltDock", () => {
  it("renders only for an in-session plan halted on a step", () => {
    mockPlan.mockReturnValue(undefined)
    const { rerender, container } = render(<PlanHaltDock sessionId="ses" />)
    expect(container).toBeEmptyDOMElement()
    for (const p of [plan({ status: "executing" }), plan({ status: "paused" })]) {
      mockPlan.mockReturnValue(p)
      rerender(<PlanHaltDock sessionId="ses" />)
      expect(screen.queryByTestId("plan-halt-dock")).not.toBeInTheDocument()
    }
    mockPlan.mockReturnValue(haltedPlan())
    rerender(<PlanHaltDock sessionId="ses" />)
    expect(screen.getByTestId("plan-step-failure")).toBeInTheDocument()
  })

  it("runs the once-per-load orphan recovery on mount", () => {
    mockPlan.mockReturnValue(undefined)
    render(<PlanHaltDock sessionId="ses" />)
    expect(ensurePlanStepRecovery).toHaveBeenCalledTimes(1)
  })

  describe("halted in-session plan", () => {
    it.each([
      ["plan-step-retry", "retry"],
      ["plan-step-skip", "skip"],
      ["plan-step-mark-done", "complete"],
    ] as const)("%s continues the plan with %s and sends the next turn", async (testId, action) => {
      continueInSessionPlan.mockResolvedValue({
        kind: "continue",
        stepId: "s1",
        stepTitle: "b",
        userMessage: "Step 2 of 2",
        generationId: "gen-3",
      })
      mockPlan.mockReturnValue(haltedPlan())
      render(<PlanHaltDock sessionId="ses" />)
      await userEvent.click(screen.getByTestId(testId))
      await waitFor(() => expect(send).toHaveBeenCalled())
      expect(continueInSessionPlan).toHaveBeenCalledWith("p1", action, expect.any(Object))
    })

    it("stops the stalled turn still holding the session before retrying", async () => {
      chatSessions.ses = { status: "streaming" }
      const order: string[] = []
      stop.mockImplementation(async () => {
        order.push("stop")
      })
      continueInSessionPlan.mockImplementation(async () => {
        order.push("continue")
        return { kind: "noop", reason: "x" }
      })
      mockPlan.mockReturnValue(
        haltedPlan({ stepHalt: { stepId: "s1", cause: "silent", detail: "", at: 1 } })
      )
      render(<PlanHaltDock sessionId="ses" />)
      await userEvent.click(screen.getByTestId("plan-step-retry"))
      await waitFor(() => expect(order).toEqual(["stop", "continue"]))
      expect(stop).toHaveBeenCalledWith("ses")
      expect(send).not.toHaveBeenCalled()
    })

    it("halts the step again when the retried turn is refused", async () => {
      continueInSessionPlan.mockResolvedValue({
        kind: "continue",
        stepId: "s1",
        stepTitle: "b",
        userMessage: "Step 2 of 2",
        generationId: "gen-4",
      })
      send.mockRejectedValue(new Error("concurrent_stream_cap_reached"))
      mockPlan.mockReturnValue(haltedPlan())
      render(<PlanHaltDock sessionId="ses" />)
      await userEvent.click(screen.getByTestId("plan-step-retry"))
      await waitFor(() =>
        expect(failInSessionStep).toHaveBeenCalledWith("p1", {
          stepId: "s1",
          cause: "dispatch_failed",
          detail: "concurrent_stream_cap_reached",
          capturedGenerationId: "gen-4",
        })
      )
    })

    it("cancels from the card", async () => {
      mockPlan.mockReturnValue(haltedPlan())
      render(<PlanHaltDock sessionId="ses" />)
      await userEvent.click(screen.getByTestId("plan-step-cancel"))
      await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith("p1"))
    })

    it("toasts when the runtime cannot continue", async () => {
      continueInSessionPlan.mockRejectedValue(new Error("db down"))
      mockPlan.mockReturnValue(haltedPlan())
      render(<PlanHaltDock sessionId="ses" />)
      await userEvent.click(screen.getByTestId("plan-step-retry"))
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("stepFailure.actionFailed"))
    })

    it("cannot dispatch without a chat runtime, but can still cancel", () => {
      chatRuntime = null
      mockPlan.mockReturnValue(haltedPlan())
      render(<PlanHaltDock sessionId="ses" />)
      expect(screen.getByTestId("plan-step-retry")).toBeDisabled()
      expect(screen.getByTestId("plan-step-cancel")).toBeEnabled()
    })
  })
})
