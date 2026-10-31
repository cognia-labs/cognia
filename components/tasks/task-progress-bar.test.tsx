/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { TaskProgressBar } from "./task-progress-bar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

describe("TaskProgressBar", () => {
  it("uses shared progress with reduced-motion support and keeps fill updates in sync", () => {
    const { rerender } = render(<TaskProgressBar done={1} total={4} className="mt-2" />)
    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("data-slot", "progress")
    expect(bar).toHaveClass("h-1.5", "mt-2")
    const fill = bar.querySelector('[data-slot="progress-indicator"]')
    expect(fill).toHaveStyle({ transform: "translateX(-75%)" })
    expect(fill).toHaveClass("motion-reduce:transition-none", "bg-primary")
    rerender(<TaskProgressBar done={4} total={4} tone="warning" />)
    expect(bar).toHaveAttribute("aria-valuenow", "100")
    expect(fill).toHaveStyle({ transform: "translateX(-0%)" })
    expect(fill).toHaveClass("bg-amber-500")
    expect(fill).not.toHaveClass("bg-primary")
  })

  it("exposes the percentage and the done/total text", () => {
    render(<TaskProgressBar done={1} total={4} />)
    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", "25")
    expect(bar).toHaveAttribute("aria-valuetext", 'progressLabel:{"done":1,"total":4}')
  })

  it("reads 0 for an empty list and clamps overflow", () => {
    const { rerender } = render(<TaskProgressBar done={0} total={0} />)
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
    rerender(<TaskProgressBar done={5} total={4} />)
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
  })

  it("uses the warning fill on request", () => {
    const { container } = render(<TaskProgressBar done={1} total={2} tone="warning" />)
    expect(container.querySelector(".bg-amber-500")).not.toBeNull()
  })
})
