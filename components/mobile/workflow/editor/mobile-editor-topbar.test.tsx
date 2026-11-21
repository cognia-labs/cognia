/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastWarning = jest.fn()
const toastMessage = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    message: (...a: unknown[]) => toastMessage(...a),
  },
}))

const persistEditorWorkflow = jest.fn(
  async (
    ..._a: unknown[]
  ): Promise<{
    issueCount: number
    publicationInvalidated: boolean
    triggerRegistration?: { ok: true } | { ok: false; error: string }
    hostWrite?: boolean
  }> => ({
    issueCount: 0,
    publicationInvalidated: false,
    hostWrite: false,
  })
)
jest.mock("@/lib/workflow/editor/persist-workflow", () => ({
  persistEditorWorkflow: (...a: unknown[]) => persistEditorWorkflow(...a),
}))

const downloadWorkflowJson = jest.fn()
jest.mock("@/lib/workflow/editor/workflow-json", () => ({
  downloadWorkflowJson: (...a: unknown[]) => downloadWorkflowJson(...a),
  parseWorkflowImport: (t: string) => JSON.parse(t),
}))

jest.mock("@/lib/workflow/editor/auto-layout", () => ({
  autoLayout: jest.fn(async () => ({})),
  applyAutoLayoutPositions: (nodes: unknown) => nodes,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { MobileEditorTopbar } from "./mobile-editor-topbar"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_top",
    schemaVersion: 2,
    name: "Daily Digest",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "ai_a",
        type: "ai.prompt",
        typeVersion: 2,
        position: { x: 0, y: 0 },
        data: { label: "AI", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function renderTopbar(
  mode: "read" | "edit" = "read",
  orientationStatus?: "unavailable" | "pending",
  running = false
) {
  const store: EditorStore = createEditorStore(buildWorkflow())
  const onToggleMode = jest.fn()
  const onOpenCopilot = jest.fn()
  const onOpenWorkbench = jest.fn()
  const onRun = jest.fn()
  render(
    <MobileEditorTopbar
      store={store}
      reactFlowInstance={null}
      mode={mode}
      onToggleMode={onToggleMode}
      onOpenCopilot={onOpenCopilot}
      onOpenWorkbench={onOpenWorkbench}
      orientationLocked={true}
      orientationStatus={orientationStatus}
      onToggleOrientationLock={jest.fn()}
      onToggleSelectMode={jest.fn()}
      onRun={onRun}
      running={running}
    />
  )
  return { store, onToggleMode, onOpenCopilot, onOpenWorkbench, onRun }
}

beforeEach(() => {
  toastSuccess.mockReset()
  toastError.mockReset()
  toastWarning.mockReset()
  toastMessage.mockReset()
  persistEditorWorkflow.mockClear()
  downloadWorkflowJson.mockClear()
})

describe("<MobileEditorTopbar />", () => {
  it("shows the workflow name and a saved badge when clean", () => {
    renderTopbar()
    expect(screen.getByText("Daily Digest")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-editor-dirty")).toHaveTextContent("savedBadge")
  })

  it("fires onToggleMode when the mode toggle is tapped", async () => {
    const user = userEvent.setup()
    const { onToggleMode } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-mode-toggle"))
    expect(onToggleMode).toHaveBeenCalledTimes(1)
  })

  it("fires onOpenCopilot when the copilot button is tapped (available in read mode)", async () => {
    const user = userEvent.setup()
    const { onOpenCopilot } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-menu"))
    await user.click(screen.getByTestId("mobile-editor-copilot"))
    expect(onOpenCopilot).toHaveBeenCalledTimes(1)
  })

  it("opens the shared Context Workbench from the primary sidebar action", async () => {
    const user = userEvent.setup()
    const { onOpenWorkbench } = renderTopbar("read")
    await user.click(screen.getByTestId("mobile-editor-workbench"))
    expect(onOpenWorkbench).toHaveBeenCalledTimes(1)
  })

  // Find-node moved to the editor's map controls so the title keeps room on a
  // phone; the bar must not grow a second copy of it back.
  it("leaves canvas node search to the editor's map controls", () => {
    renderTopbar("read")
    expect(screen.queryByTestId("mobile-editor-search")).not.toBeInTheDocument()
  })

  // Every action is the app's standard icon button (as on the sub-page and
  // list headers), so the bar reads as one set. Run is its only filled action;
  // an active mode is a tint so the two never compete.
  describe("action buttons", () => {
    it("uses the same icon-button shape for every action", () => {
      renderTopbar("read")
      for (const id of [
        "mobile-editor-mode-toggle",
        "mobile-editor-save",
        "mobile-editor-run",
        "mobile-editor-menu",
      ]) {
        expect(screen.getByTestId(id)).toHaveAttribute("data-size", "icon")
      }
    })

    it("fills only Run", () => {
      renderTopbar("read")
      expect(screen.getByTestId("mobile-editor-run")).toHaveAttribute("data-variant", "default")
      for (const id of ["mobile-editor-mode-toggle", "mobile-editor-save", "mobile-editor-menu"]) {
        expect(screen.getByTestId(id)).toHaveAttribute("data-variant", "ghost")
      }
    })

    it("tints the mode toggle while editing", () => {
      renderTopbar("edit")
      const toggle = screen.getByTestId("mobile-editor-mode-toggle")
      expect(toggle).toHaveAttribute("aria-pressed", "true")
      expect(toggle).toHaveClass("bg-primary/10", "text-primary")
    })

    it("leaves the mode toggle untinted while reading", () => {
      renderTopbar("read")
      const toggle = screen.getByTestId("mobile-editor-mode-toggle")
      expect(toggle).toHaveAttribute("aria-pressed", "false")
      expect(toggle).not.toHaveClass("bg-primary/10")
    })
  })

  describe("phone-width layout", () => {
    it("keeps the status badge inside the shrinkable name column", () => {
      renderTopbar()
      const column = screen.getByRole("heading", { name: "Daily Digest" }).parentElement
      expect(column).toHaveClass("min-w-0", "flex-1")
      expect(column).toContainElement(screen.getByTestId("mobile-editor-dirty"))
      expect(screen.getByTestId("mobile-editor-dirty")).toHaveClass("max-w-full", "truncate")
    })

    it("collapses the mode toggle to an icon but keeps its accessible name", () => {
      renderTopbar("edit")
      const toggle = screen.getByTestId("mobile-editor-mode-toggle")
      expect(toggle).toHaveAttribute("data-size", "icon")
      expect(screen.getByText("modeEdit")).toHaveClass("max-sm:sr-only")
      expect(toggle).toHaveAccessibleName("modeEdit")
    })

    it("hides select mode and Workbench from the bar below sm", () => {
      renderTopbar("edit")
      expect(screen.getByTestId("mobile-editor-select-mode")).toHaveClass("max-sm:hidden")
      expect(screen.getByTestId("mobile-editor-workbench")).toHaveClass("max-sm:hidden")
    })

    it("offers Workbench and select mode from the overflow menu instead", async () => {
      const user = userEvent.setup()
      const store: EditorStore = createEditorStore(buildWorkflow())
      const onOpenWorkbench = jest.fn()
      const onToggleSelectMode = jest.fn()
      render(
        <MobileEditorTopbar
          store={store}
          reactFlowInstance={null}
          mode="select"
          onToggleMode={jest.fn()}
          onOpenCopilot={jest.fn()}
          onOpenWorkbench={onOpenWorkbench}
          orientationLocked={true}
          onToggleOrientationLock={jest.fn()}
          onToggleSelectMode={onToggleSelectMode}
          onRun={jest.fn()}
          running={false}
        />
      )
      await user.click(screen.getByTestId("mobile-editor-menu"))
      const selectItem = await screen.findByTestId("mobile-editor-menu-select-mode")
      expect(selectItem).toHaveClass("sm:hidden")
      await user.click(selectItem)
      expect(onToggleSelectMode).toHaveBeenCalledTimes(1)

      await user.click(screen.getByTestId("mobile-editor-menu"))
      const workbenchItem = await screen.findByTestId("mobile-editor-menu-workbench")
      expect(workbenchItem).toHaveClass("sm:hidden")
      await user.click(workbenchItem)
      expect(onOpenWorkbench).toHaveBeenCalledTimes(1)
    })

    it("does not offer select mode in the menu while reading", async () => {
      const user = userEvent.setup()
      renderTopbar("read")
      await user.click(screen.getByTestId("mobile-editor-menu"))
      await screen.findByTestId("mobile-editor-menu-workbench")
      expect(screen.queryByTestId("mobile-editor-menu-select-mode")).not.toBeInTheDocument()
    })
  })

  it("disables Save when clean and persists once dirty", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    expect(screen.getByTestId("mobile-editor-save")).toBeDisabled()

    act(() => store.getState().setName("Edited"))
    expect(screen.getByTestId("mobile-editor-dirty")).toHaveTextContent("dirty")

    await user.click(screen.getByTestId("mobile-editor-save"))
    await waitFor(() => expect(persistEditorWorkflow).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalledWith("saved")
  })

  it("warns when saving invalidates a published callable contract", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    act(() => store.getState().setName("Edited"))
    persistEditorWorkflow.mockResolvedValueOnce({
      issueCount: 0,
      publicationInvalidated: true,
    })

    await user.click(screen.getByTestId("mobile-editor-save"))

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith("publicationInvalidated"))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  // Convergence 0b B2: a save whose trigger registration failed is not a
  // silent success on the phone either.
  it("reports a save whose trigger registration failed", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    act(() => store.getState().setName("Edited"))
    persistEditorWorkflow.mockResolvedValueOnce({
      issueCount: 0,
      publicationInvalidated: false,
      triggerRegistration: { ok: false, error: "daemon refused" },
    })

    await user.click(screen.getByTestId("mobile-editor-save"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("triggerRegistrationFailed"))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("says a paired phone's save is on its way to the desktop", async () => {
    const user = userEvent.setup()
    const { store } = renderTopbar()
    act(() => store.getState().setName("Edited"))
    persistEditorWorkflow.mockResolvedValueOnce({
      issueCount: 0,
      publicationInvalidated: false,
      hostWrite: true,
    })

    await user.click(screen.getByTestId("mobile-editor-save"))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("savedQueuedForHost"))
  })

  // The editor owns the run (use-mobile-preview-run.ts); the bar only asks.
  it("asks the editor to run on Run, without saving or queueing anything itself", async () => {
    const user = userEvent.setup()
    const { store, onRun } = renderTopbar()
    act(() => store.getState().setName("Edited"))
    await user.click(screen.getByTestId("mobile-editor-run"))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(persistEditorWorkflow).not.toHaveBeenCalled()
  })

  it("disables Run while a run is starting", () => {
    renderTopbar("read", undefined, true)
    expect(screen.getByTestId("mobile-editor-run")).toBeDisabled()
  })

  it("exports JSON from the overflow menu", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-menu"))
    await user.click(await screen.findByText("export"))
    expect(downloadWorkflowJson).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith("exported")
  })

  it("links to the run history from the overflow menu", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-menu"))
    const item = await screen.findByTestId("mobile-editor-run-history")
    expect(item).toHaveAttribute("href", "/workflows/runs?id=wf_top")
  })

  it("toasts a failure when auto-layout yields no positions", async () => {
    const user = userEvent.setup()
    renderTopbar()
    await user.click(screen.getByTestId("mobile-editor-menu"))
    await user.click(await screen.findByText("autoLayout"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("autoLayoutFailed"))
  })
})

it.each(["pending", "unavailable"] as const)("disables orientation control while %s", async (status) => {
  renderTopbar("read", status)
  const user = userEvent.setup()
  await user.click(screen.getByTestId("mobile-editor-menu"))
  const option = await screen.findByTestId("mobile-editor-orientation")
  expect(option).toHaveAttribute("data-disabled")
  expect(option).toHaveTextContent(status === "pending" ? "orientationPending" : "orientationUnavailable")
})
