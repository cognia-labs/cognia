/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanRunSection } from "./plan-run-section"
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

jest.mock("./plan-tracker-panel", () => ({
  PlanTrackerPanel: () => <div data-testid="plan-tracker-panel" />,
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

const renderSection = (p: AgentPlan) => render(<PlanRunSection sessionId="ses" plan={p} />)

describe("PlanRunSection", () => {
  it("shows the tracker for any plan, controls only while it runs", () => {
    const { rerender } = renderSection(plan({ status: "completed" }))
    expect(screen.getByTestId("plan-tracker-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-tracker-cancel")).not.toBeInTheDocument()
    rerender(<PlanRunSection sessionId="ses" plan={plan({ status: "executing" })} />)
    expect(screen.getByTestId("plan-tracker-cancel")).toBeInTheDocument()
  })

  it("pauses an executing plan", async () => {
    renderSection(plan({ status: "executing" }))
    expect(screen.queryByTestId("plan-tracker-resume")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-tracker-pause"))
    await waitFor(() => expect(pausePlan).toHaveBeenCalledWith("p1"))
  })

  it("resumes a paused orchestrated plan through resumePlan", async () => {
    renderSection(plan({ status: "paused", executionMode: "orchestrated" }))
    expect(screen.queryByTestId("plan-tracker-pause")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-tracker-resume"))
    await waitFor(() => expect(resumePlan).toHaveBeenCalledWith("p1"))
    expect(continueInSessionPlan).not.toHaveBeenCalled()
  })

  it("resumes a paused in-session plan by sending the interrupted step's turn", async () => {
    continueInSessionPlan.mockResolvedValue({
      kind: "continue",
      stepId: "s0",
      stepTitle: "a",
      userMessage: "Step 1 of 1",
      generationId: "gen-2",
    })
    renderSection(
      plan({
        status: "paused",
        source: "manual",
        steps: [
          {
            id: "s0",
            title: "a",
            kind: "agent_turn",
            status: "in_progress",
            order: 0,
            dependencies: [],
          },
        ],
      })
    )
    await userEvent.click(screen.getByTestId("plan-tracker-resume"))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Step 1 of 1", undefined, {
        sessionId: "ses",
        skipUserAppend: true,
        throwOnError: true,
      })
    )
    expect(resumePlan).not.toHaveBeenCalled()
  })

  it("leaves a halted plan's decision to the composer card, offering only Cancel", async () => {
    renderSection(haltedPlan())
    expect(screen.getByText("tracker.haltedHint")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-tracker-resume")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plan-step-failure")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-tracker-cancel"))
    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith("p1"))
  })

  it("cannot resume an in-session plan without a chat runtime", () => {
    chatRuntime = null
    renderSection(
      plan({
        status: "paused",
        source: "manual",
        steps: [
          {
            id: "s0",
            title: "a",
            kind: "agent_turn",
            status: "pending",
            order: 0,
            dependencies: [],
          },
        ],
      })
    )
    expect(screen.getByTestId("plan-tracker-resume")).toBeDisabled()
  })

  it("shows a handed-off plan's status line with Mark done and Cancel", async () => {
    renderSection(
      plan({
        status: "executing",
        metadata: {
          chatHandoff: { prompt: "go", mode: "acceptEdits", startedAt: 1, bootId: "b" },
        },
      })
    )
    expect(screen.getByTestId("plan-handoff-summary")).toHaveTextContent("tracker.handoffRunning")
    expect(screen.queryByTestId("plan-tracker-panel")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plan-tracker-pause")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-tracker-mark-done"))
    await waitFor(() => expect(completeChatHandoff).toHaveBeenCalledWith("p1"))
  })
})
