import { fireEvent, render, screen, within } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: { size?: number }) => {
    rendererProps(props)
    return <svg data-testid="pet-renderer-stub" />
  },
}))

import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"
import { PetConsoleHeader, type PetConsoleHeaderProps } from "./pet-console-header"

function props(over: Partial<PetConsoleHeaderProps> = {}, soul = true): PetConsoleHeaderProps {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: soul ? { name: "Boba", personality: "x", hatchDate: "" } : null,
    stage: soul ? "baby" : "egg",
    level: 3,
    coins: 42,
  }
  return {
    mode: "main",
    profile,
    view: computePetView(profile, null, 0),
    effectiveSkinId: "svg" as const,
    selection: { skinId: "svg" },
    onRename: jest.fn(),
    ...over,
  }
}

const renderHeader = (p: PetConsoleHeaderProps) =>
  render(
    <TooltipProvider>
      <PetConsoleHeader {...p} />
    </TooltipProvider>
  )

beforeEach(() => rendererProps.mockClear())

describe("PetConsoleHeader", () => {
  it("sits on the shared feature header band, with the pet in the identity tile", () => {
    renderHeader(props())
    const header = screen.getByTestId("pet-console-header")
    expect(header).toHaveAttribute("data-slot", "feature-page-header")
    const tile = header.querySelector('[data-slot="feature-header-avatar"]')
    expect(tile).toContainElement(screen.getByTestId("pet-renderer-stub"))
    expect(rendererProps).toHaveBeenLastCalledWith(expect.objectContaining({ size: 34 }))
  })

  it("shows the level, stage and coins on one meta line", () => {
    renderHeader(props())
    const meta = screen.getByTestId("pet-console-meta")
    expect(meta).toHaveTextContent("Level 3")
    expect(meta).toHaveTextContent("Baby")
    expect(meta).toHaveTextContent("42 coins")
  })

  it("renames through the provided action, from the page heading", () => {
    const onRename = jest.fn()
    renderHeader(props({ onRename }))
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Boba")
    fireEvent.click(screen.getByLabelText(/rename/i))
    const input = screen.getByLabelText(/pet name/i)
    fireEvent.change(input, { target: { value: "Mochi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("Mochi")
  })

  it("titles an egg instead of offering a name editor", () => {
    renderHeader(props({}, false))
    expect(screen.getByRole("heading", { name: /your pet/i })).toBeInTheDocument()
    expect(screen.getByTestId("pet-console-meta")).toHaveTextContent("Egg")
    expect(screen.queryByLabelText(/rename/i)).toBeNull()
  })

  it("renders the navigation in the header's second row", () => {
    renderHeader(props({ navigation: <nav data-testid="nav-stub" /> }))
    const row = document.querySelector('[data-slot="feature-header-secondary-navigation"]')
    expect(row).toContainElement(screen.getByTestId("nav-stub"))
  })

  it("opens Appearance & settings from the header", () => {
    const onOpenAppearance = jest.fn()
    renderHeader(props({ onOpenAppearance }))
    const entry = screen.getByTestId("pet-console-open-appearance")
    expect(entry).toHaveAccessibleName("Appearance & settings")
    expect(within(entry).queryByTestId("pet-console-desktop-badge")).toBeNull()
    fireEvent.click(entry)
    expect(onOpenAppearance).toHaveBeenCalledTimes(1)
  })

  it("badges the appearance entry when its workspace is the desktop's", () => {
    renderHeader(props({ onOpenAppearance: jest.fn(), appearanceDesktopOnly: true }))
    const entry = screen.getByTestId("pet-console-open-appearance")
    expect(entry).toHaveAttribute("data-desktop-only", "true")
    expect(within(entry).getByTestId("pet-console-desktop-badge")).toHaveTextContent("Desktop")
  })

  it("offers the desktop toggle only when given, reflecting state and progress", () => {
    const onToggle = jest.fn()
    const { rerender } = renderHeader(props())
    expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()

    const wrap = (p: PetConsoleHeaderProps) => (
      <TooltipProvider>
        <PetConsoleHeader {...p} />
      </TooltipProvider>
    )
    rerender(wrap(props({ desktop: { onDesktop: false, pending: false, onToggle } })))
    const button = screen.getByTestId("pet-console-desktop-toggle")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(within(button).getAllByText(/show desktop pet/i)).toHaveLength(2)
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(wrap(props({ desktop: { onDesktop: true, pending: true, onToggle } })))
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(button).toBeDisabled()
    expect(within(button).getAllByText(/hide desktop pet/i)).toHaveLength(2)
  })

  describe("on the appearance sub-page", () => {
    it("titles the sub-page and leads back to the pet", () => {
      const onBack = jest.fn()
      renderHeader(props({ mode: "appearance", onBack, navigation: <nav data-testid="nav" /> }))
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Appearance & settings")
      // No navigation row and no second appearance entry on the sub-page.
      expect(screen.queryByTestId("nav")).toBeNull()
      expect(screen.queryByTestId("pet-console-open-appearance")).toBeNull()
      const back = screen.getByTestId("pet-console-back")
      expect(back).toHaveTextContent("Boba")
      fireEvent.click(back)
      expect(onBack).toHaveBeenCalledTimes(1)
    })
  })

  // Remote care (ADR-0219): only the desktop sends the pet out.
  describe("caring from a paired device", () => {
    it("shows whether the pet is out on the desktop as a read-only chip", () => {
      renderHeader(props({ desktopStatus: { visible: true } }))
      const chip = screen.getByTestId("pet-console-desktop-status")
      expect(chip).toHaveTextContent("On your desktop")
      expect(chip.tagName).not.toBe("BUTTON")
      expect(screen.queryByTestId("pet-console-desktop-toggle")).toBeNull()
    })

    it("says hidden when the pet is not out", () => {
      renderHeader(props({ desktopStatus: { visible: false } }))
      expect(screen.getByTestId("pet-console-desktop-status")).toHaveTextContent("Hidden")
    })
  })
})
