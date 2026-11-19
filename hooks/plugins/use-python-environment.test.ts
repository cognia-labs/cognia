/**
 * @jest-environment jsdom
 */

const mockGetReadiness = jest.fn()
const mockInstallDeps = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    getPythonReadiness: (...args: unknown[]) => mockGetReadiness(...args),
    installPythonDeps: (...args: unknown[]) => mockInstallDeps(...args),
  }),
}))
const mockRequestPrompt = jest.fn()
jest.mock("@/lib/plugin/python/prepare-prompt-requests", () => ({
  requestPythonPreparePrompt: (id: string) => mockRequestPrompt(id),
}))

import { act, renderHook, waitFor } from "@testing-library/react"

import { __resetPythonLogBufferForTesting, appendPythonEvent } from "@/lib/plugin/python/log-buffer"
import {
  __resetPythonReadinessStoreForTesting,
  recordPythonPreparation,
  recordPythonReadiness,
} from "@/stores/plugin-runtime/python-readiness-store"

import { usePythonEnvironment } from "./use-python-environment"

const python = { type: "python", pythonDependencies: ["requests>=2"] }

beforeEach(() => {
  __resetPythonReadinessStoreForTesting()
  __resetPythonLogBufferForTesting()
  mockGetReadiness.mockReset().mockResolvedValue(null)
  mockInstallDeps.mockReset().mockResolvedValue(null)
  mockRequestPrompt.mockReset()
})

describe("usePythonEnvironment", () => {
  it("does nothing for a plugin without a Python side", async () => {
    const { result } = renderHook(() =>
      usePythonEnvironment("ui", { type: "frontend", pythonDependencies: ["x"] })
    )
    expect(result.current.applies).toBe(false)
    expect(result.current.readiness).toBeNull()
    await act(async () => undefined)
    expect(mockGetReadiness).not.toHaveBeenCalled()
  })

  it("asks the Host once per plugin and declared requirements", async () => {
    const { rerender } = renderHook(({ manifest }) => usePythonEnvironment("demo", manifest), {
      initialProps: { manifest: python },
    })
    await waitFor(() => expect(mockGetReadiness).toHaveBeenCalledWith("demo"))
    rerender({ manifest: { ...python } })
    await act(async () => undefined)
    expect(mockGetReadiness).toHaveBeenCalledTimes(1)
    // An update that changes the requirements makes the answer stale.
    rerender({ manifest: { type: "python", pythonDependencies: ["requests>=2", "numpy"] } })
    await waitFor(() => expect(mockGetReadiness).toHaveBeenCalledTimes(2))
  })

  it("reads the readiness and the last preparation from the shared store", async () => {
    const { result } = renderHook(() => usePythonEnvironment("demo", python))
    expect(result.current.summary).toBeNull()
    act(() => {
      recordPythonReadiness("demo", {
        readiness: { state: "stale", reasons: ["dependencies"], installer: "uv" },
        interpreterWarning: null,
      })
      recordPythonPreparation("demo", { status: "failed", message: "uv exited 2" })
    })
    expect(result.current.summary).toBe("not-ready")
    expect(result.current.canPrepare).toBe(true)
    expect(result.current.lastPreparation).toEqual({ status: "failed", message: "uv exited 2" })
  })

  it("shows the latest install progress line only while a preparation runs", () => {
    const { result } = renderHook(() => usePythonEnvironment("demo", python))
    act(() => {
      appendPythonEvent({
        pluginId: "demo",
        generation: "installation",
        kind: "progress",
        data: { phase: "install", message: "Resolved 3 packages" },
      })
    })
    expect(result.current.progress).toBeNull()
    act(() => {
      recordPythonReadiness("demo", {
        readiness: { state: "preparing", installer: "uv" },
        interpreterWarning: null,
      })
    })
    expect(result.current.progress).toBe("Resolved 3 packages")
    expect(result.current.canPrepare).toBe(false)
    act(() => {
      // A plugin's own log line is not install progress.
      appendPythonEvent({
        pluginId: "demo",
        generation: "g1",
        kind: "log",
        data: { message: "hi" },
      })
      appendPythonEvent({
        pluginId: "demo",
        generation: "installation",
        kind: "progress",
        data: { phase: "install", message: " Installed 3 packages " },
      })
    })
    expect(result.current.progress).toBe("Installed 3 packages")
  })

  it("prepares through the manager with the declared requirements", async () => {
    const outcome = { venvDir: "/v", scope: "isolated", installer: "uv", downgradedReason: null }
    mockInstallDeps.mockResolvedValue(outcome)
    const { result } = renderHook(() => usePythonEnvironment("demo", python))
    await expect(result.current.prepare()).resolves.toEqual({ status: "succeeded", outcome })
    expect(mockInstallDeps).toHaveBeenCalledWith("demo", ["requests>=2"])
  })

  it("reports a failed preparation instead of throwing", async () => {
    mockInstallDeps.mockRejectedValue(new Error("no network"))
    const { result } = renderHook(() => usePythonEnvironment("demo", python))
    await expect(result.current.prepare()).resolves.toEqual({
      status: "failed",
      message: "no network",
    })
  })

  it("asks for consent through the prompt queue", () => {
    const { result } = renderHook(() => usePythonEnvironment("demo", python))
    result.current.requestPrepare()
    expect(mockRequestPrompt).toHaveBeenCalledWith("demo")
  })

  it("survives a manager that is not there", async () => {
    mockGetReadiness.mockRejectedValue(new Error("Plugin manager not initialized"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const { result } = renderHook(() => usePythonEnvironment("demo", python))
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.readiness).toBeNull()
    warn.mockRestore()
  })
})
