/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("../behavior-card", () => ({
  BehaviorCard: () => <div data-testid="behavior-card" />,
}))
jest.mock("../screen-off-card", () => ({
  ScreenOffCard: ({ platform }: { platform?: string }) => (
    <div data-testid="screen-off-card" data-platform={platform} />
  ),
}))

import type { Capabilities } from "@/lib/automation/types"

import { BehaviorPanel } from "./behavior-panel"

function caps(platform: string): Capabilities {
  return { platform } as Capabilities
}

describe("BehaviorPanel", () => {
  it("always shows the model behaviour settings", () => {
    render(<BehaviorPanel caps={undefined} />)
    expect(screen.getByTestId("behavior-card")).toBeInTheDocument()
  })

  it.each(["windows", "macos"])("shows screen-off mode on %s, which has a backend", (platform) => {
    render(<BehaviorPanel caps={caps(platform)} />)
    expect(screen.getByTestId("screen-off-card")).toHaveAttribute("data-platform", platform)
  })

  it("omits screen-off mode where no backend exists or the probe failed", () => {
    const { rerender } = render(<BehaviorPanel caps={caps("linux")} />)
    expect(screen.queryByTestId("screen-off-card")).not.toBeInTheDocument()
    rerender(<BehaviorPanel caps={null} />)
    expect(screen.queryByTestId("screen-off-card")).not.toBeInTheDocument()
  })
})
