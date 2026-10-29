/**
 * @jest-environment jsdom
 */
import { fireEvent, render, renderHook, screen } from "@testing-library/react"

import type { SessionTasksView } from "@/hooks/chat/use-session-tasks"
import { summarizeTasks, type TaskViewItem } from "@/lib/tasks/task-view"
import type { AgentPlan } from "@/types/agent/plan"

import { TaskProgressChip, useSessionTaskChip } from "./task-progress-chip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockPlan: Partial<AgentPlan> | undefined
jest.mock("@/hooks/agent/use-session-plan", () => ({ useSessionPlan: () => mockPlan }))
let mockTasks: SessionTasksView | null = null
jest.mock("@/hooks/chat/use-session-tasks", () => ({ useSessionTasks: () => mockTasks }))
const revealSessionPanel = jest.fn()
jest.mock("@/lib/artifacts/reveal", () => ({
  revealSessionPanel: (...a: unknown[]) => revealSessionPanel(...a),
}))

function tasks(items: TaskViewItem[], extra: Partial<SessionTasksView> = {}): SessionTasksView {
  return {
    family: "todo",
    items,
    progress: summarizeTasks(items),
    running: true,
    finished: false,
    stopped: false,
    lastToolCallId: "c",
    lastMessageId: "m",
    ...extra,
  }
}

beforeEach(() => {
  mockPlan = undefined
  mockTasks = null
  revealSessionPanel.mockClear()
})

const chip = () => renderHook(() => useSessionTaskChip("s1")).result.current

describe("useSessionTaskChip", () => {
  it("is null without open work", () => {
    expect(chip()).toBeNull()
    mockTasks = tasks([{ id: "1", title: "a", status: "completed" }], { finished: true })
    expect(chip()).toBeNull()
  })

  it("speaks for the agent's open task", () => {
    mockTasks = tasks([
      { id: "1", title: "a", status: "completed" },
      { id: "2", title: "b", status: "in_progress", activeForm: "Doing b" },
    ])
    expect(chip()).toEqual({
      text: 'tasks:{"done":1,"total":2,"step":"Doing b"}',
      tone: "default",
    })
  })

  it("warns about a stopped list", () => {
    mockTasks = tasks([{ id: "1", title: "a", status: "stopped" }], { stopped: true })
    expect(chip()).toEqual({ text: 'stopped:{"done":0,"total":1}', tone: "warning" })
  })

  it("prefers a running plan's current step, and warns when it is paused", () => {
    mockTasks = tasks([{ id: "1", title: "a", status: "pending" }])
    mockPlan = {
      status: "executing",
      completedSteps: 1,
      totalSteps: 3,
      currentStepId: "s2",
      steps: [{ id: "s2", title: "Build" }] as AgentPlan["steps"],
    }
    expect(chip()?.text).toBe('planStep:{"done":1,"total":3,"step":"Build"}')
    mockPlan = { ...mockPlan, currentStepId: undefined }
    expect(chip()?.text).toBe('planRunning:{"done":1,"total":3}')
    mockPlan = { ...mockPlan, status: "paused" }
    expect(chip()).toEqual({ text: 'planPaused:{"done":1,"total":3}', tone: "warning" })
  })
})

describe("TaskProgressChip", () => {
  it("opens the Tasks panel", () => {
    render(<TaskProgressChip sessionId="s1" model={{ text: "1/2 · b", tone: "default" }} />)
    fireEvent.click(screen.getByTestId("task-progress-chip"))
    expect(revealSessionPanel).toHaveBeenCalledWith("s1", "plan")
    expect(screen.getByTestId("task-progress-chip")).toHaveAccessibleName("open: 1/2 · b")
  })
})
