/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { DEFAULT_PLAN_CONFIG, type AgentPlan } from "@/types/agent/plan"

import { findCapturedPlan, PlanCard } from "./plan-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockPlans: AgentPlan[] = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockPlans }))
jest.mock("@/lib/db/plans", () => ({ listPlansBySession: jest.fn() }))
jest.mock("@/components/agent/plan/plan-document", () => ({
  PlanDocument: ({ plan }: { plan: AgentPlan }) => (
    <div data-testid="plan-doc">{String((plan.metadata as { planText: string }).planText)}</div>
  ),
}))
const revealSessionPanel = jest.fn()
jest.mock("@/lib/artifacts/reveal", () => ({
  revealSessionPanel: (...a: unknown[]) => revealSessionPanel(...a),
}))

const part = (input?: unknown, toolCallId = "call"): ToolUIPart =>
  ({
    type: "tool-ExitPlanMode",
    toolCallId,
    state: "output-available",
    input,
  }) as unknown as ToolUIPart

function stored(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "s1",
    title: "Stored title",
    source: "exit_plan_mode",
    executionMode: "auto",
    steps: [],
    status: "executing",
    totalSteps: 3,
    completedSteps: 1,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  mockPlans = []
  revealSessionPanel.mockClear()
})

describe("PlanCard", () => {
  it("is one line with the plan's title, its body one click away", () => {
    render(<PlanCard part={part({ plan: "# Ship it\n\n- step one" })} sessionId="s1" />)
    expect(screen.getByTestId("mcp-plan-toggle")).toHaveTextContent("Ship it")
    expect(screen.queryByTestId("plan-doc")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mcp-plan-toggle"))
    // The proposal as the tool carried it, capped and scrolling in the card.
    expect(screen.getByTestId("plan-doc")).toHaveTextContent("step one")
    expect(screen.getByTestId("mcp-plan-body").className).toContain("max-h-80")
  })

  it("shows where the captured plan stands and opens the Tasks panel", () => {
    mockPlans = [stored({ metadata: { toolUseId: "call", planText: "edited later" } })]
    render(<PlanCard part={part({ plan: "Plan body" })} sessionId="s1" />)
    expect(screen.getByTestId("mcp-plan-status")).toHaveTextContent("status.executing")
    expect(screen.getByTestId("mcp-plan-card")).toHaveTextContent('composer.stepCount:{"count":3}')
    // No H1 in the body: the stored plan names it.
    expect(screen.getByTestId("mcp-plan-toggle")).toHaveTextContent("Stored title")
    fireEvent.click(screen.getByTestId("mcp-plan-open-panel"))
    expect(revealSessionPanel).toHaveBeenCalledWith("s1", "plan")
  })

  it("offers no panel link without a captured plan or a session", () => {
    render(<PlanCard part={part({ plan: "Body only" })} />)
    expect(screen.queryByTestId("mcp-plan-open-panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("mcp-plan-toggle")).toHaveTextContent("card.untitled")
  })

  it("renders nothing for an empty or missing plan", () => {
    expect(render(<PlanCard part={part({ plan: "   \n  " })} />).container).toBeEmptyDOMElement()
    expect(render(<PlanCard part={part({})} />).container).toBeEmptyDOMElement()
    expect(render(<PlanCard part={part({ plan: 42 })} />).container).toBeEmptyDOMElement()
    expect(render(<PlanCard part={part(undefined)} />).container).toBeEmptyDOMElement()
  })
})

describe("findCapturedPlan", () => {
  it("matches by tool call id first, then by body", () => {
    const byId = stored({ id: "a", metadata: { toolUseId: "t1" } })
    const byText = stored({ id: "b", metadata: { planText: "  same body " } })
    expect(findCapturedPlan([byText, byId], "t1", "same body")?.id).toBe("a")
    expect(findCapturedPlan([byText], "other", "same body")?.id).toBe("b")
    expect(findCapturedPlan([byText], "other", "different")).toBeUndefined()
    expect(findCapturedPlan(undefined, "t1", "x")).toBeUndefined()
  })
})
