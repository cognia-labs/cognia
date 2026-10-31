/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { QuotaBar } from "./quota-bar"

describe("QuotaBar", () => {
  it("exposes the meter as an accessible progressbar", () => {
    render(<QuotaBar pct={42} status="ok" label="Session" />)
    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", "42")
    expect(bar).toHaveAttribute("aria-valuemin", "0")
    expect(bar).toHaveAttribute("aria-valuemax", "100")
    expect(bar).toHaveAttribute("aria-label", "Session")
  })

  it("distinguishes a missing reading from a known zero", () => {
    const { rerender } = render(<QuotaBar pct={null} status="unknown" label="Weekly" />)
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-state", "indeterminate")
    rerender(<QuotaBar pct={0} status="ok" label="Weekly" />)
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-state", "loading")
  })

  it("uses shared progress while keeping the reading and status fill in sync", () => {
    const { rerender } = render(<QuotaBar pct={42} status="ok" label="Session" />)
    const bar = screen.getByRole("progressbar", { name: "Session" })
    expect(bar).toHaveAttribute("data-slot", "progress")
    const fill = bar.querySelector('[data-slot="progress-indicator"]')
    expect(fill).toHaveStyle({ transform: "translateX(-58%)" })
    expect(fill).toHaveClass("bg-emerald-500", "duration-500")
    expect(bar).not.toHaveAttribute("indicatorClassName")
    rerender(<QuotaBar pct={100} status="crit" label="Session" />)
    expect(fill).toHaveStyle({ transform: "translateX(-0%)" })
    expect(fill).toHaveClass("bg-destructive")
    expect(fill).not.toHaveClass("bg-emerald-500", "bg-primary")
    expect(bar).toHaveAttribute("data-state", "complete")
  })

  it("colours the fill by status", () => {
    const { rerender, container } = render(<QuotaBar pct={10} status="ok" label="x" />)
    expect(container.querySelector(".bg-emerald-500")).not.toBeNull()

    rerender(<QuotaBar pct={80} status="warn" label="x" />)
    expect(container.querySelector(".bg-amber-500")).not.toBeNull()

    rerender(<QuotaBar pct={100} status="exceeded" label="x" />)
    expect(container.querySelector(".bg-destructive")).not.toBeNull()
  })

  // This component exists because the gauge card and the meter row were two
  // copies of the same bar with different transitions (500ms vs the ~150ms
  // Tailwind default), so the same affordance animated at two speeds depending
  // on which provider you looked at.
  it("pins one transition speed for every caller", () => {
    const { container } = render(<QuotaBar pct={50} status="ok" label="x" />)
    const fill = container.querySelector(".bg-emerald-500")!
    expect(fill.className).toContain("transition-all")
    expect(fill.className).toContain("duration-500")
  })

  it("accepts a className without dropping the base track styles", () => {
    const { container } = render(<QuotaBar pct={50} status="ok" label="x" className="mt-4" />)
    const track = container.querySelector('[role="progressbar"]')!
    expect(track.className).toContain("mt-4")
    expect(track.className).toContain("rounded-full")
  })
})
