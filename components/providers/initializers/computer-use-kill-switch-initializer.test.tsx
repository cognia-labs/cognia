/**
 * @jest-environment jsdom
 */

import { render, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const listenMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

const clearAllSessionGrants = jest.fn()
jest.mock("@/lib/plugin/security/computer-use-session-grants", () => ({
  clearAllSessionGrants: () => clearAllSessionGrants(),
}))

const toastWarning = jest.fn()
jest.mock("sonner", () => ({ toast: { warning: (...a: unknown[]) => toastWarning(...a) } }))

// Route the real safeUnlisten so we assert the crash-prone unlisten is swallowed.
const safeUnlisten = jest.fn()
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: unknown) => safeUnlisten(fn),
}))

import { ComputerUseKillSwitchInitializer } from "./computer-use-kill-switch-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

describe("ComputerUseKillSwitchInitializer", () => {
  it("renders nothing", () => {
    listenMock.mockResolvedValue(() => {})
    const { container } = render(<ComputerUseKillSwitchInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("does not subscribe off the Tauri desktop", async () => {
    isTauriMock.mockReturnValue(false)
    render(<ComputerUseKillSwitchInitializer />)
    await Promise.resolve()
    expect(listenMock).not.toHaveBeenCalled()
  })

  it("subscribes to the kill-switch channel on the desktop", async () => {
    listenMock.mockResolvedValue(() => {})
    render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() =>
      expect(listenMock).toHaveBeenCalledWith("automation:kill-switch", expect.any(Function))
    )
  })

  it("clears session grants and toasts when the kill switch fires", async () => {
    let handler: (() => void) | undefined
    listenMock.mockImplementation(async (event: string, cb: () => void) => {
      if (event === "automation:kill-switch") handler = cb
      return () => {}
    })
    render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() => expect(handler).toBeDefined())
    handler!()
    expect(clearAllSessionGrants).toHaveBeenCalledTimes(1)
    expect(toastWarning).toHaveBeenCalledWith("Stopping local automation", expect.any(Object))
  })

  it("routes the unlisten through safeUnlisten on unmount", async () => {
    const rawUnlisten = jest.fn()
    listenMock.mockResolvedValue(rawUnlisten)
    const { unmount } = render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() => expect(listenMock).toHaveBeenCalled())
    unmount()
    expect(safeUnlisten).toHaveBeenCalledWith(rawUnlisten)
    // The raw, crash-prone unlisten is never invoked directly.
    expect(rawUnlisten).not.toHaveBeenCalled()
  })

  it("keeps settled state when stop events arrive out of order", async () => {
    const handlers = new Map<
      string,
      (event: { payload: { epoch: number; settled: boolean } }) => void
    >()
    listenMock.mockImplementation(
      async (
        name: string,
        handler: (event: { payload: { epoch: number; settled: boolean } }) => void
      ) => {
        handlers.set(name, handler)
        return () => {}
      }
    )
    render(<ComputerUseKillSwitchInitializer />)
    await waitFor(() => expect(handlers.size).toBe(2))
    handlers.get("automation:execution-settled")!({ payload: { epoch: 2, settled: true } })
    handlers.get("automation:kill-switch")!({ payload: { epoch: 2, settled: false } })
    expect(toastWarning).toHaveBeenLastCalledWith("Local automation stopped", expect.any(Object))
    handlers.get("automation:kill-switch")!({ payload: { epoch: 3, settled: false } })
    expect(toastWarning).toHaveBeenLastCalledWith("Stopping local automation", expect.any(Object))
  })

  it("safe-unlistens the late-resolving handle when unmounted before subscribe settles", async () => {
    const rawUnlisten = jest.fn()
    const resolveListen: ((u: () => void) => void)[] = []
    listenMock.mockImplementation(
      () => new Promise<() => void>((resolve) => resolveListen.push(resolve))
    )
    const { unmount } = render(<ComputerUseKillSwitchInitializer />)
    // Unmount before listen() settles — the StrictMode/early-cancel race.
    await waitFor(() => expect(resolveListen).toHaveLength(2))
    unmount()
    resolveListen.forEach((resolve) => resolve(rawUnlisten))
    await waitFor(() => expect(safeUnlisten).toHaveBeenCalledWith(rawUnlisten))
    expect(rawUnlisten).not.toHaveBeenCalled()
  })
})
