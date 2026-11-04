import { act, renderHook, waitFor } from "@testing-library/react"
import { useOpencodeAuth } from "./use-opencode-auth"

jest.mock("@/lib/ai/agent/external/manager", () => ({ getExternalAgentManager: jest.fn() }))
jest.mock("@cognia/agent-opencode/v2-client", () => ({ openCodeV2Extension: "v2" }))
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"

function fixture() {
  const client = {
    integration: {
      list: jest.fn(async () => ({ data: [] })),
      oauth: {
        connect: jest.fn(async () => ({
          data: {
            attemptID: "a",
            url: "https://example.com/auth",
            mode: "auto",
            instructions: "",
            time: { created: Date.now(), expires: Date.now() + 60_000 },
          },
        })),
        cancel: jest.fn(async () => {}),
      },
    },
  }
  const adapter = { getAuthClient: () => client }
  jest.mocked(getExternalAgentManager).mockReturnValue({
    getAdapterExtension: jest.fn(() => adapter),
    addLifecycleListener: jest.fn(() => () => {}),
    getAgent: () => ({ config: { process: { cwd: "/repo" } } }),
  } as never)
  return client
}

it("does not discover or start login for disconnected Agents", () => {
  const client = fixture()
  const { result } = renderHook(() => useOpencodeAuth("a", false))
  expect(result.current.available).toBe(false)
  expect(client.integration.list).not.toHaveBeenCalled()
})

it("refreshes service state on focus and cancels owned attempts on Agent switch", async () => {
  const client = fixture()
  const { result, rerender, unmount } = renderHook(({ id }) => useOpencodeAuth(id, true), {
    initialProps: { id: "a" },
  })
  await waitFor(() => expect(result.current.available).toBe(true))
  await act(async () => {
    await result.current.controller!.start("opencode", "device", {})
  })
  act(() => {
    window.dispatchEvent(new Event("focus"))
  })
  await waitFor(() => expect(client.integration.list).toHaveBeenCalledTimes(2))
  rerender({ id: "b" })
  await waitFor(() => expect(client.integration.oauth.cancel).toHaveBeenCalledTimes(1))
  expect(result.current.snapshot.attempt).toBeUndefined()
  unmount()
})

it("ignores discovery finishing after unmount", async () => {
  const client = fixture()
  const { unmount } = renderHook(() => useOpencodeAuth("a", true))
  unmount()
  await act(async () => {})
  expect(client.integration.list).not.toHaveBeenCalled()
})

it("rebinds the same Agent when its service client changes", async () => {
  const old = fixture()
  const manager = jest.mocked(getExternalAgentManager)()
  const listeners: Array<(event: { agentId: string }) => void> = []
  jest.mocked(manager.addLifecycleListener).mockImplementation((listener) => {
    listeners.push(listener as never)
    return () => {}
  })
  const { result, unmount } = renderHook(() => useOpencodeAuth("a", true))
  await waitFor(() => expect(result.current.available).toBe(true))
  await act(async () => {
    await result.current.controller!.start("opencode", "device", {})
  })
  const next = fixture()
  jest.mocked(manager.getAdapterExtension).mockReturnValue({ getAuthClient: () => next } as never)
  act(() => {
    listeners[0]({ agentId: "a" })
  })
  await waitFor(() => expect(old.integration.oauth.cancel).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(next.integration.list).toHaveBeenCalledTimes(1))
  expect(result.current.snapshot.attempt).toBeUndefined()
  unmount()
})
