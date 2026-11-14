jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false), transport: { id: "paired" } }))
jest.mock("@/lib/tauri/transport-companion", () => ({ loadCompanionConfig: jest.fn() }))

import { isTauri, transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { setActiveRemoteEndpoint, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import {
  getExecutionHostScopeKey,
  getRemoteExecutionHost,
  isSameExecutionHost,
  subscribeExecutionHost,
} from "./execution-host"

const remoteEndpoint = {
  remoteHost: { id: "box", label: "  Build box  " },
  baseUrl: "https://box.example:7890",
  deviceId: "desktop-device",
  devicePrivateKeyJwk: {},
  deviceKeyThumbprint: "thumb",
  serverVersion: "1.0.0",
  serverFingerprint: "fp",
}

function remoteTransport() {
  return { call: jest.fn(), subscribe: jest.fn() } as never
}

beforeEach(() => {
  jest.mocked(isTauri).mockReturnValue(false)
  jest.mocked(loadCompanionConfig).mockReturnValue(null)
  clearActiveRuntimeTargetContext()
})
afterEach(() => {
  setActiveRemoteTransport(null)
  setActiveRemoteEndpoint(null)
  clearActiveRuntimeTargetContext()
})

describe("this device", () => {
  it("is the executor without a pairing or a remote Host", () => {
    expect(getRemoteExecutionHost()).toBeNull()
    expect(getExecutionHostScopeKey()).toBe(JSON.stringify(["this-device"]))
  })

  it("ignores a pairing for another runtime target", () => {
    setActiveRuntimeTargetContext("account-one", "host-two")
    jest
      .mocked(loadCompanionConfig)
      .mockReturnValue({ targetId: "host-one", deviceId: "device", baseUrl: "https://h" } as never)
    expect(getRemoteExecutionHost()).toBeNull()
  })

  it("ignores a stored pairing on a desktop that drives no remote Host", () => {
    jest.mocked(isTauri).mockReturnValue(true)
    setActiveRuntimeTargetContext("account-one", "host-one")
    jest
      .mocked(loadCompanionConfig)
      .mockReturnValue({ targetId: "host-one", deviceId: "device", baseUrl: "https://h" } as never)
    expect(getRemoteExecutionHost()).toBeNull()
  })
})

describe("a paired client", () => {
  beforeEach(() => {
    setActiveRuntimeTargetContext("account-one", "host-one")
    jest.mocked(loadCompanionConfig).mockReturnValue({
      targetId: "host-one",
      deviceId: "phone",
      baseUrl: "https://192.168.1.42:7890",
      hostName: "Studio Mac",
    } as never)
  })

  it("sends to the paired transport and names the Host", () => {
    const host = getRemoteExecutionHost()
    expect(host).toMatchObject({ kind: "paired-client", label: "Studio Mac" })
    expect(host?.transport).toBe(transport)
  })

  it("falls back to the Host's address when it reported no name", () => {
    jest.mocked(loadCompanionConfig).mockReturnValue({
      targetId: "host-one",
      deviceId: "phone",
      baseUrl: "https://192.168.1.42:7890",
    } as never)
    expect(getRemoteExecutionHost()?.label).toBe("192.168.1.42")
  })

  it("treats a re-pairing as another route", () => {
    const host = getRemoteExecutionHost()!
    jest.mocked(loadCompanionConfig).mockReturnValue({
      targetId: "host-one",
      deviceId: "replacement",
      baseUrl: "https://192.168.1.42:7890",
    } as never)
    expect(isSameExecutionHost(host)).toBe(false)
  })
})

describe("a desktop driving a remote Host", () => {
  beforeEach(() => jest.mocked(isTauri).mockReturnValue(true))

  it("sends to the remote transport and names the Host", () => {
    const remote = remoteTransport()
    setActiveRemoteTransport(remote)
    setActiveRemoteEndpoint(remoteEndpoint)
    const host = getRemoteExecutionHost()
    expect(host).toMatchObject({ kind: "desktop-remote", label: "Build box" })
    expect(host?.transport).toBe(remote)
    expect(isSameExecutionHost(host!)).toBe(true)
  })

  it("names the Host by its address without a registry label", () => {
    setActiveRemoteTransport(remoteTransport())
    setActiveRemoteEndpoint({ ...remoteEndpoint, remoteHost: undefined })
    expect(getRemoteExecutionHost()?.label).toBe("box.example")
  })

  it("treats a reconnect to the same Host as another route", () => {
    setActiveRemoteTransport(remoteTransport())
    setActiveRemoteEndpoint(remoteEndpoint)
    const host = getRemoteExecutionHost()!
    setActiveRemoteTransport(remoteTransport())
    expect(isSameExecutionHost(host)).toBe(false)
  })

  it("is no longer current after switching back to local", () => {
    setActiveRemoteTransport(remoteTransport())
    const host = getRemoteExecutionHost()!
    setActiveRemoteTransport(null)
    expect(isSameExecutionHost(host)).toBe(false)
    expect(getRemoteExecutionHost()).toBeNull()
  })
})

it("notifies on remote Host and runtime target switches until unsubscribed", async () => {
  const listener = jest.fn()
  const off = subscribeExecutionHost(listener)
  setActiveRemoteTransport(remoteTransport())
  setActiveRuntimeTargetContext("account-one", "host-one")
  await Promise.resolve()
  expect(listener).toHaveBeenCalledTimes(2)
  off()
  off()
  setActiveRemoteTransport(null)
  await Promise.resolve()
  expect(listener).toHaveBeenCalledTimes(2)
})

it("reads a desktop's new Host only once its endpoint is installed too", async () => {
  jest.mocked(isTauri).mockReturnValue(true)
  setActiveRemoteTransport(remoteTransport())
  setActiveRemoteEndpoint(remoteEndpoint)
  const seen: Array<string | undefined> = []
  const off = subscribeExecutionHost(() => seen.push(getRemoteExecutionHost()?.label))
  // The remote-host store's order: transport (notifies), then endpoint.
  setActiveRemoteTransport(remoteTransport())
  setActiveRemoteEndpoint({ ...remoteEndpoint, remoteHost: { id: "two", label: "Second box" } })
  await Promise.resolve()
  expect(seen).toEqual(["Second box"])
  off()
})
