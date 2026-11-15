/**
 * @jest-environment jsdom
 *
 * Coverage for the persisted store wiring (`store.ts`).
 */

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

import type { ExternalAgentStore } from "./types"
import type { ExternalAgentValiditySnapshot } from "@/types/agent/external-agent"
import { useExternalAgentStore } from "./store"

const reset = () => {
  useExternalAgentStore.getState().reset()
}

beforeEach(() => {
  reset()
  jest.clearAllMocks()
})

/** Persist options, read through zustand's persist API. */
type PersistOpts = {
  version: number
  migrate?: (state: unknown, version: number) => unknown
  partialize: (state: ExternalAgentStore) => unknown
}
type StoreWithPersist = { persist: { getOptions: () => PersistOpts } }

const persistOptions = (useExternalAgentStore as unknown as StoreWithPersist).persist.getOptions()

describe("persist options", () => {
  it("keeps removed settings out of writes and has no migrate step", () => {
    expect(persistOptions.version).toBe(7)
    expect(persistOptions.migrate).toBeUndefined()
    expect(persistOptions.partialize(useExternalAgentStore.getState())).not.toHaveProperty(
      "enabled"
    )
  })
})

describe("persist.partialize", () => {
  it("only keeps the durable subset of state", () => {
    const state = useExternalAgentStore.getState()
    const out = persistOptions.partialize(state) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(
      [
        "activeAgentId",
        "agentValidity",
        "agents",
        "autoConnectOnStartup",
        "benchmarkCapabilityMap",
        "chatFailurePolicy",
        "defaultPermissionMode",
        "delegationRules",
        "lastRunSnapshots",
        "overviewBannerCollapsed",
        "railGroupBy",
        "showConnectionNotifications",
      ].sort()
    )
    // None of the runtime-only buckets should leak through:
    expect(out).not.toHaveProperty("runningAgents")
    expect(out).not.toHaveProperty("terminals")
    expect(out).not.toHaveProperty("isLoading")
    expect(out).not.toHaveProperty("lastError")
  })

  it("never writes a transport block to storage in the first place", () => {
    const snapshot = (code: ExternalAgentValiditySnapshot["blockingReasonCode"]) =>
      ({
        executable: false,
        checkedAt: new Date(),
        source: "config",
        blockingReasonCode: code,
        sessionExtensions: {
          "session/list": { state: "unknown" },
          "session/fork": { state: "unknown" },
          "session/resume": { state: "unknown" },
        },
      }) as ExternalAgentValiditySnapshot
    useExternalAgentStore.setState({
      agentValidity: {
        blocked: snapshot("transport_blocked"),
        broken: snapshot("initialization_failed"),
      },
    })
    const out = persistOptions.partialize(useExternalAgentStore.getState()) as {
      agentValidity: Record<string, unknown>
    }
    expect(Object.keys(out.agentValidity)).toEqual(["broken"])
  })
})

it("preserves model roles through the persistence projection", () => {
  const modelRoles = {
    version: 1 as const,
    slots: { "subagent.default": { kind: "inherit-primary" as const } },
  }
  const id = useExternalAgentStore.getState().addAgent({
    name: "Roles",
    protocol: "codex-app-server",
    transport: "stdio",
    cogniaModel: { providerId: "p", modelId: "m" },
    modelRoles,
  })
  const projected = persistOptions.partialize(useExternalAgentStore.getState())
  const reloaded = JSON.parse(JSON.stringify(projected)) as ExternalAgentStore
  expect(reloaded.agents[id].modelRoles).toEqual(modelRoles)
})
