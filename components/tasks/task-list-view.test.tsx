/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import type { TaskViewItem } from "@/lib/tasks/task-view"
import { TaskListView } from "./task-list-view"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const ITEMS: TaskViewItem[] = [
  { id: "1", title: "Read the file", status: "completed" },
  { id: "2", title: "Edit the file", status: "in_progress", activeForm: "Editing the file" },
  { id: "3", title: "Run the tests", status: "failed", detail: "exit 1" },
]

describe("TaskListView", () => {
  it("renders each item with its status", () => {
    render(<TaskListView items={ITEMS} />)
    const rows = screen.getAllByTestId("task-list-item")
    expect(rows.map((row) => row.dataset.status)).toEqual(["completed", "in_progress", "failed"])
    expect(screen.getByText("Read the file")).toHaveClass("line-through")
  })

  it("shows the active form while an item runs", () => {
    render(<TaskListView items={ITEMS} />)
    expect(screen.getByText("Editing the file")).toBeInTheDocument()
    expect(screen.queryByText("Edit the file")).not.toBeInTheDocument()
  })

  it("renders a detail line", () => {
    render(<TaskListView items={ITEMS} />)
    expect(screen.getByTestId("task-list-item-detail")).toHaveTextContent("exit 1")
  })

  it("marks the current item and renders trailing content", () => {
    render(
      <TaskListView
        items={ITEMS}
        currentId="3"
        renderTrailing={(item) => <span>{`tail-${item.id}`}</span>}
      />
    )
    expect(screen.getAllByTestId("task-list-item")[2]).toHaveAttribute("data-current", "true")
    expect(screen.getByText("tail-1")).toBeInTheDocument()
  })

  it("folds completed items of a long list until expanded", () => {
    const items: TaskViewItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      title: `task ${i}`,
      status: i < 6 ? "completed" : "pending",
    }))
    render(<TaskListView items={items} />)
    expect(screen.getAllByTestId("task-list-item")).toHaveLength(4)
    const toggle = screen.getByTestId("task-list-completed-toggle")
    expect(toggle).toHaveTextContent('completedFold:{"count":6}')
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle)
    expect(screen.getAllByTestId("task-list-item")).toHaveLength(10)
  })

  it("does not fold a short list", () => {
    render(<TaskListView items={ITEMS} />)
    expect(screen.queryByTestId("task-list-completed-toggle")).not.toBeInTheDocument()
  })
})
