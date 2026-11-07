/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { TeamDelegationRecord } from "@/types/agent/agent-team"
import type { ExecutionRun } from "@/types/execution/run"

// The child runs a launched delegation links to, read as the live query would.
jest.mock("@/hooks/data/use-client-live-query", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    useClientLiveQuery: <T,>(query: () => Promise<T> | T, deps: unknown[], initial: T) => {
      const [value, setValue] = React.useState<T | undefined>(initial)
      React.useEffect(() => {
        let alive = true
        void Promise.resolve(query()).then((next) => {
          if (alive) setValue(next)
        })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return value
    },
  }
})
const childRuns = new Map<string, Partial<ExecutionRun>>()
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: async (id: string) => childRuns.get(id),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const approveDelegationMock = jest.fn()
const cancelDelegationMock = jest.fn()
jest.mock("@/lib/squads/delegation-orchestrator", () => ({
  approveDelegation: (...args: unknown[]) => approveDelegationMock(...args),
  cancelDelegation: (...args: unknown[]) => cancelDelegationMock(...args),
}))

let mockDelegations: TeamDelegationRecord[] = []

let mockActiveTeamId: string | null = null

jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({ delegations: {}, teams: {}, activeTeamId: mockActiveTeamId }),
}))

let namedTeamIds: (string | undefined)[] = []
jest.mock("@/stores/squads/agent-team-store/selectors", () => ({
  // Records what the panel asked for. See the team-scoping block below.
  selectTeamDelegations: (_state: unknown, teamId: string | undefined) => {
    namedTeamIds.push(teamId)
    return mockDelegations
  },
}))

import { DelegationsPanel } from "./delegations-panel"

function makeDelegation(overrides: Partial<TeamDelegationRecord> = {}): TeamDelegationRecord {
  return {
    id: "d1",
    sourceTeamId: "team-1",
    sourceTaskId: "task-1",
    targetType: "background",
    status: "active",
    reason: "Offload research",
    manual: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  }
}

describe("DelegationsPanel", () => {
  beforeEach(() => {
    approveDelegationMock.mockReset()
    cancelDelegationMock.mockReset()
    mockDelegations = []
    mockActiveTeamId = null
    namedTeamIds = []
    childRuns.clear()
  })

  it("shows the empty hint when there are no delegations", () => {
    render(<DelegationsPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders an active delegation with a cancel button (no approve)", () => {
    mockDelegations = [makeDelegation()]
    render(<DelegationsPanel />)
    expect(screen.getByText("Offload research")).toBeInTheDocument()
    expect(screen.getByText("cancel")).toBeInTheDocument()
    expect(screen.queryByText("approve")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("cancel"))
    expect(cancelDelegationMock).toHaveBeenCalledWith("d1")
  })

  it("shows approve + cancel for an awaiting_approval delegation and wires both", () => {
    mockDelegations = [makeDelegation({ id: "d2", status: "awaiting_approval" })]
    render(<DelegationsPanel />)
    fireEvent.click(screen.getByText("approve"))
    expect(approveDelegationMock).toHaveBeenCalledWith("d2")
    fireEvent.click(screen.getByText("cancel"))
    expect(cancelDelegationMock).toHaveBeenCalledWith("d2")
  })

  it("hides action buttons and surfaces the error for a settled delegation", () => {
    mockDelegations = [makeDelegation({ id: "d3", status: "failed", error: "boom" })]
    render(<DelegationsPanel />)
    expect(screen.queryByText("cancel")).not.toBeInTheDocument()
    expect(screen.queryByText("approve")).not.toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("renders settled statuses (pending / completed / timeout) without action buttons", () => {
    mockDelegations = [
      makeDelegation({ id: "p", status: "pending", reason: "Pending one" }),
      makeDelegation({ id: "c", status: "completed", reason: "Completed one" }),
      makeDelegation({ id: "t", status: "timeout", reason: "Timed out one" }),
    ]
    render(<DelegationsPanel />)
    expect(screen.getByText("Pending one")).toBeInTheDocument()
    expect(screen.getByText("Completed one")).toBeInTheDocument()
    expect(screen.getByText("Timed out one")).toBeInTheDocument()
    // pending is still in-flight → shows a cancel; completed/timeout are settled.
    expect(screen.getAllByText("cancel")).toHaveLength(1)
  })

  it("orders delegations newest-first", () => {
    mockDelegations = [
      makeDelegation({ id: "old", reason: "Older", createdAt: new Date("2026-01-01") }),
      makeDelegation({ id: "new", reason: "Newer", createdAt: new Date("2026-02-01") }),
    ]
    render(<DelegationsPanel />)
    const reasons = screen.getAllByText(/Older|Newer/).map((el) => el.textContent)
    expect(reasons[0]).toBe("Newer")
  })
})

describe("DelegationsPanel over child runs", () => {
  beforeEach(() => {
    mockDelegations = []
    mockActiveTeamId = null
    childRuns.clear()
  })

  const linked = (overrides: Partial<TeamDelegationRecord> = {}) =>
    makeDelegation({ metadata: { executionRunId: "execution:job:bg_1" }, ...overrides })

  it("shows the child run's settled status over a record that still reads active", async () => {
    childRuns.set("execution:job:bg_1", {
      id: "execution:job:bg_1",
      status: "cancelled",
      endedAt: 5,
    })
    mockDelegations = [linked()]
    render(<DelegationsPanel />)
    expect(await screen.findByText("status.cancelled")).toBeInTheDocument()
    expect(screen.queryByText("cancel")).not.toBeInTheDocument()
  })

  it("says when the child run is paused, and keeps it cancellable", async () => {
    childRuns.set("execution:job:bg_1", { id: "execution:job:bg_1", status: "paused" })
    mockDelegations = [linked()]
    render(<DelegationsPanel />)
    expect(await screen.findByText("runStatus.paused")).toBeInTheDocument()
    expect(screen.getByText("status.active")).toBeInTheDocument()
    expect(screen.getByText("cancel")).toBeInTheDocument()
  })

  it("surfaces a failed child's error, which the record keeps as its result", async () => {
    childRuns.set("execution:job:bg_1", { id: "execution:job:bg_1", status: "failed" })
    mockDelegations = [linked({ result: "lead gave up" })]
    render(<DelegationsPanel />)
    expect(await screen.findByText("lead gave up")).toBeInTheDocument()
    expect(screen.getByText("status.failed")).toBeInTheDocument()
  })
})

/**
 * Same reasoning as `ConsensusPanel`: `activeTeamId` reads whatever the store
 * last created, which the run cockpit never sets. There is one selector and one
 * fallback rule, so these tests pin what the panel NAMES rather than which of
 * two selectors it reached for.
 */
describe("DelegationsPanel team scoping", () => {
  beforeEach(() => {
    namedTeamIds = []
    mockDelegations = []
    mockActiveTeamId = null
  })

  it("reads the named team when given one, ignoring the store's selection", () => {
    mockActiveTeamId = "team-last-created"
    render(<DelegationsPanel teamId="team-42" />)
    expect(namedTeamIds).toEqual(["team-42"])
  })

  it("falls back to the store's selection when no team is named", () => {
    mockActiveTeamId = "team-last-created"
    render(<DelegationsPanel />)
    expect(namedTeamIds).toEqual(["team-last-created"])
  })

  it("names no team at all when nothing was ever selected", () => {
    render(<DelegationsPanel />)
    // `null` would be a team id the selector has to defend against; the panel
    // normalises it to `undefined` so the selector's "no team" branch is the
    // one that runs.
    expect(namedTeamIds).toEqual([undefined])
  })
})
