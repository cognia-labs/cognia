import { act, renderHook, waitFor } from "@testing-library/react"

import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import {
  __resetPortsForTesting,
  __setPortForTesting,
  __setPortModulesForTesting,
} from "@/lib/modules/ports"

import { usePort } from "./use-port"

interface GreeterPort {
  greet(): string
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "test.greeter": GreeterPort
  }
}

const warn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { app: { warn: (...a: unknown[]) => warn(...a) } },
}))

const greeter: GreeterPort = { greet: () => "hi" }

function providing(load: () => Promise<unknown>): HostModuleManifest[] {
  return [
    {
      id: "greeting",
      kind: "module",
      stage: "stable",
      provides: [{ port: "test.greeter", load: load as () => Promise<{ port: unknown }> }],
    },
  ]
}

beforeEach(() => {
  __resetPortsForTesting()
  warn.mockClear()
})

describe("usePort", () => {
  it("is undefined while the port loads, then the implementation", async () => {
    __setPortModulesForTesting(providing(async () => ({ port: greeter })))
    const { result } = renderHook(() => usePort("test.greeter"))
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(greeter))
  })

  it("is null when no module provides the port", async () => {
    __setPortModulesForTesting([])
    const { result } = renderHook(() => usePort("test.greeter"))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it("does not load again once the port is known", () => {
    const load = jest.fn(async () => ({ port: greeter }))
    __setPortModulesForTesting(providing(load))
    __setPortForTesting("test.greeter", greeter)
    const { result } = renderHook(() => usePort("test.greeter"))
    expect(result.current).toBe(greeter)
    expect(load).not.toHaveBeenCalled()
  })

  it("follows a port that resolves after it mounted", () => {
    __setPortModulesForTesting(providing(() => new Promise(() => {})))
    const { result } = renderHook(() => usePort("test.greeter"))
    act(() => __setPortForTesting("test.greeter", greeter))
    expect(result.current).toBe(greeter)
  })

  it("logs a load that fails and stays undefined", async () => {
    __setPortModulesForTesting(providing(async () => Promise.reject(new Error("offline"))))
    const { result } = renderHook(() => usePort("test.greeter"))
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith("port failed to load", {
        port: "test.greeter",
        err: "offline",
      })
    )
    expect(result.current).toBeUndefined()
  })
})
