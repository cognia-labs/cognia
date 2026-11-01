jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn(), subscribeAttached: jest.fn() },
}))

import { localTransport } from "@/lib/tauri/transport-instance"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

import {
  HOST_INSTALLER_STAGE_EVENT,
  closeSession,
  inspectMachine,
  installHost,
  installerSshRequest,
  onStage,
  openSsh,
  pairHost,
  toInstallerFailure,
  uninstallHost,
  type StageEventPayload,
} from "./client"

const mockInvoke = localTransport.call as jest.Mock
const mockSubscribe = localTransport.subscribeAttached as jest.Mock

beforeEach(() => {
  mockInvoke.mockReset()
  mockSubscribe.mockReset()
})

const profile: SshHostProfile = {
  id: "ssh-1",
  name: "Build box",
  host: "box.example.com",
  port: 22,
  username: "max",
  authMethod: "agent",
  jumpHostId: "ssh-2",
  localForwards: [
    { id: "l1", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80, enabled: true },
  ],
  remoteForwards: [],
}

const bastion: SshHostProfile = {
  id: "ssh-2",
  name: "Bastion",
  host: "bastion.example.com",
  port: 2222,
  username: "jump",
  authMethod: "agent",
}

describe("installerSshRequest", () => {
  it("resolves the jump chain and strips every forward at the source", () => {
    const built = installerSshRequest(profile, [profile, bastion])
    expect(built.kind).toBe("ok")
    if (built.kind !== "ok") return
    expect(built.request.host).toBe("box.example.com")
    expect(built.request.jumpChain?.map((hop) => hop.host)).toEqual(["bastion.example.com"])
    expect(built.request.localForwards ?? []).toEqual([])
    expect(built.request.remoteForwards ?? []).toEqual([])
  })

  it("reports a profile that cannot produce a request", () => {
    expect(installerSshRequest({ ...profile, host: "" }, [profile, bastion])).toEqual({
      kind: "invalid",
      reason: "host",
    })
    expect(installerSshRequest(profile, [profile])).toEqual({
      kind: "invalid",
      reason: "jumpChain",
    })
  })
})

describe("commands", () => {
  it("calls each command with the native argument names", async () => {
    mockInvoke.mockResolvedValue({ sessionId: "hi-1" })
    const built = installerSshRequest(profile, [profile, bastion])
    if (built.kind !== "ok") throw new Error("request")

    await openSsh(built.request)
    await inspectMachine("hi-1")
    await installHost({ sessionId: "hi-1", inspectionId: "inst-1", plan: "fresh", channel: "beta" })
    await pairHost({ sessionId: "hi-1", inspectionId: "inst-1", plan: "fresh", deviceName: "Mac" })
    await uninstallHost({
      sessionId: "hi-1",
      inspectionId: "inst-1",
      deleteDataConfirmation: "box",
    })
    await closeSession("hi-1")

    expect(mockInvoke.mock.calls).toEqual([
      ["host_installer_ssh_open", { request: built.request }],
      ["host_installer_inspect", { sessionId: "hi-1" }],
      [
        "host_installer_install",
        {
          args: {
            sessionId: "hi-1",
            inspectionId: "inst-1",
            plan: "fresh",
            choice: { channel: "beta", localAccountId: null },
          },
        },
      ],
      [
        "host_installer_pair",
        { sessionId: "hi-1", inspectionId: "inst-1", plan: "fresh", deviceName: "Mac" },
      ],
      [
        "host_installer_uninstall",
        { sessionId: "hi-1", inspectionId: "inst-1", deleteDataConfirmation: "box" },
      ],
      ["host_installer_close", { sessionId: "hi-1" }],
    ])
  })

  it("returns the value, or the native failure as data", async () => {
    mockInvoke.mockResolvedValueOnce({ inspectionId: "inst-1" })
    await expect(inspectMachine("hi-1")).resolves.toEqual({
      ok: true,
      value: { inspectionId: "inst-1" },
    })

    const unknown = { kind: "unknown", stage: "upload", message: "dropped" }
    mockInvoke.mockRejectedValueOnce(unknown)
    await expect(inspectMachine("hi-1")).resolves.toEqual({ ok: false, failure: unknown })

    mockInvoke.mockRejectedValueOnce(new Error("command not found"))
    await expect(inspectMachine("hi-1")).resolves.toEqual({
      ok: false,
      failure: { kind: "ipc", message: "command not found" },
    })
  })
})

describe("toInstallerFailure", () => {
  it("keeps a native failure and wraps anything else", () => {
    expect(toInstallerFailure({ kind: "busy" })).toEqual({ kind: "busy" })
    expect(toInstallerFailure({ kind: "made_up" })).toEqual({
      kind: "ipc",
      message: "[object Object]",
    })
    expect(toInstallerFailure("text")).toEqual({ kind: "ipc", message: "text" })
  })
})

describe("onStage", () => {
  it("delivers only its own session's stage events, waits to attach, and unsubscribes", async () => {
    const unsubscribe = jest.fn()
    let attached!: (off: () => void) => void
    mockSubscribe.mockReturnValue(new Promise<() => void>((resolve) => (attached = resolve)))
    const handler = jest.fn()

    let resolved = false
    const pending = onStage("hi-1", handler).then((stop) => {
      resolved = true
      return stop
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    attached(unsubscribe)
    const stop = await pending
    expect(mockSubscribe).toHaveBeenCalledWith(HOST_INSTALLER_STAGE_EVENT, expect.any(Function))
    const deliver = mockSubscribe.mock.calls[0][1] as (payload: StageEventPayload) => void
    const mine: StageEventPayload = {
      sessionId: "hi-1",
      operationId: "inst-1",
      stage: "upload",
      outcome: null,
    }
    deliver(mine)
    deliver({ ...mine, sessionId: "hi-2" })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(mine)

    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("rejects when the listener cannot attach, so no step starts unwatched", async () => {
    mockSubscribe.mockRejectedValue(new Error("listen failed"))
    await expect(onStage("hi-1", jest.fn())).rejects.toThrow("listen failed")
  })
})
