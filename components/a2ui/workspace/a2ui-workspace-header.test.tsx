/**
 * Tests for the workspace header (title + mode tabs + loading badge).
 */

import React from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"

const a2uiMessages = (
  enMessages as unknown as {
    a2ui: Record<string, string> & { workspace: Record<string, string> }
  }
).a2ui

const storeState: { surfaces: Record<string, { title?: string; ready?: boolean }> } = {
  surfaces: {},
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { WorkspaceHeader } from "./a2ui-workspace-header"

function renderHeader(surfaceId: string, controls?: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <TooltipProvider>
        <A2UIWorkspaceProvider surfaceId={surfaceId}>
          <WorkspaceHeader controls={controls} />
        </A2UIWorkspaceProvider>
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("WorkspaceHeader", () => {
  beforeEach(() => {
    storeState.surfaces = {}
  })

  it("renders the surface title when present", () => {
    storeState.surfaces = { sx: { title: "My Mini App", ready: true } }
    renderHeader("sx")
    expect(screen.getByRole("heading", { name: "My Mini App" })).toBeInTheDocument()
    expect(screen.getByText(a2uiMessages.workspace.headerDescription)).toBeInTheDocument()
  })

  it("falls back to a truncated surfaceId when the surface has no title", () => {
    storeState.surfaces = { "long-surface-id-here": { ready: true } }
    renderHeader("long-surface-id-here")
    expect(screen.getByText("long-surface")).toBeInTheDocument()
  })

  it("shows the loading chip when the surface is not ready", () => {
    storeState.surfaces = { sx: { ready: false } }
    renderHeader("sx")
    const chip = screen.getByTestId("a2ui-header-loading")
    expect(chip).toHaveTextContent(a2uiMessages.workspace.headerLoading)
    expect(chip).toHaveAttribute("data-tone", "active")
  })

  it("renders the three mode tabs", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx")
    const tabs = within(screen.getByRole("tablist", { name: a2uiMessages.workspace.modeTabsAria }))
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      a2uiMessages.editMode,
      a2uiMessages.previewMode,
      a2uiMessages.dataMode,
    ])
  })

  it("renders the back-to-gallery link", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx")
    const link = screen.getByRole("link", { name: a2uiMessages.back }) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/a2ui")
    expect(screen.getByTestId("a2ui-workspace-header")).toHaveAttribute(
      "data-variant",
      "management"
    )
  })

  it("drops the status badge once the surface is ready", () => {
    storeState.surfaces = { sx: { title: "My Mini App", ready: true } }
    renderHeader("sx")
    // A badge that always says "fine" is chrome that never informs; the mode
    // tabs carry the state instead.
    expect(screen.queryByTestId("a2ui-header-loading")).not.toBeInTheDocument()
  })

  it("renders the toolbar as its secondary band instead of a second bar", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx", <div data-testid="stub-controls" />)
    const header = screen.getByTestId("a2ui-workspace-header")
    expect(header).toHaveAttribute("data-has-secondary", "true")
    expect(header).toContainElement(screen.getByTestId("stub-controls"))
  })

  it("clicking a mode tab updates workspace mode", () => {
    storeState.surfaces = { sx: { ready: true } }
    renderHeader("sx")
    const dataTab = screen.getByRole("tab", { name: a2uiMessages.dataMode })
    expect(dataTab).toHaveAttribute("aria-selected", "false")
    // Radix tabs switch on mousedown, not click.
    fireEvent.mouseDown(dataTab, { button: 0 })
    expect(dataTab).toHaveAttribute("aria-selected", "true")
  })
})
