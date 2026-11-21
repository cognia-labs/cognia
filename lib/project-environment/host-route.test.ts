/** @jest-environment jsdom */

const mockLoadCompanionConfig = jest.fn(() => null as unknown)
jest.mock("@/lib/tauri/transport-companion", () => ({
  ...jest.requireActual("@/lib/tauri/transport-companion"),
  loadCompanionConfig: () => mockLoadCompanionConfig(),
}))

import {
  __resetEnvironmentHostRouteForTests,
  captureEnvironmentHostRoute,
  currentEnvironmentHostIdentity,
  currentEnvironmentHostKey,
  currentEnvironmentHostScopeKey,
  ExecutionRouteChangedError,
  subscribeEnvironmentHostChange,
} from "./host-route"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { localTransport, setTransport, transport } from "@/lib/tauri/transport-instance"
import {
  __resetRoutingForTests,
  RoutingTransport,
  setActiveRemoteEndpoint,
  setActiveRemoteTransport,
  type RemoteHostEndpoint,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"

function mockTransport(label: string) {
  const call = jest.fn(async (name: string) => ({ host: label, name }))
  const destroy = jest.fn()
  const instance: Transport & { destroy: jest.Mock } = {
    call: call as unknown as Transport["call"],
    subscribe: jest.fn(() => () => undefined),
    destroy,
  }
  return { instance, call, destroy }
}

function remoteEndpoint(over: Partial<RemoteHostEndpoint> = {}): RemoteHostEndpoint {
  return {
    remoteHost: { id: "host-a", label: "Host A" },
    baseUrl: "https://host-a.example:27890/",
    deviceId: "dev-a",
    devicePrivateKeyJwk: { kty: "EC" },
    deviceKeyThumbprint: "thumb-a",
    serverVersion: "4",
    ...over,
  }
}

const originalTransport = transport

beforeEach(() => {
  __resetRoutingForTests()
  clearActiveRuntimeTargetContext()
  __resetEnvironmentHostRouteForTests()
  mockLoadCompanionConfig.mockReset().mockReturnValue(null)
  jest.restoreAllMocks()
  setTransport(originalTransport)
})

afterEach(() => {
  __resetRoutingForTests()
  clearActiveRuntimeTargetContext()
  __resetEnvironmentHostRouteForTests()
  mockLoadCompanionConfig.mockReset().mockReturnValue(null)
  jest.restoreAllMocks()
  setTransport(originalTransport)
})

describe("environment host identity and scope", () => {
  it("resolves local, remote id, remote endpoint fallback, unnamed ephemeral, and paired hosts", () => {
    expect(currentEnvironmentHostIdentity()).toEqual({ hostKey: "local", cacheable: true })
    expect(currentEnvironmentHostScopeKey()).toBe("local")

    const remoteA = mockTransport("a")
    setActiveRemoteTransport(remoteA.instance)
    expect(currentEnvironmentHostIdentity()).toEqual({
      hostKey: "remote-ephemeral:1",
      cacheable: false,
    })

    setActiveRemoteEndpoint(remoteEndpoint({ remoteHost: undefined }))
    expect(currentEnvironmentHostIdentity()).toEqual({
      hostKey: "remote-endpoint:https://host-a.example:27890:dev-a:",
      cacheable: true,
    })

    setActiveRemoteEndpoint(remoteEndpoint())
    expect(currentEnvironmentHostIdentity()).toEqual({
      hostKey: "remote:host-a",
      cacheable: true,
    })
    expect(currentEnvironmentHostKey()).toBe("remote:host-a")
    expect(currentEnvironmentHostScopeKey()).toBe("remote:host-a#t1")

    setActiveRemoteTransport(null)
    setActiveRemoteEndpoint(null)

    setActiveRuntimeTargetContext("acct-01", "tgt-1", 3)
    expect(currentEnvironmentHostIdentity()).toEqual({
      hostKey: "paired:acct-01:tgt-1",
      cacheable: true,
    })
    expect(currentEnvironmentHostScopeKey()).toContain("paired:acct-01:tgt-1#g3:")

    clearActiveRuntimeTargetContext()
    mockLoadCompanionConfig.mockReturnValue({
      baseUrl: "https://paired.example:27890/",
      deviceId: "dev-p",
      deviceName: "Phone",
      targetId: "tgt-p",
      accountId: "acct-p",
      devicePrivateKeyJwk: { kty: "EC" },
      devicePublicKeySpki: "spki",
      serverVersion: "4",
    })
    expect(currentEnvironmentHostIdentity()).toEqual({
      hostKey: "paired-endpoint:https://paired.example:27890:dev-p:tgt-p:acct-p",
      cacheable: true,
    })
  })

  it("notifies subscribers on remote transport, remote endpoint, target context, and transport swaps", () => {
    const listener = jest.fn()
    const stop = subscribeEnvironmentHostChange(listener)
    try {
      const remoteA = mockTransport("a")
      setActiveRemoteTransport(remoteA.instance)
      expect(listener).toHaveBeenCalledTimes(1)

      setActiveRemoteEndpoint(remoteEndpoint())
      expect(listener).toHaveBeenCalledTimes(2)

      setActiveRuntimeTargetContext("acct-01", "tgt-1", 1)
      expect(listener).toHaveBeenCalledTimes(3)

      const custom = mockTransport("custom")
      setTransport(custom.instance)
      expect(listener).toHaveBeenCalledTimes(4)
    } finally {
      stop()
    }
  })
})

describe("captureEnvironmentHostRoute", () => {
  it("retains the original desktop remote transport across a Host switch until released", async () => {
    const remoteA = mockTransport("a")
    const remoteB = mockTransport("b")
    setActiveRemoteEndpoint(remoteEndpoint({ remoteHost: { id: "host-a", label: "A" } }))
    setActiveRemoteTransport(remoteA.instance)

    const route = captureEnvironmentHostRoute()
    expect(route.hostKey).toBe("remote:host-a")
    expect(route.reachableAfterSwitch).toBe(true)
    expect(route.isCurrent()).toBe(true)

    setActiveRemoteEndpoint(remoteEndpoint({ remoteHost: { id: "host-b", label: "B" } }))
    setActiveRemoteTransport(remoteB.instance)
    expect(route.isCurrent()).toBe(false)
    expect(remoteA.destroy).not.toHaveBeenCalled()

    await expect(route.transport.call("project_environment_execute", {})).resolves.toEqual({
      host: "a",
      name: "project_environment_execute",
    })
    expect(remoteB.call).not.toHaveBeenCalled()

    route.release()
    route.release()
    expect(remoteA.destroy).toHaveBeenCalledTimes(1)
  })

  it("keeps desktop local routes on localTransport after switching to a remote Host", async () => {
    setTransport(new RoutingTransport(localTransport))
    const localCall = jest.spyOn(localTransport, "call").mockResolvedValue("local-ok" as never)
    const remoteB = mockTransport("b")
    try {
      const route = captureEnvironmentHostRoute()
      expect(route.hostKey).toBe("local")
      expect(route.reachableAfterSwitch).toBe(true)

      setActiveRemoteTransport(remoteB.instance)
      expect(route.isCurrent()).toBe(false)
      await expect(route.transport.call("project_environment_execute", {})).resolves.toBe(
        "local-ok"
      )
      expect(remoteB.call).not.toHaveBeenCalled()
      route.release()
    } finally {
      localCall.mockRestore()
    }
  })

  it("fails closed with ExecutionRouteChangedError when a paired client switches targets", async () => {
    const paired = mockTransport("paired")
    setTransport(paired.instance)
    setActiveRuntimeTargetContext("acct-01", "tgt-a", 1)

    const route = captureEnvironmentHostRoute()
    expect(route.hostKey).toBe("paired:acct-01:tgt-a")
    expect(route.reachableAfterSwitch).toBe(false)
    expect(route.isCurrent()).toBe(true)

    setActiveRuntimeTargetContext("acct-01", "tgt-b", 2)
    expect(route.isCurrent()).toBe(false)
    expect(() => route.assertCurrent()).toThrow(ExecutionRouteChangedError)
    await expect(route.transport.call("project_environment_execute", {})).rejects.toThrow(
      ExecutionRouteChangedError
    )
    expect(paired.call).not.toHaveBeenCalled()
    route.release()
  })
})
