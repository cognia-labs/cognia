/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let teamRun: { id: string; teamId: string } | undefined
let receipts: Array<{ id: string; status: string }> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (_fn: unknown, _deps: unknown, fallback: unknown) =>
    Array.isArray(fallback) ? receipts : teamRun,
}))
jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: jest.fn(),
  listAgentTeamSteeringReceipts: jest.fn(),
}))

const consensusTeamIds: (string | undefined)[] = []
const delegationTeamIds: (string | undefined)[] = []
jest.mock("@/components/squads/consensus-panel", () => ({
  ConsensusPanel: ({ teamId }: { teamId?: string }) => {
    consensusTeamIds.push(teamId)
    return <div data-testid="consensus-panel" />
  },
}))
jest.mock("@/components/squads/delegations-panel", () => ({
  DelegationsPanel: ({ teamId }: { teamId?: string }) => {
    delegationTeamIds.push(teamId)
    return <div data-testid="delegations-panel" />
  },
}))

import { isSquadRun, RunCoordinationTab } from "./run-coordination-tab"

const row = (over: Record<string, unknown> = {}) =>
  ({
    rowId: "r1",
    kind: "team",
    label: "Ship it",
    status: "running",
    startedAt: 0,
    source: "broker",
    sourceId: "atr-1",
    ...over,
  }) as never

describe("isSquadRun", () => {
  it("is true only for a team run", () => {
    expect(isSquadRun(row())).toBe(true)
    expect(isSquadRun(row({ kind: "workflow" }))).toBe(false)
    expect(isSquadRun(row({ kind: "chat" }))).toBe(false)
  })
})

describe("RunCoordinationTab", () => {
  beforeEach(() => {
    consensusTeamIds.length = 0
    delegationTeamIds.length = 0
    teamRun = { id: "atr-1", teamId: "team-9" }
    receipts = []
  })

  /**
   * The trap `monitor-model` documents: while a team run is live the row can be
   * `source: "broker"` with no `runId` at all, so a section keyed on `runId` is
   * blank exactly while the run is worth looking at.
   */
  it("names the team from the run record, on a row that has no runId", () => {
    render(<RunCoordinationTab row={row({ runId: undefined })} />)
    expect(consensusTeamIds).toEqual(["team-9"])
    expect(delegationTeamIds).toEqual(["team-9"])
  })

  /**
   * Mobile syncs `executionRuns` and nothing else, so the team-run record is
   * simply absent there. An empty consensus list would claim the run reached no
   * decisions, which is a different statement.
   */
  it("says the record is not here rather than rendering an empty list", () => {
    teamRun = undefined
    render(<RunCoordinationTab row={row()} />)
    expect(screen.getByTestId("run-coordination-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("consensus-panel")).not.toBeInTheDocument()
  })

  it("renders durable message & steer receipt counts when receipts exist (F09/F12)", () => {
    receipts = [
      { id: "sr-1", status: "delivered" },
      { id: "sr-2", status: "queued" },
      { id: "sr-3", status: "expired" },
    ]
    render(<RunCoordinationTab row={row()} />)
    const banner = screen.getByTestId("run-coordination-receipts")
    expect(banner.textContent).toContain('coordination.receiptsDelivered:{"count":1}')
    expect(banner.textContent).toContain('coordination.receiptsQueued:{"count":1}')
    expect(banner.textContent).toContain('coordination.receiptsExpired:{"count":1}')
  })
})
