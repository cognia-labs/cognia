import { render, screen } from "@testing-library/react"

import { ComposerStatusBands } from "./composer-status-bands"

jest.mock("@/components/goal/goal-status-pill", () => ({
  GoalStatusPill: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="goal">{sessionId}</div>
  ),
}))
jest.mock("@/components/loop/loop-status-pill", () => ({
  LoopStatusPill: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="loop">{sessionId}</div>
  ),
}))
jest.mock("@/components/chat/plan-mode-banner", () => ({
  PlanModeBanner: () => <div data-testid="plan" />,
}))

it("shows the goal, loop and plan-mode bands for this conversation", () => {
  render(<ComposerStatusBands sessionId="s1" />)

  expect(screen.getByTestId("goal")).toHaveTextContent("s1")
  expect(screen.getByTestId("loop")).toHaveTextContent("s1")
  expect(screen.getByTestId("plan")).toBeInTheDocument()
})
