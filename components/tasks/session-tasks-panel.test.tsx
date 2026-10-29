/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

import type { SessionTasksView } from "@/hooks/chat/use-session-tasks"
import { summarizeTasks, type TaskViewItem } from "@/lib/tasks/task-view"
import { usePlanDecisionStore } from "@/stores/agent/plan-decision-store"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

import { SessionTasksPanel } from "./session-tasks-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockPlans: AgentPlan[] | undefined = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown, deps: unknown[]) =>
    // The plan list query has [sessionId]; the event query [open, planId].
    deps.length === 1 ? mockPlans : [],
}))
jest.mock("@/lib/db/plans", () => ({
  listPlansBySession: jest.fn(),
  listPlanEvents: jest.fn(),
}))
let mockTasks: SessionTasksView | null = null
jest.mock("@/hooks/chat/use-session-tasks", () => ({ useSessionTasks: () => mockTasks }))
const jumpToSessionMessage = jest.fn()
jest.mock("@/lib/chat/cross-session-jump", () => ({
  jumpToSessionMessage: (...a: unknown[]) => jumpToSessionMessage(...a),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: {} }),
}))
const applyPlanEditPatch = jest.fn()
jest.mock("@/lib/agent/plan/draft-edit", () => ({
  applyPlanEditPatch: (...a: unknown[]) => applyPlanEditPatch(...a),
}))
jest.mock("@/components/agent/plan/plan-approval-card", () => ({
  PlanApprovalCard: (props: {
    fill?: boolean
    disabled?: boolean
    onApprove: (m: string) => void
  }) => (
    <button
      data-testid="approval-card"
      data-fill={String(props.fill)}
      disabled={props.disabled}
      onClick={() => props.onApprove("acceptEdits")}
    />
  ),
}))
jest.mock("@/components/agent/plan/plan-document", () => ({
  PlanDocument: (props: { plan: AgentPlan; editable?: boolean; events?: unknown[] }) => (
    <div
      data-testid="plan-doc"
      data-plan={props.plan.id}
      data-editable={String(Boolean(props.editable))}
      data-events={props.events ? "yes" : "no"}
    />
  ),
}))
jest.mock("@/components/agent/plan/plan-run-section", () => ({
  PlanRunSection: ({ plan }: { plan: AgentPlan }) => (
    <div data-testid="run-section" data-plan={plan.id} />
  ),
}))
jest.mock("@/components/agent/plan/write-plan-button", () => ({
  WritePlanButton: () => <button data-testid="write-plan" />,
}))

function plan(id: string, over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id,
    sessionId: "s1",
    title: `Plan ${id}`,
    source: "exit_plan_mode",
    executionMode: "auto",
    steps: [],
    status: "completed",
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

function tasks(items: TaskViewItem[], extra: Partial<SessionTasksView> = {}): SessionTasksView {
  return {
    family: "todo",
    items,
    progress: summarizeTasks(items),
    running: true,
    finished: false,
    stopped: false,
    lastToolCallId: "c",
    lastMessageId: "m9",
    ...extra,
  }
}

beforeEach(() => {
  mockPlans = []
  mockTasks = null
  jest.clearAllMocks()
  usePlanDecisionStore.setState({ owners: {} })
})

describe("SessionTasksPanel", () => {
  it("renders nothing while plans are loading", () => {
    mockPlans = undefined
    const { container } = render(<SessionTasksPanel sessionId="s1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("offers to write a plan when there is nothing yet", () => {
    render(<SessionTasksPanel sessionId="s1" />)
    expect(screen.getByTestId("session-tasks-empty")).toBeInTheDocument()
    expect(screen.getByTestId("write-plan")).toBeInTheDocument()
  })

  it("shows the current task list with its progress and a way back to the conversation", () => {
    mockTasks = tasks([
      { id: "1", title: "a", status: "completed" },
      { id: "2", title: "b", status: "in_progress" },
    ])
    render(<SessionTasksPanel sessionId="s1" />)
    const section = screen.getByTestId("session-tasks-current")
    expect(section).toHaveTextContent("currentTitle")
    expect(section).toHaveTextContent('progress:{"done":1,"total":2}')
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    expect(screen.getAllByTestId("task-list-item")).toHaveLength(2)
    fireEvent.click(screen.getByTestId("session-tasks-locate"))
    expect(jumpToSessionMessage).toHaveBeenCalledWith("s1", "m9")
    expect(screen.queryByTestId("session-tasks-empty")).not.toBeInTheDocument()
  })

  it("marks a stopped list", () => {
    mockTasks = tasks([{ id: "1", title: "a", status: "stopped" }], {
      stopped: true,
      running: false,
    })
    render(<SessionTasksPanel sessionId="s1" />)
    expect(screen.getByTestId("session-tasks-current")).toHaveTextContent("status.stopped")
  })

  it("folds a finished list into last tasks until expanded", () => {
    mockTasks = tasks([{ id: "1", title: "a", status: "completed" }], { finished: true })
    render(<SessionTasksPanel sessionId="s1" />)
    const toggle = screen.getByTestId("session-tasks-last-toggle")
    expect(toggle).toHaveTextContent('lastTitle:{"count":1}')
    expect(screen.queryByTestId("task-list-item")).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getAllByTestId("task-list-item")).toHaveLength(1)
  })

  it("puts a plan awaiting approval on the decision owner's handlers", () => {
    mockPlans = [plan("p1", { status: "awaiting_approval" })]
    const approve = jest.fn()
    act(() => {
      usePlanDecisionStore.getState().register("s1", {
        planId: "p1",
        approve,
        keepPlanning: jest.fn(),
        reject: jest.fn(),
        refine: jest.fn(),
        edit: jest.fn(),
        openEditor: jest.fn(),
      })
      usePlanDecisionStore.getState().setPending("s1", { busy: true, refining: false })
    })
    render(<SessionTasksPanel sessionId="s1" />)
    const card = screen.getByTestId("approval-card")
    expect(card).toHaveAttribute("data-fill", "true")
    expect(card).toBeDisabled()
    act(() => usePlanDecisionStore.getState().setPending("s1", { busy: false, refining: false }))
    fireEvent.click(screen.getByTestId("approval-card"))
    expect(approve).toHaveBeenCalledWith("acceptEdits")
  })

  it("keeps an awaiting plan editable but undecidable without an owner", () => {
    mockPlans = [plan("p1", { status: "awaiting_approval" })]
    render(<SessionTasksPanel sessionId="s1" />)
    expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument()
    expect(screen.getByText("decisionsElsewhere")).toBeInTheDocument()
    expect(screen.getByTestId("plan-doc")).toHaveAttribute("data-editable", "true")
  })

  it("shows a running plan's tracker, with its document one click away", () => {
    mockPlans = [plan("p2", { status: "executing" }), plan("p1")]
    render(<SessionTasksPanel sessionId="s1" />)
    expect(screen.getByTestId("run-section")).toHaveAttribute("data-plan", "p2")
    expect(screen.queryByTestId("plan-doc")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("session-tasks-plan-document-toggle"))
    expect(screen.getByTestId("plan-doc")).toHaveAttribute("data-plan", "p2")
  })

  it("lists earlier plans that expand to their document and trail", () => {
    mockPlans = [plan("p2", { status: "executing" }), plan("p1", { status: "rejected" })]
    render(<SessionTasksPanel sessionId="s1" />)
    const history = screen.getByTestId("session-tasks-history")
    expect(history).toHaveTextContent("Plan p1")
    expect(history).toHaveTextContent("status.rejected")
    fireEvent.click(screen.getByText("Plan p1"))
    const docs = screen.getAllByTestId("plan-doc")
    expect(docs.at(-1)).toHaveAttribute("data-plan", "p1")
    expect(docs.at(-1)).toHaveAttribute("data-events", "yes")
  })
})
