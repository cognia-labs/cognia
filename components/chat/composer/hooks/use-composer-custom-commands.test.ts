/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"

import { useComposerCustomCommands } from "./use-composer-custom-commands"

const loadCustomSlashCommands = jest.fn()
jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: (...args: unknown[]) => loadCustomSlashCommands(...args),
}))
let activeHost: string | null = null
const listeners = new Set<() => void>()
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => activeHost,
  subscribeActiveRemoteTransport: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))

const command = (name: string) => ({ name, description: name, scope: "workspace" })

beforeEach(() => {
  jest.clearAllMocks()
  activeHost = null
  listeners.clear()
})

it("lists the workspace's commands once the scan for this cwd lands", async () => {
  loadCustomSlashCommands.mockResolvedValue([command("deploy")])
  const { result } = renderHook(() =>
    useComposerCustomCommands({ isDesktop: true, cwd: "/repo", props: { session: null } })
  )

  expect(result.current.customCommands).toEqual([])
  await waitFor(() => expect(result.current.customCommands).toEqual([command("deploy")]))
  expect(loadCustomSlashCommands).toHaveBeenCalledWith("/repo", null)
  expect(result.current.memoryFilesAccess).toBe("available")
})

it("shows no commands from the previous workspace while the next scan is pending", async () => {
  let release: (list: unknown[]) => void = () => {}
  loadCustomSlashCommands.mockResolvedValueOnce([command("old")])
  const { result, rerender } = renderHook(
    ({ cwd }: { cwd: string }) =>
      useComposerCustomCommands({ isDesktop: true, cwd, props: { session: null } }),
    { initialProps: { cwd: "/a" } }
  )
  await waitFor(() => expect(result.current.customCommands).toEqual([command("old")]))

  loadCustomSlashCommands.mockImplementationOnce(() => new Promise((r) => (release = r)))
  rerender({ cwd: "/b" })
  expect(result.current.customCommands).toEqual([])
  await act(async () => release([command("new")]))
  expect(result.current.customCommands).toEqual([command("new")])
})

it("reads a bound conversation's commands from its Host and routes file memory there", async () => {
  loadCustomSlashCommands.mockResolvedValue([])
  const session = {
    id: "s1",
    hostBinding: {
      origin: { kind: "remote", hostId: "h1", accountId: "acc" },
      workspaceRoot: "/srv/repo",
    },
  } as unknown as ChatSession
  const { result } = renderHook(() =>
    useComposerCustomCommands({ isDesktop: true, cwd: "/srv/repo", props: { session } })
  )

  await waitFor(() => expect(loadCustomSlashCommands).toHaveBeenCalled())
  expect(loadCustomSlashCommands).toHaveBeenCalledWith("/srv/repo", {
    origin: { kind: "remote", hostId: "h1", accountId: "acc" },
    workspaceRoot: "/srv/repo",
  })
  expect(result.current.memoryFilesAccess).toBe("remote-host")
})

it("re-reads an unbound conversation's commands when the desktop switches Hosts", async () => {
  loadCustomSlashCommands.mockResolvedValue([])
  renderHook(() =>
    useComposerCustomCommands({ isDesktop: false, cwd: "/repo", props: { session: null } })
  )
  await waitFor(() => expect(loadCustomSlashCommands).toHaveBeenCalledTimes(1))

  act(() => {
    activeHost = "host-2"
    for (const listener of listeners) listener()
  })
  await waitFor(() => expect(loadCustomSlashCommands).toHaveBeenCalledTimes(2))
})
