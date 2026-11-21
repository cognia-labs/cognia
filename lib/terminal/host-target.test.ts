/**
 * @jest-environment jsdom
 */

import {
  __resetRoutingForTests,
  setActiveRemoteEndpoint,
  setActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { Transport } from "@/lib/tauri/transport-types"
import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"

import {
  __resetTerminalTargetsForTests,
  callWithTerminalAdminLease,
  captureActiveTerminalRemoteTarget,
  captureSessionRemoteTarget,
  currentTerminalTargetKey,
  openBoundSessionTarget,
} from "./host-target"

function makeTransport(callImpl?: Transport["call"]): Transport {
  return {
    call: callImpl ?? (jest.fn(async () => undefined) as unknown as Transport["call"]),
    subscribe: jest.fn(() => () => undefined),
  }
}

const ENDPOINT_A = {
  baseUrl: "https://host-a.local:27890",
  deviceId: "dev-a",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "a" },
  deviceKeyThumbprint: "thumb-a",
  serverVersion: "1.0.0",
  remoteHost: { id: "host-a", label: "Host A" },
}

const ENDPOINT_B = {
  ...ENDPOINT_A,
  baseUrl: "https://host-b.local:27890",
  deviceId: "dev-b",
  remoteHost: { id: "host-b", label: "Host B" },
}

beforeEach(() => {
  __resetRoutingForTests()
  clearActiveRuntimeTargetContext()
  __resetTerminalTargetsForTests()
})

describe("currentTerminalTargetKey", () => {
  it("distinguishes local default, remote host overlays, and runtime target switches", () => {
    expect(currentTerminalTargetKey()).toBe("default")

    setActiveRuntimeTargetContext("acct_alpha1", "host-one")
    const scopeOne = currentTerminalTargetKey()
    setActiveRuntimeTargetContext("acct_alpha1", "host-two")
    const scopeTwo = currentTerminalTargetKey()
    expect(scopeOne).not.toBe("default")
    expect(scopeTwo).not.toBe(scopeOne)

    clearActiveRuntimeTargetContext()
    setActiveRemoteTransport(makeTransport())
    setActiveRemoteEndpoint(ENDPOINT_A)
    const remoteOne = currentTerminalTargetKey()
    setActiveRemoteTransport(makeTransport())
    setActiveRemoteEndpoint(ENDPOINT_B)
    const remoteTwo = currentTerminalTargetKey()
    expect(remoteOne).not.toBe(remoteTwo)
  })
})

describe("callWithTerminalAdminLease", () => {
  it("mints a device-bound lease, reuses it while fresh, and refreshes once if invalidated", async () => {
    let leaseSeq = 0
    let rejectFirstUse = false
    const call = jest.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "host_admin_lease_issue") {
        leaseSeq += 1
        return {
          token: `lease-${leaseSeq}`,
          operations: (args?.operations as string[]) ?? [],
          expiresAt: 1_000_000,
        }
      }
      if (rejectFirstUse) {
        rejectFirstUse = false
        throw new Error(
          "interactive_approval_required: a current device-bound approval lease is required"
        )
      }
      return { ok: true, lease: args?.adminLease }
    })
    const transport = makeTransport(call as unknown as Transport["call"])

    await expect(
      callWithTerminalAdminLease(
        "terminal_host_sync_profiles",
        { profiles: [] },
        { transport, targetKey: "target-a", now: () => 1_000 }
      )
    ).resolves.toEqual({ ok: true, lease: "lease-1" })

    // Second call while still fresh reuses lease-1 without calling host_admin_lease_issue again.
    await expect(
      callWithTerminalAdminLease(
        "terminal_host_sync_profiles",
        { profiles: [] },
        { transport, targetKey: "target-a", now: () => 2_000 }
      )
    ).resolves.toEqual({ ok: true, lease: "lease-1" })
    expect(leaseSeq).toBe(1)

    // Simulate Host restart clearing in-memory leases: cached lease-1 is rejected,
    // evicted, and replaced once by lease-2.
    rejectFirstUse = true
    await expect(
      callWithTerminalAdminLease(
        "terminal_host_sync_profiles",
        { profiles: [] },
        { transport, targetKey: "target-a", now: () => 3_000 }
      )
    ).resolves.toEqual({ ok: true, lease: "lease-2" })
    expect(leaseSeq).toBe(2)
  })

  it("propagates HostConsentRequiredError without masking the approval code", async () => {
    const transport = makeTransport((async () => {
      throw new Error(
        "REMOTE_CONSENT_REQUIRED: this device needs approval on the host (code ABCD1234)"
      )
    }) as unknown as Transport["call"])

    await expect(
      callWithTerminalAdminLease(
        "terminal_kill_port",
        { port: 3000 },
        { transport, targetKey: "target-b" }
      )
    ).rejects.toMatchObject({
      name: HostConsentRequiredError.name,
      consentCode: "ABCD1234",
    })
  })
})

describe("captureActiveTerminalRemoteTarget", () => {
  it("aborts subsequent calls when the active remote host switches mid-launch", async () => {
    const transportA = makeTransport(
      jest.fn(async () => ({ installed: 1 })) as unknown as Transport["call"]
    )
    const transportB = makeTransport()
    setActiveRemoteTransport(transportA)
    setActiveRemoteEndpoint(ENDPOINT_A)

    const bound = await captureActiveTerminalRemoteTarget({
      endpointResolver: async () => ENDPOINT_A,
    })
    await expect(
      bound.transport.call("terminal_host_sync_profiles", { profiles: [] })
    ).resolves.toEqual({
      installed: 1,
    })

    // User switches UI to Host B before spawn frame is sent.
    setActiveRemoteTransport(transportB)
    setActiveRemoteEndpoint(ENDPOINT_B)

    await expect(bound.assertCurrent()).rejects.toThrow(/changed during launch/i)
    await expect(
      bound.transport.call("terminal_host_sync_profiles", { profiles: [] })
    ).rejects.toThrow(/changed during launch/i)
    bound.release()
  })

  it("detects paired endpoint changes between sync and spawn", async () => {
    let activeEndpoint = { ...ENDPOINT_A, remoteHost: undefined }
    const bound = await captureActiveTerminalRemoteTarget({
      endpointResolver: async () => activeEndpoint,
    })
    await expect(bound.assertCurrent()).resolves.toBeUndefined()

    activeEndpoint = { ...ENDPOINT_B, remoteHost: undefined }
    await expect(bound.assertCurrent()).rejects.toThrow(/changed during launch/i)
    bound.release()
  })
})

describe("openBoundSessionTarget", () => {
  it("refuses SSH, serial, and extension sessions", async () => {
    for (const kind of ["ssh", "serial", "extension"] as const) {
      await expect(openBoundSessionTarget({ kind, origin: "local" })).rejects.toThrow(
        /unsupported/i
      )
    }
  })

  it("routes local PTYs to localTransport even when a remote Host is active", async () => {
    setActiveRemoteTransport(makeTransport())
    const local = makeTransport()
    const bound = await openBoundSessionTarget(
      { kind: "localPty", origin: "local", remoteHost: null },
      { isDesktop: () => true, local }
    )
    expect(bound.kind).toBe("local")
    expect(bound.transport).toBe(local)
    bound.close()
  })

  it("opens the captured remote host by registry id even after switching back to local", async () => {
    const hostATransport = makeTransport()
    const close = jest.fn()
    const openRemoteHost = jest.fn(async () => ({
      host: {} as never,
      transport: hostATransport,
      close,
    }))
    const bound = await openBoundSessionTarget(
      {
        kind: "localPty",
        origin: "remote",
        remoteHost: { id: "host-a", label: "Host A" },
      },
      { openRemoteHost: openRemoteHost as never }
    )
    expect(openRemoteHost).toHaveBeenCalledWith("host-a")
    expect(bound.transport).toBe(hostATransport)
    bound.close()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("refuses paired session actions when the paired server URL no longer matches", async () => {
    await expect(
      openBoundSessionTarget(
        {
          kind: "localPty",
          origin: "remote",
          remoteHost: { id: null, label: "https://host-a.local:27890" },
        },
        {
          isDesktop: () => false,
          resolvePairedEndpoint: async () => ({
            ...ENDPOINT_B,
            remoteHost: undefined,
          }),
        }
      )
    ).rejects.toThrow(/another paired host/i)
  })
})

describe("captureSessionRemoteTarget", () => {
  it("opens an isolated target for a desktop remote host even when local or another host is active", async () => {
    setActiveRemoteTransport(makeTransport())
    setActiveRemoteEndpoint(ENDPOINT_B)

    const close = jest.fn()
    const hostATransport = makeTransport()
    const bound = await captureSessionRemoteTarget(
      { id: "host-a", label: "Host A" },
      {
        openRemoteHost: async () => ({
          host: {
            id: "host-a",
            label: "Host A",
            config: {
              baseUrl: "https://host-a.local:27890",
              deviceId: "dev-a",
              deviceKeyThumbprint: "thumb-a",
              serverVersion: "1.0.0",
            },
            credentialRef: "host-a",
            addedAt: 1,
            connectionState: "ready",
          },
          transport: hostATransport,
          close,
        }),
        loadCredential: async () => ({
          devicePrivateKeyJwk: ENDPOINT_A.devicePrivateKeyJwk,
        }),
      }
    )

    expect(bound.endpoint.baseUrl).toBe("https://host-a.local:27890")
    expect(bound.remoteHost).toEqual({ id: "host-a", label: "Host A" })
    expect(bound.transport).toBe(hostATransport)
    bound.release()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("refuses paired session restarts when the paired host changed", async () => {
    await expect(
      captureSessionRemoteTarget(
        { id: null, label: "https://host-a.local:27890" },
        {
          endpointResolver: async () => ({
            ...ENDPOINT_B,
            remoteHost: undefined,
          }),
        }
      )
    ).rejects.toThrow(/another paired host/i)
  })
})
