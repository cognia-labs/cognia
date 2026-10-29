import { renderHook, waitFor } from "@testing-library/react"
jest.mock("@/hooks/automation/use-sandbox-connections", () => ({
  useSandboxConnections: jest.fn(),
}))
jest.mock("@/lib/automation/managed-desktop-client", () => ({
  managedDesktopClient: { list: jest.fn(), listConfigs: jest.fn() },
  managedDesktopTargetConfig: () => "local-host",
  subscribeManagedDesktopTargetChanges: () => () => {},
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: object) => unknown) =>
    selector({ unlockedAccountId: "owner", locked: false }),
}))
jest.mock("@/lib/sandbox/managed-desktop-binding", () => ({
  watchManagedDesktopBindings: jest.fn(() => jest.fn()),
}))

import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import {
  managedDesktopClient,
  type ManagedDesktopConfigSummary,
  type ManagedDesktopResource,
} from "@/lib/automation/managed-desktop-client"
import { watchManagedDesktopBindings } from "@/lib/sandbox/managed-desktop-binding"
import { useComputerUseTargets } from "./use-computer-use-targets"
import type { SandboxConnectionRow } from "@/types/sandbox"

const api = jest.mocked(managedDesktopClient)
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useSandboxConnections).mockReturnValue({
    connections: [
      { id: "gui", provider: "docker", capabilities: { gui: true } },
      { id: "no-gui", provider: "docker", capabilities: { gui: false } },
      { id: "managed:other:1", provider: "e2b", capabilities: { gui: true } },
    ] as SandboxConnectionRow[],
  } as ReturnType<typeof useSandboxConnections>)
  api.list.mockResolvedValue([
    { id: "running", providerConfigId: "enabled", state: "running", generation: 1 },
    { id: "off", providerConfigId: "disabled", state: "running", generation: 1 },
    { id: "gone", providerConfigId: "enabled", state: "destroyed", generation: 1 },
  ] as ManagedDesktopResource[])
  const config = {
    qualification: "qualified",
    qualificationEvidenceVersion: 2,
    workloadIsolationRevision: 1,
    egressEnforcement: "provider-and-guest-kernel",
  }
  api.listConfigs.mockResolvedValue([
    { ...config, id: "enabled", enablement: { agentControl: true } },
    { ...config, id: "disabled", enablement: { agentControl: false } },
  ] as ManagedDesktopConfigSummary[])
})

it("filters non-GUI rows, loads running desktops only from the local Host, and observes revocation", async () => {
  const { result, unmount } = renderHook(useComputerUseTargets)
  await waitFor(() => expect(result.current.managed).toHaveLength(2))
  expect(result.current.connections.map((row) => row.id)).toEqual(["gui"])
  expect(result.current.managed.map((entry) => entry.enabled)).toEqual([true, false])
  expect(api.list).toHaveBeenCalledWith({ kind: "local" })
  expect(api.listConfigs).toHaveBeenCalledWith({ kind: "local" })
  unmount()
  expect(jest.mocked(watchManagedDesktopBindings).mock.results[0].value).toHaveBeenCalled()
})

it("keeps generic targets available when the Host cannot be read", async () => {
  api.list.mockRejectedValue(new Error("offline"))
  const { result } = renderHook(useComputerUseTargets)
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.managed).toEqual([])
  expect(result.current.connections.map((row) => row.id)).toEqual(["gui"])
})

it("handles a locked-account refusal during synchronous watch setup", async () => {
  jest.mocked(watchManagedDesktopBindings).mockImplementationOnce(() => {
    throw new Error("locked")
  })
  const { result } = renderHook(useComputerUseTargets)
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.managed).toEqual([])
  expect(api.list).not.toHaveBeenCalled()
})
