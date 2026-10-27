/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const capabilities = jest.fn()
jest.mock("@/lib/automation/client", () => ({
  desktop: { capabilities: (...a: unknown[]) => capabilities(...a) },
}))

const recordPreflight = jest.fn()
jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordPreflight: (...a: unknown[]) => recordPreflight(...a),
}))

const listeners = new Map<string, (payload: unknown) => void>()
const unlisten = jest.fn()
const call = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: {
    call: (...a: unknown[]) => call(...a),
    subscribe: jest.fn((event: string, cb: (payload: unknown) => void) => {
      listeners.set(event, cb)
      return unlisten
    }),
  },
}))

import { isTauri } from "@/lib/tauri"

import {
  BACKEND_INIT_FAILED_EVENT,
  applicableOsPermissions,
  missingOsPermissions,
  useAutomationHostStatus,
} from "./use-automation-host-status"

const CAPS = { platform: "macos", hasUia: false, hasA11yTree: true }

beforeEach(() => {
  listeners.clear()
  unlisten.mockReset()
  ;(isTauri as jest.Mock).mockReturnValue(true)
  capabilities.mockReset().mockResolvedValue(CAPS)
  call.mockReset().mockResolvedValue(null)
  recordPreflight.mockReset().mockResolvedValue({
    accessibility: "ok",
    screenRecording: "missing",
    uiAutomation: "notApplicable",
    inputMonitoring: "missing",
    blockers: ["pluginNotInstalled"],
  })
})

describe("missingOsPermissions / applicableOsPermissions", () => {
  const permissions = {
    accessibility: "missing",
    screenRecording: "unknown",
    uiAutomation: "notApplicable",
  } as const

  it("treats only a definite miss as a gap", () => {
    expect(missingOsPermissions(permissions)).toEqual(["accessibility"])
    expect(missingOsPermissions(null)).toEqual([])
    expect(missingOsPermissions(undefined)).toEqual([])
  })

  it("lists what applies to this platform", () => {
    expect(applicableOsPermissions(permissions)).toEqual(["accessibility", "screenRecording"])
  })
})

describe("useAutomationHostStatus", () => {
  it("reads capabilities and only the automation-relevant OS probes", async () => {
    const { result } = renderHook(() => useAutomationHostStatus())
    await waitFor(() => expect(result.current.caps).toEqual(CAPS))
    await waitFor(() =>
      expect(result.current.permissions).toEqual({
        accessibility: "ok",
        screenRecording: "missing",
        uiAutomation: "notApplicable",
      })
    )
  })

  it("reports failed probes as null rather than leaving them loading", async () => {
    capabilities.mockRejectedValue(new Error("boom"))
    recordPreflight.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useAutomationHostStatus())
    await waitFor(() => expect(result.current.caps).toBeNull())
    await waitFor(() => expect(result.current.permissions).toBeNull())
  })

  it("surfaces a backend failure stashed before the window listened", async () => {
    call.mockResolvedValue({ platform: "macos", error: "AX init failed" })
    const { result } = renderHook(() => useAutomationHostStatus())
    expect(call).toHaveBeenCalledWith("automation_drain_init_failure", {})
    await waitFor(() =>
      expect(result.current.initFailure).toEqual({ platform: "macos", error: "AX init failed" })
    )
    act(() => result.current.dismissInitFailure())
    expect(result.current.initFailure).toBeNull()
  })

  it("surfaces a backend failure that arrives later, and stops listening on unmount", async () => {
    const { result, unmount } = renderHook(() => useAutomationHostStatus())
    await waitFor(() => expect(listeners.has(BACKEND_INIT_FAILED_EVENT)).toBe(true))
    act(() => listeners.get(BACKEND_INIT_FAILED_EVENT)!({ platform: "linux", error: "no X" }))
    expect(result.current.initFailure).toEqual({ platform: "linux", error: "no X" })
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("re-probes on demand", async () => {
    const { result } = renderHook(() => useAutomationHostStatus())
    await waitFor(() => expect(result.current.permissions?.screenRecording).toBe("missing"))
    recordPreflight.mockResolvedValue({
      accessibility: "ok",
      screenRecording: "ok",
      uiAutomation: "notApplicable",
    })
    await act(() => result.current.refreshPermissions())
    expect(result.current.permissions?.screenRecording).toBe("ok")
  })

  it("probes nothing off the desktop shell", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    const { result } = renderHook(() => useAutomationHostStatus())
    expect(capabilities).not.toHaveBeenCalled()
    expect(recordPreflight).not.toHaveBeenCalled()
    expect(result.current.caps).toBeUndefined()
  })
})
