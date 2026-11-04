/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_BROWSER_ACCESS_PORT } from "@/lib/connectivity/loopback-discovery"

import { HeadlessInvitationHelp } from "./headless-invitation-help"

const mockWriteClipboardText = jest.fn()
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (value: string) => mockWriteClipboardText(value),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

beforeEach(() => {
  mockWriteClipboardText.mockReset()
  mockWriteClipboardText.mockResolvedValue(undefined)
})

/** Render the help expanded: it sits under the form, collapsed by default. */
function renderOpen() {
  const view = render(<HeadlessInvitationHelp />)
  fireEvent.click(screen.getByTestId("pair-headless-toggle"))
  return view
}

it("starts collapsed so the invitation field leads, with the storage warning outside the fold", () => {
  // Open, the command tabs and hints stacked a screen of material over a
  // phone-width page; most browser pairings come from a desktop invitation.
  render(<HeadlessInvitationHelp />)
  expect(screen.getByTestId("pair-headless-toggle")).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByTestId("pair-headless-command")).not.toBeInTheDocument()
  expect(screen.getByTestId("pair-web-storage-notice")).toBeInTheDocument()
  fireEvent.click(screen.getByTestId("pair-headless-toggle"))
  expect(screen.getByTestId("pair-headless-command")).toBeInTheDocument()
})

it("hands the web user an invitation aimed at a plane this browser can reach", () => {
  // `cognia-server pair` defaults to https://127.0.0.1:27890, and the pair
  // step refuses that invitation: `diagnoseTransport` / `web.httpsRequired`
  // exist precisely because a browser cannot validate the Host's self-signed
  // certificate. A development command that produced one would send the user
  // in a circle, so it must name the loopback listener explicitly.
  renderOpen()
  const command = screen.getByTestId("pair-headless-command").textContent ?? ""
  expect(command).toContain(`--advertise-url http://127.0.0.1:${DEFAULT_BROWSER_ACCESS_PORT}`)
  expect(command).not.toContain("https://")
  // The port must be the shared constant, not a second copy that can drift
  // from the Rust default and the discovery probe.
  expect(DEFAULT_BROWSER_ACCESS_PORT).toBe(27891)

  // And the hint below it must explain the development case, not the
  // deployment one — those are different topologies with different answers.
  expect(screen.getByText("developmentCommandHint")).toBeInTheDocument()
  expect(screen.queryByText("deploymentCommandHint")).not.toBeInTheDocument()
})

it("shows the command in full rather than cutting it mid-flag", () => {
  // It used to render `whitespace-nowrap overflow-x-auto`, which on the
  // two-column layout truncated the development command at `--device-name b:`
  // with no visible affordance — beside a copy button already showing a tick.
  renderOpen()
  const command = screen.getByTestId("pair-headless-command")
  expect(command).toHaveClass("break-all")
  expect(command.className).not.toContain("whitespace-nowrap")
})

it("copies whichever deployment's command is showing", async () => {
  const user = userEvent.setup()
  renderOpen()

  await user.click(screen.getByTestId("pair-copy-command"))
  expect(mockWriteClipboardText).toHaveBeenLastCalledWith(
    "pnpm --silent dev:headless pair --device-name browser --advertise-url http://127.0.0.1:27891"
  )

  await user.click(screen.getByRole("tab", { name: "commandMode.compose" }))
  expect(screen.getByTestId("pair-headless-command")).toHaveTextContent(
    "docker compose -f deploy/compose/docker-compose.yml"
  )
  await user.click(screen.getByTestId("pair-copy-command"))
  expect(mockWriteClipboardText).toHaveBeenLastCalledWith(
    "docker compose -f deploy/compose/docker-compose.yml --profile server exec cognia-server cognia-server pair --device-name browser"
  )

  await user.click(screen.getByRole("tab", { name: "commandMode.kubernetes" }))
  expect(screen.getByTestId("pair-headless-command")).toHaveTextContent(
    "kubectl -n <namespace> exec -i cognia-server-0"
  )
  expect(screen.getByText("deploymentCommandHint")).toBeInTheDocument()
})

it("renders exactly one command node, whatever tab is selected", async () => {
  // Three mounted `TabsContent` panes meant three nodes carrying one testid.
  renderOpen()
  expect(screen.getAllByTestId("pair-headless-command")).toHaveLength(1)
  await userEvent.click(screen.getByRole("tab", { name: "commandMode.compose" }))
  expect(screen.getAllByTestId("pair-headless-command")).toHaveLength(1)
})

it("keeps the localStorage-credential warning unconditional", () => {
  renderOpen()
  expect(screen.getByTestId("pair-web-storage-notice")).toHaveTextContent("storageNotice")
})
