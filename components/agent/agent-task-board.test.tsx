import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AgentTask } from "@/types/agent/agent-task"

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQueryMock(...args),
}))

// The shared KanbanBoard owns the DndContext; capture its handlers so a test
// can play a drag through it.
type DndProps = {
  children?: React.ReactNode
  onDragStart?: (event: { active: { id: string } }) => void
  onDragOver?: (event: { over: { id: string } | null }) => void
  onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void
}
let dndProps: DndProps = {}
jest.mock("@dnd-kit/core", () => ({
  DndContext: (props: DndProps) => {
    dndProps = props
    return <div>{props.children}</div>
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dnd-drag-overlay">{children}</div>
  ),
  KeyboardSensor: function KeyboardSensor() {},
  PointerSensor: function PointerSensor() {},
  closestCorners: jest.fn(),
  defaultDropAnimationSideEffects: jest.fn(() => jest.fn()),
  useSensor: jest.fn(() => ({})),
  useSensors: jest.fn(() => []),
  useDroppable: jest.fn(() => ({ setNodeRef: jest.fn(), isOver: false })),
}))
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: jest.fn(),
  verticalListSortingStrategy: jest.fn(),
  useSortable: jest.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const createAgentTaskMock = jest.fn()
const reorderAgentTasksMock = jest.fn()
const addCommentMock = jest.fn()
jest.mock("@/lib/db/agent-tasks", () => ({
  listAgentTasks: jest.fn(),
  listAgentTaskAttempts: jest.fn(),
  createAgentTask: (...args: unknown[]) => createAgentTaskMock(...args),
  reorderAgentTasks: (...args: unknown[]) => reorderAgentTasksMock(...args),
  addAgentTaskComment: (...args: unknown[]) => addCommentMock(...args),
}))
const runNowMock = jest.fn()
const ensureScheduleMock = jest.fn()
const applyMoveMock = jest.fn()
jest.mock("@/lib/agent-tasks/runtime", () => {
  class AgentTaskMoveDeniedError extends Error {
    constructor(readonly reason: string) {
      super(`Agent task move denied: ${reason}`)
    }
  }
  return {
    AgentTaskMoveDeniedError,
    applyAgentTaskMove: (...args: unknown[]) => applyMoveMock(...args),
    runAgentTaskNow: (...args: unknown[]) => runNowMock(...args),
    ensureAgentTaskSchedule: (...args: unknown[]) => ensureScheduleMock(...args),
    pauseAgentTask: jest.fn(),
    resumeAgentTask: jest.fn(),
    cancelAgentTask: jest.fn(),
  }
})
const skillSuggestionCardMock = jest.fn((..._args: unknown[]) => (
  <div data-testid="run-skill-suggestion" />
))
jest.mock("@/components/chat/skill-suggestion-card", () => ({
  SkillSuggestionCard: (props: unknown) => skillSuggestionCardMock(props),
}))

import { act } from "react"
import { toast } from "sonner"
import { AgentTaskMoveDeniedError } from "@/lib/agent-tasks/runtime"
import { AgentTaskBoard, AgentTaskCreateForm } from "./agent-task-board"

const baseTask: AgentTask = {
  id: "task-1",
  agentId: "agent-1",
  title: "Research",
  description: "Find sources",
  status: "pending",
  priority: "high",
  dependencies: [],
  tags: [],
  order: 0,
  approvalPolicy: "manual",
  latestAttemptNo: 0,
  comments: [],
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
}

beforeEach(() => {
  dndProps = {}
  jest.mocked(toast.error).mockClear()
  useLiveQueryMock.mockReset().mockReturnValue([])
  createAgentTaskMock.mockReset().mockResolvedValue(baseTask)
  reorderAgentTasksMock.mockReset().mockResolvedValue(undefined)
  applyMoveMock.mockReset().mockResolvedValue(undefined)
  addCommentMock.mockReset().mockResolvedValue(undefined)
  runNowMock.mockReset().mockResolvedValue(undefined)
  ensureScheduleMock.mockReset().mockResolvedValue("scheduled-1")
  skillSuggestionCardMock.mockClear()
})

it("creates an immediate durable task from the board form", async () => {
  render(<AgentTaskBoard agentId="agent-1" />)
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Research" } })
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Find sources" } })
  fireEvent.click(screen.getByRole("button", { name: "Add task" }))

  await waitFor(() =>
    expect(createAgentTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        title: "Research",
        description: "Find sources",
      })
    )
  )
  expect(ensureScheduleMock).not.toHaveBeenCalled()
})

it("starts a pending card through the shared Scheduler runtime", async () => {
  useLiveQueryMock.mockReturnValueOnce([baseTask]).mockReturnValueOnce([])
  render(<AgentTaskBoard agentId="agent-1" />)
  fireEvent.click(screen.getByRole("button", { name: "Start" }))
  await waitFor(() => expect(runNowMock).toHaveBeenCalledWith("task-1"))
})

/** Serve `tasks` to the board's live query and nothing to each card's attempts. */
function serveTasks(tasks: AgentTask[]) {
  useLiveQueryMock.mockImplementation((_query: unknown, deps: unknown[]) =>
    deps[0] === "agent-1" ? tasks : []
  )
}

it("moves a dropped card through the runtime that owns the Scheduler task", async () => {
  serveTasks([{ ...baseTask, status: "review" }])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  act(() => dndProps.onDragEnd?.({ active: { id: "task-1" }, over: { id: "col:completed" } }))
  await waitFor(() =>
    expect(applyMoveMock).toHaveBeenCalledWith("task-1", "completed", undefined, 0)
  )
})

it("records the verdict buttons through the same runtime entry", async () => {
  serveTasks([{ ...baseTask, status: "review" }])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Reject" }))
  await waitFor(() => expect(applyMoveMock).toHaveBeenCalledWith("task-1", "failed"))
})

it("refuses a drop the guard denies, naming why, without writing", () => {
  serveTasks([baseTask])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  act(() => dndProps.onDragEnd?.({ active: { id: "task-1" }, over: { id: "col:in_progress" } }))
  expect(toast.error).toHaveBeenCalledWith(
    "Only the running Agent can start a task or send it to review."
  )
  expect(applyMoveMock).not.toHaveBeenCalled()
})

it("names the guard's reason when the task moved on before the write", async () => {
  applyMoveMock.mockRejectedValueOnce(new AgentTaskMoveDeniedError("illegal-transition"))
  serveTasks([{ ...baseTask, status: "in_progress" }])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  act(() => dndProps.onDragEnd?.({ active: { id: "task-1" }, over: { id: "col:paused" } }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("A task can't move from that column to this one.")
  )
})

it("persists a reorder within a column", async () => {
  serveTasks([
    { ...baseTask, id: "a", order: 0 },
    { ...baseTask, id: "b", order: 1 },
  ])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  act(() => dndProps.onDragEnd?.({ active: { id: "b" }, over: { id: "a" } }))
  await waitFor(() =>
    expect(reorderAgentTasksMock).toHaveBeenCalledWith([
      { id: "b", order: 0 },
      { id: "a", order: 1 },
    ])
  )
})

it("greys out columns the dragged card may not enter and marks where it would land", () => {
  serveTasks([{ ...baseTask, status: "in_progress" }])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  act(() => dndProps.onDragStart?.({ active: { id: "task-1" } }))
  act(() => dndProps.onDragOver?.({ over: { id: "col:paused" } }))
  expect(screen.getByTestId("agent-task-column-review")).toHaveAttribute("data-dimmed", "true")
  expect(screen.getByTestId("agent-task-column-paused")).not.toHaveAttribute("data-dimmed")
  expect(screen.getByTestId("agent-task-drop-indicator-paused")).toBeInTheDocument()
  expect(screen.getByTestId("agent-task-overlay")).toHaveTextContent("Research")
})

it("offers successful run attempts to the Skill review flow", async () => {
  const completedAttempts = [
    {
      id: "attempt-1",
      taskId: "task-1",
      agentId: "agent-1",
      attemptNo: 1,
      status: "completed",
      result: "done",
    },
  ]
  useLiveQueryMock.mockImplementation((_query: unknown, deps: unknown[]) =>
    deps[0] === "agent-1" ? [{ ...baseTask, status: "completed" }] : completedAttempts
  )
  render(<AgentTaskBoard agentId="agent-1" />)
  fireEvent.click(screen.getByRole("button", { name: /attempts/ }))
  await waitFor(() => expect(screen.getByTestId("run-skill-suggestion")).toBeInTheDocument())
  expect(skillSuggestionCardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      source: { kind: "run", runId: "attempt-1" },
      outcome: expect.objectContaining({ completed: true }),
    })
  )
})

it("hands the created task to the host of the standalone form", async () => {
  const onCreated = jest.fn()
  render(<AgentTaskCreateForm agentId="agent-1" onCreated={onCreated} />)
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Research" } })
  fireEvent.click(screen.getByRole("button", { name: "Add task" }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(baseTask))
})

it("leaves the form out when the host opens it elsewhere", () => {
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  expect(screen.queryByTestId("agent-task-create-form")).not.toBeInTheDocument()
})

it("shows the host's empty state instead of its own panel when there are no tasks", () => {
  render(
    <AgentTaskBoard
      agentId="agent-1"
      showCreateForm={false}
      emptyState={<p data-testid="host-empty">nothing yet</p>}
    />
  )
  expect(screen.getByTestId("host-empty")).toBeInTheDocument()
  expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument()
})

it("draws a dense card: priority glyph, title, schedule and dependencies, run counters", () => {
  useLiveQueryMock.mockImplementation((_query: unknown, deps: unknown[]) =>
    deps[0] === "agent-1"
      ? [{ ...baseTask, scheduledFor: Date.UTC(2026, 0, 2), dependencies: ["task-0"] }]
      : []
  )
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  const card = screen.getByTestId("agent-task-task-1")
  expect(
    card.querySelector('[title="High"] [data-testid="issue-priority-icon-high"]')
  ).not.toBeNull()
  expect(card).toHaveTextContent("Research")
  expect(card).toHaveTextContent("Find sources")
  expect(card).toHaveTextContent("1 dependencies")
  const details = screen.getByRole("button", { name: "0 attempts · 0 comments" })
  expect(details).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(details)
  expect(details).toHaveAttribute("aria-expanded", "true")
})

it("heads each column with the tracker's status glyph and lets a host bound its height", () => {
  useLiveQueryMock.mockImplementation((_query: unknown, deps: unknown[]) =>
    deps[0] === "agent-1" ? [baseTask] : []
  )
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} className="flex-1" />)
  expect(screen.getByTestId("agent-task-board")).toHaveClass("flex-1", "min-h-0")
  const pending = screen.getByTestId("agent-task-column-pending")
  expect(pending.querySelector('[data-testid="issue-status-icon-backlog"]')).not.toBeNull()
  expect(screen.getByTestId("agent-task-column-review")).toHaveTextContent("No tasks")
})

it("reports any other write failure with the generic error toast", async () => {
  reorderAgentTasksMock.mockRejectedValueOnce(new Error("disk full"))
  serveTasks([
    { ...baseTask, id: "a", order: 0 },
    { ...baseTask, id: "b", order: 1 },
  ])
  render(<AgentTaskBoard agentId="agent-1" showCreateForm={false} />)
  act(() => dndProps.onDragEnd?.({ active: { id: "b" }, over: { id: "a" } }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Task action failed: disk full"))
})

it("shows its own empty panel when the host gives none", () => {
  render(<AgentTaskBoard agentId="agent-1" />)
  expect(screen.getByText("No tasks yet")).toBeInTheDocument()
  expect(screen.getByText("Add a task above to build this Agent's queue.")).toBeInTheDocument()
  expect(screen.queryByTestId("agent-task-columns")).not.toBeInTheDocument()
})
