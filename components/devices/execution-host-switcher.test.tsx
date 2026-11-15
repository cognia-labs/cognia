/**
 * @jest-environment jsdom
 */
import { act, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useExecutionHostTargets } from "./execution-host-switcher"
import {
  setRuntimeSnapshot,
  __resetRuntimeSnapshotForTesting,
} from "@/lib/runtime/runtime-snapshot-store"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))

// `var`, not `let`: `isTauri()` runs at module load, before a `let` exists.
// eslint-disable-next-line no-var -- hoisting is the point.
var mockTauri: boolean | undefined
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockTauri ?? true,
}))
let anyActive = false
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(anyActive),
}))

import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import {
  ExecutionHostSwitcher,
  StatusBarExecutionHost,
  executionHostOriginLabel,
  hostTone,
} from "./execution-host-switcher"

function host(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "h1",
    label: "Dev box",
    credentialRef: "ref",
    addedAt: 1,
    connectionState: "ready",
    config: { baseUrl: "https://box.example:27890", serverVersion: "1.0.0" },
    ...overrides,
  } as RemoteHost
}

const initial = useRemoteHostStore.getState()
const activate = jest.fn()
const deactivate = jest.fn()

function seed(hosts: RemoteHost[], activeHostId: string | null) {
  useRemoteHostStore.setState(
    { ...initial, hosts, activeHostId, activateHost: activate, deactivate },
    true
  )
}

beforeEach(() => {
  anyActive = false
  mockPush.mockClear()
  activate.mockClear()
  deactivate.mockClear()
  seed([], null)
})

afterAll(() => useRemoteHostStore.setState(initial, true))

it("tracks paired target, account and connection changes without registry mutation", () => {
  const { result } = renderHook(() => useExecutionHostTargets())
  try {
    act(() => {
      setActiveRuntimeTargetContext("account-a", "paired-a")
      setRuntimeSnapshot({
        target: { kind: "companion", id: "paired-a", platform: "web", hostKind: "desktop" },
        connectionState: "online",
        vaultState: "unlocked",
      })
    })
    expect(result.current.origin).toEqual({
      kind: "remote",
      hostId: "companion:paired-a",
      accountId: "account-a",
    })
    expect(result.current.baseTone).toBe("success")
    act(() => setActiveRuntimeTargetContext("account-b", "paired-a"))
    expect(result.current.origin).toEqual({
      kind: "remote",
      hostId: "companion:paired-a",
      accountId: "account-b",
    })
    act(() =>
      setRuntimeSnapshot({
        target: { kind: "companion", id: "paired-b", platform: "web", hostKind: "desktop" },
        connectionState: "offline",
        vaultState: "unlocked",
      })
    )
    expect(result.current.baseOrigin).toEqual({
      kind: "remote",
      hostId: "companion:paired-b",
      accountId: "account-b",
    })
    expect(result.current.baseTone).toBe("warning")
    expect(result.current.hosts).toEqual([])
  } finally {
    act(() => {
      clearActiveRuntimeTargetContext()
      __resetRuntimeSnapshotForTesting()
    })
  }
})

/**
 * The five connection states must not collapse into connected/not-connected.
 * `degraded` (answered, failed its capability probe), `versionMismatch` (needs
 * an upgrade before it accepts writes) and `revoked` (threw this device out)
 * each imply a different next step.
 */
it("labels a target by name, never by its registry id", () => {
  const t = (key: string) => `t:${key}`
  const hosts = [{ id: "h1", label: "Dev box" }]
  expect(executionHostOriginLabel({ kind: "local" }, hosts, t)).toBe("t:local")
  expect(executionHostOriginLabel({ kind: "remote", hostId: "h1" }, hosts, t)).toBe("Dev box")
  expect(executionHostOriginLabel({ kind: "remote", hostId: "companion:p" }, hosts, t)).toBe(
    "t:pairedHost"
  )
  expect(executionHostOriginLabel({ kind: "remote", hostId: "gone" }, hosts, t)).toBe(
    "t:removedHost"
  )
})

it("keeps every connection state on its own tone", () => {
  expect(hostTone(null)).toBe("neutral")
  expect(hostTone(host({ connectionState: "ready" }))).toBe("success")
  expect(hostTone(host({ connectionState: "connecting" }))).toBe("info")
  expect(hostTone(host({ connectionState: "degraded" }))).toBe("warning")
  expect(hostTone(host({ connectionState: "versionMismatch" }))).toBe("warning")
  expect(hostTone(host({ connectionState: "revoked" }))).toBe("danger")
  expect(hostTone(host({ connectionState: "disconnected" }))).toBe("neutral")
})

it("names the active host on the trigger and this machine when local", () => {
  seed([host()], "h1")
  const { rerender } = render(<ExecutionHostSwitcher />)
  expect(screen.getByTestId("execution-host-chip")).toHaveTextContent("Dev box")

  act(() => seed([host()], null))
  rerender(<ExecutionHostSwitcher />)
  expect(screen.getByTestId("execution-host-chip")).toHaveTextContent("devices.executionHost.local")
})

it("switches straight away when nothing is running", async () => {
  seed([host()], null)
  render(<ExecutionHostSwitcher />)
  await userEvent.click(screen.getByTestId("execution-host-chip"))
  await userEvent.click(await screen.findByTestId("execution-host-h1"))
  expect(activate).toHaveBeenCalledWith("h1")
})

/**
 * Repointing the transport under a live turn strands it on the machine it
 * started on, with no error and a conversation that never finishes.
 */
it("asks first when a turn is in flight", async () => {
  anyActive = true
  seed([host()], null)
  render(<ExecutionHostSwitcher />)
  await userEvent.click(screen.getByTestId("execution-host-chip"))
  await userEvent.click(await screen.findByTestId("execution-host-h1"))

  expect(activate).not.toHaveBeenCalled()
  await userEvent.click(await screen.findByTestId("execution-host-confirm"))
  expect(activate).toHaveBeenCalledWith("h1")
})

it("returns to local execution through the same guard", async () => {
  seed([host()], "h1")
  render(<ExecutionHostSwitcher />)
  await userEvent.click(screen.getByTestId("execution-host-chip"))
  await userEvent.click(await screen.findByTestId("execution-host-local"))
  expect(deactivate).toHaveBeenCalled()
})

/**
 * `CHROME_BUDGET.statusBar` is finite, and a permanent "This machine" chip on
 * a shell that has never seen a remote host is width with no information.
 */
it("renders no status-bar segment until there is a host to switch to", () => {
  const { container, rerender } = render(<StatusBarExecutionHost />)
  expect(container).toBeEmptyDOMElement()

  act(() => seed([host()], null))
  rerender(<StatusBarExecutionHost />)
  expect(screen.getByTestId("status-execution-host")).toBeInTheDocument()
})

/**
 * The status bar has no sheet of its own, so "Add a host" has to land on one
 * that exists rather than leaving "Manage devices" as the only way forward.
 */
it("offers to add a host from the status bar, opening the console's add-host sheet", async () => {
  seed([host()], null)
  render(<StatusBarExecutionHost />)
  await userEvent.click(screen.getByTestId("status-execution-host"))
  await userEvent.click(await screen.findByText("devices.executionHost.addHost"))
  expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/^\/devices\?addHost=.+/))
})

/**
 * Off the desktop there is no registry sheet: adding a Host is pairing this
 * client with one more on `/pair`, as the rest of the browser's chrome does.
 */
it("hands Add host to /pair off the desktop", async () => {
  mockTauri = false
  try {
    seed([host()], null)
    render(<StatusBarExecutionHost />)
    await userEvent.click(screen.getByTestId("status-execution-host"))
    await userEvent.click(await screen.findByText("devices.executionHost.addHost"))
    expect(mockPush).toHaveBeenCalledWith("/pair?mode=add")
  } finally {
    mockTauri = true
  }
})

/**
 * The sheet latches only a changed `?addHost=` value, so a second click must
 * not push the same URL the first one left behind.
 */
it("asks for the sheet with a fresh value every time", async () => {
  seed([host()], null)
  render(<StatusBarExecutionHost />)
  for (let i = 0; i < 2; i += 1) {
    await userEvent.click(screen.getByTestId("status-execution-host"))
    await userEvent.click(await screen.findByText("devices.executionHost.addHost"))
  }
  expect(mockPush).toHaveBeenCalledTimes(2)
  expect(mockPush.mock.calls[0][0]).not.toBe(mockPush.mock.calls[1][0])
})
