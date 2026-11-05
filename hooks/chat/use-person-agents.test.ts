/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import {
  buildLocalHostFeatureManifest,
  type PersonAgentsManifest,
} from "@/lib/platform/host-feature-manifest"
import {
  __resetRuntimeSnapshotForTesting,
  getRuntimeSnapshot,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"

import {
  __resetPersonAgentsRefreshForTesting,
  refreshPersonAgents,
  usePersonAgents,
} from "./use-person-agents"

const agents = (spentTokens: number): PersonAgentsManifest => ({
  allowedAgents: [{ runtimeId: "claude-agent-acp", available: true, providers: ["deepseek"] }],
  defaultAgent: "claude-agent-acp",
  execution: "sandboxed",
  models: { deepseek: ["m"] },
  usage: { month: "2026-10", spentTokens, reservedTokens: 0, monthlyTokens: 100 },
})

function connect(host: Record<string, unknown>) {
  setRuntimeSnapshot({
    target: null,
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: ["host_state_submit"],
      grants: ["client.write"],
      ...host,
    },
  })
}

const manifest = (personAgents?: PersonAgentsManifest) =>
  JSON.parse(
    JSON.stringify(
      buildLocalHostFeatureManifest({ platform: "headless", personPartition: true, personAgents })
    )
  )

beforeEach(() => {
  __resetRuntimeSnapshotForTesting()
  __resetPersonAgentsRefreshForTesting()
})

describe("usePersonAgents", () => {
  it("p6g shows the member's agents only on their own partition", () => {
    connect({ personPartition: true, personAgents: agents(1) })
    expect(renderHook(() => usePersonAgents()).result.current.agents).toEqual(agents(1))
    connect({ personAgents: agents(1) })
    expect(renderHook(() => usePersonAgents()).result.current.agents).toBeNull()
  })

  it("p6g refresh patches only the member's agents into the snapshot", async () => {
    connect({ personPartition: true, personAgents: agents(1) })
    const readManifest = jest.fn(async () => manifest(agents(40)))
    const { result } = renderHook(() => usePersonAgents({ readManifest }))
    await act(() => result.current.refresh())
    expect(result.current.agents?.usage?.spentTokens).toBe(40)
    expect(getRuntimeSnapshot().host?.operations).toEqual(["host_state_submit"])
  })

  it("adr0253 keeps the last answer on a failed or unreadable read, and says so", async () => {
    connect({ personPartition: true, personAgents: agents(1) })
    for (const readManifest of [
      async () => {
        throw new Error("offline")
      },
      async () => ({ schemaVersion: 2 }),
    ]) {
      const { result } = renderHook(() => usePersonAgents({ readManifest }))
      await act(() => result.current.refresh())
      expect(getRuntimeSnapshot().host?.personAgents?.usage?.spentTokens).toBe(1)
      expect(result.current.refreshFailed).toBe(true)
    }
    // The next good read clears the mark.
    const { result } = renderHook(() =>
      usePersonAgents({ readManifest: async () => manifest(agents(5)) })
    )
    await act(() => result.current.refresh())
    expect(result.current.refreshFailed).toBe(false)
    expect(result.current.agents?.usage?.spentTokens).toBe(5)
  })

  it("adr0253 clears the agents a Host no longer declares", async () => {
    connect({ personPartition: true, personAgents: agents(1) })
    const { result } = renderHook(() =>
      usePersonAgents({ readManifest: async () => manifest(undefined) })
    )
    await act(() => result.current.refresh())
    expect(getRuntimeSnapshot().host?.personAgents).toBeUndefined()
    expect(result.current.agents).toBeNull()
    expect(result.current.refreshFailed).toBe(false)
  })

  it("p6g never asks a Host that is not the member's partition", async () => {
    connect({})
    const readManifest = jest.fn(async () => manifest(agents(2)))
    await refreshPersonAgents({ readManifest })
    expect(readManifest).not.toHaveBeenCalled()
    expect(getRuntimeSnapshot().host?.personAgents).toBeUndefined()
  })
})
