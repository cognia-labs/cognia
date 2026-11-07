/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { CapabilityAuditWarning } from "@/lib/squads/capability-audit"

let map: Record<string, CapabilityAuditWarning[]> = {}
const listeners = new Set<() => void>()
const EMPTY: CapabilityAuditWarning[] = []
const refresh = jest.fn(async () => ({ warningsByTeamId: map, totalWarnings: 0 }))

jest.mock("@/lib/squads/capability-audit", () => {
  return {
    // Stable like the real getter: a fresh [] per read would loop useSyncExternalStore.
    getInstanceCapabilityWarnings: (teamId: string) => map[teamId] ?? EMPTY,
    subscribeCapabilityWarnings: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshAllInstanceCapabilityWarnings: () => refresh(),
  }
})

import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { useSquadCapabilityWarnings } from "./use-squad-capability-warnings"

function publish(next: Record<string, CapabilityAuditWarning[]>) {
  map = next
  for (const listener of listeners) listener()
}

const teamWarning: CapabilityAuditWarning = {
  code: "missing-skill",
  bucket: "skillIds",
  missingId: "ghost-skill",
  scope: { kind: "team", teamId: "t1" },
}

describe("useSquadCapabilityWarnings", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    refresh.mockClear()
    publish({})
  })

  it("repaints when the audit publishes a new map", () => {
    const { result } = renderHook(() => useSquadCapabilityWarnings("t1"))
    expect(result.current).toEqual([])
    act(() => publish({ t1: [teamWarning] }))
    expect(result.current).toEqual([teamWarning])
  })

  it("does not audit unless asked", () => {
    renderHook(() => useSquadCapabilityWarnings("t1"))
    expect(refresh).not.toHaveBeenCalled()
  })

  it("audits on mount and again when an audited id changes, not on unrelated edits", async () => {
    const team = useAgentTeamStore.getState().createTeam({ name: "S", task: "t" })
    renderHook(() => useSquadCapabilityWarnings(team.id, { audit: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    act(() => useAgentTeamStore.getState().updateTeam(team.id, { name: "Renamed" }))
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => useAgentTeamStore.getState().updateTeamCapabilities(team.id, { skillIds: ["x"] }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  })
})
