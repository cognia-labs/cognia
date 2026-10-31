/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { clearEvents } from "@/lib/db/a2ui-event-history"
import { DebuggerTab } from "./debugger-tab"

const listEvents = jest.fn(async () => [
  {
    id: "event-1",
    surfaceId: "surface-a",
    type: "userAction" as const,
    payload: { action: "submit" },
    timestamp: 1,
  },
])

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/db/a2ui-event-history", () => ({
  listEvents: () => listEvents(),
  clearEvents: jest.fn(),
  appendEvent: jest.fn(),
}))
jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: {
    onAction: jest.fn(() => jest.fn()),
    onDataChange: jest.fn(() => jest.fn()),
  },
}))
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: { surfaces: Record<string, unknown> }) => unknown) =>
    selector({ surfaces: {} }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(clearEvents).mockResolvedValue(1)
})

afterEach(() => jest.restoreAllMocks())

it("shared controls: clear events waits for the themed confirmation", async () => {
  const nativeConfirm = jest.spyOn(window, "confirm").mockReturnValue(true)
  const user = userEvent.setup()
  render(<DebuggerTab />)
  await screen.findByText("surface-a")
  await user.click(screen.getByRole("button", { name: "clear" }))
  expect(clearEvents).not.toHaveBeenCalled()
  expect(nativeConfirm).not.toHaveBeenCalled()
  const dialog = screen.getByRole("alertdialog", { name: "confirmClear" })
  await user.click(within(dialog).getByRole("button", { name: "confirm" }))
  await waitFor(() => expect(clearEvents).toHaveBeenCalledTimes(1))
  expect(await screen.findByText("empty")).toBeVisible()
})

it.each(["cancel", "escape", "unmount"])(
  "shared controls: %s refuses clearing events",
  async (action) => {
    jest.spyOn(window, "confirm").mockReturnValue(true)
    const user = userEvent.setup()
    const view = render(<DebuggerTab />)
    await screen.findByText("surface-a")
    await user.click(screen.getByRole("button", { name: "clear" }))
    expect(clearEvents).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog")
    if (action === "cancel")
      await user.click(within(dialog).getByRole("button", { name: "cancel" }))
    else if (action === "escape") await user.keyboard("{Escape}")
    else view.unmount()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(clearEvents).not.toHaveBeenCalled()
    if (action !== "unmount") expect(screen.getByText("surface-a")).toBeVisible()
  }
)

it("selects a debugger event through the shared Button primitive", async () => {
  render(<DebuggerTab />)

  const surface = await screen.findByText("surface-a")
  const row = surface.closest("button")
  expect(row).toHaveAttribute("data-slot", "button")

  fireEvent.click(row!)
  expect(screen.getByText(/"action": "submit"/)).toBeInTheDocument()
})
