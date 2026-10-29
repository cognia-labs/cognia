/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import { PlanModeBanner } from "./plan-mode-banner"
import { ComposerSessionProvider } from "./composer/composer-session-context"
import { useChatStore } from "@/stores/chat"

let mockShowKeyboardHints = true
jest.mock("@/hooks/ui/use-pointer", () => ({
  useShowKeyboardHints: () => mockShowKeyboardHints,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockOpenPlan: { id: string } | undefined
jest.mock("@/hooks/agent/use-session-plan", () => ({
  useSessionPlan: () => mockOpenPlan,
}))
jest.mock("@/components/agent/plan/write-plan-button", () => ({
  WritePlanButton: ({ sessionId }: { sessionId: string }) => (
    <button data-testid="write-plan">{sessionId}</button>
  ),
}))

const setMode = (
  mode: Parameters<ReturnType<typeof useChatStore.getState>["setPermissionMode"]>[0]
) => act(() => useChatStore.getState().setPermissionMode(mode))

describe("PlanModeBanner", () => {
  afterEach(() => {
    setMode(null)
    mockOpenPlan = undefined
  })

  it("renders nothing outside plan mode", () => {
    setMode(null)
    const { container } = render(<PlanModeBanner />)
    expect(container).toBeEmptyDOMElement()

    setMode("acceptEdits")
    expect(screen.queryByTestId("plan-mode-banner")).not.toBeInTheDocument()
  })

  it("shows the amber banner with the cycle hint in plan mode", () => {
    setMode("plan")
    render(<PlanModeBanner />)
    const banner = screen.getByTestId("plan-mode-banner")
    expect(banner).toHaveTextContent("banner")
    expect(banner).toHaveTextContent("hint")
    expect(banner.className).toContain("border-amber-500/40")
  })

  it("leaves out the Shift+Tab chip on a device without a keyboard", () => {
    mockShowKeyboardHints = false
    try {
      setMode("plan")
      render(<PlanModeBanner />)
      const banner = screen.getByTestId("plan-mode-banner")
      expect(banner).toHaveTextContent("banner")
      expect(banner).not.toHaveTextContent("hint")
      expect(banner.querySelector("kbd")).toBeNull()
    } finally {
      mockShowKeyboardHints = true
    }
  })

  it("announces the mode of the pane it sits above, not the focused one", () => {
    // Rendered inside an unfocused split pane it announced plan mode for the
    // pane beside it, and hid it for its own.
    act(() => {
      useChatStore.getState().setActiveSession("ses_focused")
      useChatStore.getState().setPermissionMode("plan", "ses_focused")
      useChatStore.getState().setPermissionMode("default", "ses_background")
    })

    render(
      <ComposerSessionProvider value="ses_background">
        <PlanModeBanner />
      </ComposerSessionProvider>
    )
    expect(screen.queryByTestId("plan-mode-banner")).not.toBeInTheDocument()
  })

  it("shows plan mode for a background pane that is itself in plan mode", () => {
    act(() => {
      useChatStore.getState().setActiveSession("ses_focused")
      useChatStore.getState().setPermissionMode(null, "ses_focused")
      useChatStore.getState().setPermissionMode("plan", "ses_background")
    })

    render(
      <ComposerSessionProvider value="ses_background">
        <PlanModeBanner />
      </ComposerSessionProvider>
    )
    expect(screen.getByTestId("plan-mode-banner")).toBeInTheDocument()
  })

  it("offers Write a plan for its own pane while no plan is open", () => {
    act(() => useChatStore.getState().setPermissionMode("plan", "ses_pane"))
    const { rerender } = render(
      <ComposerSessionProvider value="ses_pane">
        <PlanModeBanner />
      </ComposerSessionProvider>
    )
    expect(screen.getByTestId("write-plan")).toHaveTextContent("ses_pane")

    mockOpenPlan = { id: "p1" }
    rerender(
      <ComposerSessionProvider value="ses_pane">
        <PlanModeBanner />
      </ComposerSessionProvider>
    )
    expect(screen.queryByTestId("write-plan")).not.toBeInTheDocument()
  })
})
