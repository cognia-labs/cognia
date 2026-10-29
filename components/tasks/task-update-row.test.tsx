/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { UIMessage } from "ai"

import { useChatStore } from "@/stores/chat"

import { resolveTaskRunChange, TaskUpdateRow } from "./task-update-row"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const revealSessionPanel = jest.fn()
jest.mock("@/lib/artifacts/reveal", () => ({
  revealSessionPanel: (...a: unknown[]) => revealSessionPanel(...a),
}))

const SID = "task-row-session"

const todo = (id: string, items: Array<[string, string]>, state = "output-available") => ({
  type: "tool-TodoWrite",
  toolCallId: id,
  state,
  input: { todos: items.map(([content, status]) => ({ content, status })) },
})

function seed(...parts: Array<ReturnType<typeof todo> | Record<string, unknown>>) {
  const messages = parts.map(
    (part, i) => ({ id: `m${i}`, role: "assistant", parts: [part] }) as unknown as UIMessage
  )
  act(() => useChatStore.getState().setSessionMessages(SID, messages))
}

afterEach(() => {
  act(() => useChatStore.getState().setSessionMessages(SID, []))
  revealSessionPanel.mockClear()
})

describe("TaskUpdateRow", () => {
  it("announces a new list with its size", () => {
    const first = todo("t1", [
      ["a", "pending"],
      ["b", "pending"],
    ])
    seed(first)
    render(<TaskUpdateRow sessionId={SID} parts={[first]} />)
    expect(screen.getByTestId("task-update-row")).toHaveTextContent('created:{"total":2}')
    expect(screen.getByTestId("task-update-progress")).toHaveTextContent(
      'progress:{"done":0,"total":2}'
    )
  })

  it("says what a later snapshot changed, collapsed until opened", () => {
    const first = todo("t1", [
      ["a", "in_progress"],
      ["b", "pending"],
      ["c", "pending"],
    ])
    const second = todo("t2", [
      ["a", "completed"],
      ["b", "in_progress"],
      ["d", "pending"],
    ])
    seed(first, second)
    render(<TaskUpdateRow sessionId={SID} parts={[second]} />)
    const row = screen.getByTestId("task-update-row")
    expect(row).toHaveTextContent('completed:{"title":"a"}')
    expect(row).toHaveTextContent('started:{"title":"b"}')
    expect(row).toHaveTextContent('added:{"count":1}')
    expect(row).toHaveTextContent('removed:{"count":1}')
    expect(screen.queryByTestId("task-list")).not.toBeInTheDocument()
    fireEvent.click(within(row).getByRole("button", { expanded: false }))
    expect(screen.getAllByTestId("task-list-item")).toHaveLength(3)
  })

  it("links the latest change to the Tasks panel, not older ones", () => {
    const first = todo("t1", [["a", "in_progress"]])
    const second = todo("t2", [["a", "completed"]])
    seed(first, second)
    const { unmount } = render(<TaskUpdateRow sessionId={SID} parts={[first]} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(screen.queryByTestId("task-update-open-panel")).not.toBeInTheDocument()
    unmount()
    render(<TaskUpdateRow sessionId={SID} parts={[second]} />)
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    fireEvent.click(screen.getByTestId("task-update-open-panel"))
    expect(revealSessionPanel).toHaveBeenCalledWith(SID, "plan")
  })

  it("merges a run of incremental calls into one change", () => {
    const create = {
      type: "tool-TaskCreate",
      toolCallId: "c1",
      state: "output-available",
      input: { subject: "Ship" },
      output: "Task #1 created successfully: Ship",
    }
    const update = {
      type: "tool-TaskUpdate",
      toolCallId: "c2",
      state: "output-available",
      input: { taskId: "1", status: "completed" },
    }
    seed(todo("t0", [["old", "completed"]]), create, update)
    render(<TaskUpdateRow sessionId={SID} parts={[create, update]} />)
    // A family switch compares within the new family only: a fresh list.
    expect(screen.getByTestId("task-update-row")).toHaveTextContent('created:{"total":1}')
    expect(screen.getByTestId("task-update-row")).toHaveAttribute("data-status", "complete")
  })

  it("shows a running dot while a call streams", () => {
    const streaming = todo("t1", [["a", "pending"]], "input-streaming")
    seed(streaming)
    render(<TaskUpdateRow sessionId={SID} parts={[streaming]} />)
    expect(screen.getByTestId("task-update-row")).toHaveAttribute("data-status", "running")
  })

  it("falls back to the TodoWrite snapshot outside its session", () => {
    render(<TaskUpdateRow parts={[todo("x", [["solo", "pending"]])]} />)
    expect(screen.getByTestId("task-update-row")).toHaveTextContent('created:{"total":1}')
  })

  it("is a static line for a call that changed nothing it can show", () => {
    render(<TaskUpdateRow parts={[{ type: "tool-TaskList", toolCallId: "l1" }]} />)
    expect(screen.getByTestId("task-update-row")).toHaveTextContent("viewed")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})

describe("resolveTaskRunChange", () => {
  it("returns null with nothing known and no TodoWrite to read", () => {
    expect(
      resolveTaskRunChange([{ type: "tool-TaskUpdate" }], { byToolCallId: new Map() })
    ).toBeNull()
  })
})
