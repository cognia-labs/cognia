/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { resetDisclosureMemory } from "@/lib/chat/disclosure-memory"

import { TurnProcessFold, useInsideTurnFold } from "./turn-process-fold"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  ReadingCollapse: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))

const fold = { toolCount: 3, failedCount: 0, reasoningCount: 1 }

function FoldProbe() {
  return <p>{useInsideTurnFold() ? "inside fold" : "outside fold"}</p>
}

describe("TurnProcessFold", () => {
  afterEach(() => resetDisclosureMemory())

  it("starts closed with the sealed duration and mounts nothing of the body", () => {
    render(
      <TurnProcessFold fold={fold} durationMs={788_000}>
        <p>process body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-label")).toHaveTextContent(
      'workedFor:{"duration":"13m 8s"}'
    )
    expect(screen.getByTestId("turn-process-fold-toggle")).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("process body")).toBeNull()
  })

  it("opens and closes the body on click", () => {
    render(
      <TurnProcessFold fold={fold} durationMs={5_000}>
        <p>process body</p>
      </TurnProcessFold>
    )
    const toggle = screen.getByTestId("turn-process-fold-toggle")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("process body")).toBeInTheDocument()
    expect(toggle.getAttribute("aria-label")).toContain("collapse")
    fireEvent.click(toggle)
    expect(screen.queryByText("process body")).toBeNull()
  })

  it("falls back to a step count when the turn has no recorded duration", () => {
    render(
      <TurnProcessFold fold={fold}>
        <p>body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-label")).toHaveTextContent('worked:{"count":4}')
  })

  it("shows failed tool calls on the closed row", () => {
    render(
      <TurnProcessFold fold={{ ...fold, failedCount: 2 }} durationMs={1_000}>
        <p>body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-failed")).toHaveTextContent('failed:{"count":2}')
  })

  it("hides the failed tally once open, where each failed row speaks for itself", () => {
    render(
      <TurnProcessFold fold={{ ...fold, failedCount: 2 }} durationMs={1_000}>
        <p>body</p>
      </TurnProcessFold>
    )
    fireEvent.click(screen.getByTestId("turn-process-fold-toggle"))
    expect(screen.queryByTestId("turn-process-fold-failed")).toBeNull()
  })

  it("tells its body it is inside a fold", () => {
    render(
      <>
        <TurnProcessFold fold={fold} durationMs={1_000}>
          <FoldProbe />
        </TurnProcessFold>
        <FoldProbe />
      </>
    )
    fireEvent.click(screen.getByTestId("turn-process-fold-toggle"))
    expect(screen.getByText("inside fold")).toBeInTheDocument()
    expect(screen.getByText("outside fold")).toBeInTheDocument()
  })

  it("remembers an opened fold across a remount when given a memory key", () => {
    const first = render(
      <TurnProcessFold fold={fold} durationMs={1_000} memoryKey="s1:m1:fold">
        <p>process body</p>
      </TurnProcessFold>
    )
    fireEvent.click(screen.getByTestId("turn-process-fold-toggle"))
    first.unmount()

    render(
      <TurnProcessFold fold={fold} durationMs={1_000} memoryKey="s1:m1:fold">
        <p>process body</p>
      </TurnProcessFold>
    )
    expect(screen.getByTestId("turn-process-fold-toggle")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("process body")).toBeInTheDocument()
  })
})
