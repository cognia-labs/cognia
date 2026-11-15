/** @jest-environment jsdom */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"
import type { TaskWorkspaceOrigin } from "@/lib/task-workspace/types"
import type {
  ExecutionHostSwitchOptions,
  ExecutionHostSwitchOutcome,
} from "@/hooks/devices/use-execution-host-switch"

jest.mock("next-intl", () => ({
  useTranslations:
    (ns: string) =>
    (key: string, values: Record<string, string> = {}) => {
      const messages = {
        chat: jest.requireActual("@/i18n/messages/en/chat.json"),
        devices: jest.requireActual("@/i18n/messages/en/devices.json"),
      }
      let value: unknown = messages
      for (const part of `${ns}.${key}`.split(".")) value = (value as Record<string, unknown>)[part]
      if (typeof value !== "string") throw new Error(`Missing translation: ${ns}.${key}`)
      return Object.entries(values).reduce(
        (text, [name, replacement]) => text.replaceAll(`{${name}}`, replacement),
        value
      )
    },
}))
let mockActive: TaskWorkspaceOrigin = { kind: "remote", hostId: "b" }
let mockSession: Pick<ChatSession, "id" | "hostBinding">
const mockDb = {}
const twoHosts = [
  { id: "a", label: "Host A", connectionState: "ready" },
  { id: "b", label: "Host B", connectionState: "disconnected" },
]
let mockHosts = twoHosts
jest.mock("@/components/devices/execution-host-switcher", () => ({
  executionHostOriginLabel: jest.requireActual("@/components/devices/execution-host-switcher")
    .executionHostOriginLabel,
  useExecutionHostTargets: () => ({
    hosts: mockHosts,
    origin: mockActive,
    baseOrigin: { kind: "local" },
    baseTone: "neutral",
  }),
  hostTone: (host: { connectionState: string } | null) =>
    host?.connectionState === "ready" ? "success" : "neutral",
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockSession }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDb }))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  updateSessionHostBinding: jest.fn(
    async (_id: string, hostBinding: NonNullable<ChatSession["hostBinding"]>) => {
      mockSession = { ...mockSession, hostBinding }
    }
  ),
}))
jest.mock("@/lib/task-workspace/origin", () => ({
  ...jest.requireActual("@/lib/task-workspace/origin"),
  captureTaskWorkspaceOrigin: () => mockActive,
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  ...jest.requireActual("@/lib/runtime/runtime-target-context"),
  getActiveRuntimeTargetContext: jest.fn(() => null),
}))
jest.mock("@/lib/chat/session-host-binding", () => ({
  ...jest.requireActual("@/lib/chat/session-host-binding"),
  sessionHostWorkspaceRoots: jest.fn(async () => ["/host/repo", "/host/other"]),
}))
jest.mock("@/hooks/devices/use-execution-host-switch", () => ({
  useExecutionHostSwitch: () => ({ requestSwitch: mockRequestSwitch, dialog: null }),
}))
const mockRequestSwitch = jest.fn(
  async (
    hostId: string | null,
    options: ExecutionHostSwitchOptions
  ): Promise<ExecutionHostSwitchOutcome> => {
    mockActive = hostId === null ? { kind: "local" } : { kind: "remote", hostId }
    options.onSwitched?.()
    options.onSettled?.(true)
    return "switched"
  }
)

import { updateSessionHostBinding } from "@/lib/db/sessions"
import { sessionHostWorkspaceRoots } from "@/lib/chat/session-host-binding"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { SessionHostTargetChip } from "./session-host-target-chip"

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getActiveRuntimeTargetContext).mockReturnValue(null)
  mockActive = { kind: "remote", hostId: "b" }
  mockHosts = twoHosts
  mockSession = {
    id: "session",
    hostBinding: { origin: { kind: "remote", hostId: "a" }, workspaceRoot: "/bound/repo" },
  }
})

it("shows the bound Host and workspace with a visible active-Host mismatch", () => {
  render(<SessionHostTargetChip session={mockSession} />)
  const chip = screen.getByRole("button", {
    name: "Target Host: Host A; workspace: /bound/repo. Switch required",
  })
  expect(chip).toHaveAttribute("data-host-mismatch", "true")
  expect(chip).toHaveAttribute("data-tone", "warning")
  expect(screen.getByText("Switch required")).toBeVisible()
})

it("shows the active Host an unbound session will use", () => {
  mockSession = { id: "new" }
  render(<SessionHostTargetChip session={mockSession} />)
  expect(
    screen.getByRole("button", { name: /Target Host: Host B; workspace: Default workspace/ })
  ).not.toHaveAttribute("data-host-mismatch")
})

it("stays out of the toolbar when this device is the only target", () => {
  mockHosts = []
  mockActive = { kind: "local" }
  mockSession = { id: "new" }
  const { rerender } = render(<SessionHostTargetChip session={mockSession} />)
  expect(screen.queryByRole("button", { name: /Target Host:/ })).toBeNull()
  // A session bound to a Host that is no longer registered still shows the mismatch.
  mockSession = { id: "new", hostBinding: { origin: { kind: "remote", hostId: "gone" } } }
  rerender(<SessionHostTargetChip session={mockSession} />)
  expect(
    screen.getByRole("button", { name: /Target Host: Removed Host.*Switch required/ })
  ).toBeVisible()
})

it("does not mark another account on the same Host as the selected target", async () => {
  mockActive = { kind: "remote", hostId: "a", accountId: "account-b" }
  mockSession.hostBinding!.origin = { kind: "remote", hostId: "a", accountId: "account-a" }
  jest.mocked(getActiveRuntimeTargetContext).mockReturnValue({
    accountId: "account-b",
    targetId: "target-b",
    routingGeneration: 1,
  })
  const user = userEvent.setup()
  render(<SessionHostTargetChip session={mockSession} />)
  await user.click(screen.getByRole("button", { name: /Target Host:.*Switch required/ }))
  expect(screen.getByRole("button", { name: "Host A · Ready" })).toHaveAttribute(
    "aria-pressed",
    "false"
  )
})

it("lists registry Hosts and fetches the bound Host's roots even while another is active", async () => {
  const user = userEvent.setup()
  render(<SessionHostTargetChip session={mockSession} />)
  await user.click(screen.getByRole("button", { name: /Target Host:/ }))
  expect(screen.getByRole("group", { name: "Hosts" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Host B · Not connected" })).toBeVisible()
  expect(await screen.findByRole("button", { name: "Use workspace /host/repo" })).toBeVisible()
  expect(sessionHostWorkspaceRoots).toHaveBeenCalledWith({ kind: "remote", hostId: "a" })
})

it("rebinds only after the guarded Host switch succeeds", async () => {
  const user = userEvent.setup()
  render(<SessionHostTargetChip session={mockSession} />)
  await user.click(screen.getByRole("button", { name: /Target Host:/ }))
  await user.click(screen.getByRole("button", { name: "Host B · Not connected" }))
  await waitFor(() =>
    expect(updateSessionHostBinding).toHaveBeenCalledWith("session", {
      origin: { kind: "remote", hostId: "b" },
      workspaceRoot: "/host/repo",
    })
  )
  expect(mockRequestSwitch).toHaveBeenCalledWith(
    "b",
    expect.objectContaining({ onSwitched: expect.any(Function) })
  )
})

it("preserves the binding when the switch is cancelled", async () => {
  mockRequestSwitch.mockImplementationOnce(async (_hostId, options) => {
    options.onSettled?.(false)
    return "confirming"
  })
  const user = userEvent.setup()
  render(<SessionHostTargetChip session={mockSession} />)
  await user.click(screen.getByRole("button", { name: /Target Host:/ }))
  await user.click(screen.getByRole("button", { name: "Host B · Not connected" }))
  expect(updateSessionHostBinding).not.toHaveBeenCalled()
})

it("opens by keyboard, focuses an option, selects a workspace and restores trigger focus", async () => {
  const user = userEvent.setup()
  render(<SessionHostTargetChip session={mockSession} />)
  const trigger = screen.getByRole("button", { name: /Target Host:/ })
  trigger.focus()
  await user.keyboard("{Enter}")
  const popup = screen.getByRole("dialog", { name: "Choose conversation target" })
  expect(within(popup).getByRole("button", { name: "This machine" })).toHaveFocus()
  const workspace = await screen.findByRole("button", { name: "Use workspace /host/other" })
  // Tab traverses every Host and root button; no pointer interaction is needed.
  for (let i = 0; i < 4; i++) await user.tab()
  expect(workspace).toHaveFocus()
  await user.keyboard("{Enter}")
  await waitFor(() =>
    expect(updateSessionHostBinding).toHaveBeenCalledWith("session", {
      origin: { kind: "remote", hostId: "a" },
      workspaceRoot: "/host/other",
    })
  )
  await waitFor(() => expect(trigger).toHaveFocus())
})
