import {
  assessSessionHostBinding,
  sessionHostLiveState,
  sessionHostWorkspaceRoots,
  switchSessionHostTarget,
  type SessionHostLiveState,
} from "./session-host-binding"
import { callTaskWorkspaceOrigin, captureTaskWorkspaceOrigin } from "@/lib/task-workspace/origin"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import {
  setRuntimeSnapshot,
  __resetRuntimeSnapshotForTesting,
} from "@/lib/runtime/runtime-snapshot-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import type { ExecutionHostSwitch } from "@/hooks/devices/use-execution-host-switch"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => false,
  isHeadlessHost: () => false,
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: jest.fn(() => false) }))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  ...jest.requireActual("@/lib/runtime/runtime-target-context"),
  getActiveRuntimeTargetContext: jest.fn(() => null),
}))
jest.mock("@/lib/task-workspace/origin", () => ({
  ...jest.requireActual("@/lib/task-workspace/origin"),
  captureTaskWorkspaceOrigin: jest.fn(() => ({ kind: "local" })),
  callTaskWorkspaceOrigin: jest.fn(),
}))

const local = { kind: "local" as const }
const a = { kind: "remote" as const, hostId: "a", accountId: "account-a" }
const ready: SessionHostLiveState = { online: true, connectionState: "ready", capable: true }

describe("assessSessionHostBinding", () => {
  it("binds an unbound session on its first send", () => {
    expect(assessSessionHostBinding(undefined, a, ready)).toBe("bind")
  })
  it("allows the same Host and account", () => {
    expect(assessSessionHostBinding({ origin: a }, a, ready)).toBe("ok")
  })
  it("requires switching from another Host even if it is ready", () => {
    expect(assessSessionHostBinding({ origin: a }, { ...a, hostId: "b" }, ready)).toBe(
      "switch-required"
    )
  })
  it("treats another account on the same Host as another target", () => {
    expect(assessSessionHostBinding({ origin: a }, { ...a, accountId: "account-b" }, ready)).toBe(
      "switch-required"
    )
    expect(assessSessionHostBinding({ origin: a }, { kind: "remote", hostId: "a" }, ready)).toBe(
      "switch-required"
    )
  })
  it("refuses the active bound Host when offline", () => {
    expect(assessSessionHostBinding({ origin: a }, a, { ...ready, online: false })).toBe(
      "host-unavailable"
    )
  })
  it.each(["connecting", "degraded", "versionMismatch", "revoked", "disconnected"])(
    "refuses a %s connection",
    (connectionState) => {
      expect(assessSessionHostBinding({ origin: a }, a, { ...ready, connectionState })).toBe(
        "host-unavailable"
      )
    }
  )
  it("refuses a Host missing the built-in runtime capability", () => {
    expect(assessSessionHostBinding({ origin: a }, a, { ...ready, capable: false })).toBe(
      "host-unavailable"
    )
  })
  it("allows local only when local is active and available", () => {
    expect(assessSessionHostBinding({ origin: local }, local, ready)).toBe("ok")
    expect(assessSessionHostBinding({ origin: local }, local, { ...ready, capable: false })).toBe(
      "host-unavailable"
    )
  })
  it("never substitutes local for remote or remote for local", () => {
    expect(assessSessionHostBinding({ origin: a }, local, ready)).toBe("switch-required")
    expect(assessSessionHostBinding({ origin: local }, a, ready)).toBe("switch-required")
  })
  it("preserves companion target identity", () => {
    const companion = { ...a, hostId: "companion:paired-a" }
    expect(assessSessionHostBinding({ origin: companion }, companion, ready)).toBe("ok")
    expect(assessSessionHostBinding({ origin: companion }, a, ready)).toBe("switch-required")
  })
})

describe("live target evidence", () => {
  afterEach(() => {
    __resetRuntimeSnapshotForTesting()
    jest.mocked(isStandaloneChatMode).mockReturnValue(false)
  })
  it("keeps the existing browser/mobile standalone built-in lane available", () => {
    jest.mocked(isStandaloneChatMode).mockReturnValue(true)
    expect(sessionHostLiveState(local)).toEqual(ready)
  })
  it("requires the paired Host's live operation and unlocked capability evidence", () => {
    const origin = { kind: "remote" as const, hostId: "companion:paired" }
    const snapshot = {
      target: {
        kind: "companion" as const,
        id: "paired",
        platform: "web" as const,
        hostKind: "desktop" as const,
      },
      connectionState: "online" as const,
      vaultState: "unlocked" as const,
      host: { compatible: true, operations: ["agent_send"] },
    }
    setRuntimeSnapshot(snapshot)
    expect(sessionHostLiveState(origin)).toEqual(ready)
    setRuntimeSnapshot({ ...snapshot, vaultState: "locked" })
    expect(sessionHostLiveState(origin).capable).toBe(false)
    setRuntimeSnapshot({ ...snapshot, host: { compatible: true, operations: [] } })
    expect(sessionHostLiveState(origin).capable).toBe(false)
    setRuntimeSnapshot({ ...snapshot, host: { ...snapshot.host, grants: ["host.observe"] } })
    expect(sessionHostLiveState(origin).capable).toBe(false)
    setRuntimeSnapshot({ ...snapshot, connectionState: "offline" })
    expect(sessionHostLiveState(origin).online).toBe(false)
    expect(sessionHostLiveState({ ...origin, hostId: "companion:other" }).online).toBe(false)
  })
  it("reads and validates only roots reported by the named Host", async () => {
    jest.mocked(callTaskWorkspaceOrigin).mockResolvedValueOnce({
      roots: [
        { path: "/host/repo", source: "desktop-project" },
        { path: "/workspaces", source: "headless-workspaces-dir" },
        { path: "", source: "desktop-project" },
        { path: "/untrusted", source: "other" },
        null,
      ],
    })
    expect(await sessionHostWorkspaceRoots(a)).toEqual(["/host/repo", "/workspaces"])
    expect(callTaskWorkspaceOrigin).toHaveBeenCalledWith(a, "fs_workspace_roots", {})
  })
})

describe("guarded switch completion", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.mocked(captureTaskWorkspaceOrigin).mockReturnValue(local)
    jest
      .mocked(getActiveRuntimeTargetContext)
      .mockReturnValue({ accountId: "account-a", targetId: "target-a", routingGeneration: 1 })
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.mocked(getActiveRuntimeTargetContext).mockReturnValue(null)
  })
  it("waits for delayed route activation after credential hydration", async () => {
    const request: ExecutionHostSwitch["requestSwitch"] = jest.fn(async (_id, options) => {
      options?.onSwitched?.()
      return "switched"
    })
    const switched = switchSessionHostTarget(a, request)
    jest.mocked(captureTaskWorkspaceOrigin).mockReturnValue(a)
    useRemoteHostStore.setState({ hosts: [] })
    expect(await switched).toBe(true)
  })
  it("does not impose an activation timeout while the user is still confirming", async () => {
    let accept: (() => void) | undefined
    const request: ExecutionHostSwitch["requestSwitch"] = jest.fn(async (_id, options) => {
      accept = options?.onSwitched
      return "confirming"
    })
    const answer = jest.fn()
    const switched = switchSessionHostTarget(a, request)
    void switched.then(answer)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(answer).not.toHaveBeenCalled()
    jest.mocked(captureTaskWorkspaceOrigin).mockReturnValue(a)
    accept?.()
    expect(await switched).toBe(true)
  })
  it("refuses another account without trying to activate the Host", async () => {
    const request: ExecutionHostSwitch["requestSwitch"] = jest.fn()
    expect(await switchSessionHostTarget({ ...a, accountId: "other-account" }, request)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it("refuses an unknown Host", async () => {
    const request: ExecutionHostSwitch["requestSwitch"] = jest.fn(async () => "unknown-host")
    expect(await switchSessionHostTarget(a, request)).toBe(false)
  })
  it("cancels waiting without claiming a switch", async () => {
    const controller = new AbortController()
    const request: ExecutionHostSwitch["requestSwitch"] = jest.fn(async () => "confirming")
    const switched = switchSessionHostTarget(a, request, controller.signal)
    controller.abort()
    expect(await switched).toBe(false)
  })
  it("times out activation that never reaches the requested target", async () => {
    const request: ExecutionHostSwitch["requestSwitch"] = jest.fn(async (_id, options) => {
      options?.onSwitched?.()
      return "switched"
    })
    const switched = switchSessionHostTarget(a, request)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(await switched).toBe(false)
  })
})
