/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { TASK_VIEW_STATUSES, type TaskViewStatus } from "@/lib/tasks/task-view"
import { TaskStatusIcon } from "./task-status-icon"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function iconClass(status: TaskViewStatus): string {
  const { container } = render(<TaskStatusIcon status={status} />)
  return container.querySelector("svg")?.getAttribute("class") ?? ""
}

describe("TaskStatusIcon", () => {
  it("draws every status", () => {
    for (const status of TASK_VIEW_STATUSES) {
      expect(iconClass(status)).toContain("size-3.5")
    }
  })

  it("gives each state its own tone", () => {
    expect(iconClass("completed")).toContain("text-green-600")
    expect(iconClass("failed")).toContain("text-rose-600")
    expect(iconClass("stopped")).toContain("text-amber-600")
    expect(iconClass("pending")).toContain("text-muted-foreground")
  })

  it("animates only a running item, and only when motion is allowed", () => {
    expect(iconClass("in_progress")).toContain("motion-safe:animate-pulse")
    expect(iconClass("stopped")).not.toContain("animate-pulse")
  })

  it("announces the status when labelled", () => {
    render(<TaskStatusIcon status="stopped" labelled />)
    expect(screen.getByText("stopped")).toHaveClass("sr-only")
  })
})
