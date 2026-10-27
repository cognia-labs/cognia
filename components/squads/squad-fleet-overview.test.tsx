/** @jest-environment jsdom */

// `/squads` with nothing selected: what needs you, what is working, and the
// latest runs, each with the way onward. The projections behind them have
// suites of their own; these cases are about what is shown and where it links.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PendingSquadReview } from "@/hooks/squads/use-pending-squad-reviews"
import type { SquadFleetRow, SquadFleetSnapshot } from "@/hooks/squads/use-squad-fleet"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"

let mockSquads: SquadFleetRow[] = []
jest.mock("@/hooks/squads/use-squad-fleet", () => ({
  useSquadFleet: (): SquadFleetSnapshot => ({
    squads: mockSquads,
    total: mockSquads.length,
    live: mockSquads.filter((s) => s.live).length,
    waiting: mockSquads.filter((s) => s.waiting).length,
    loading: false,
  }),
}))
let mockReviews: PendingSquadReview[] = []
jest.mock("@/hooks/squads/use-pending-squad-reviews", () => ({
  usePendingSquadReviews: () => mockReviews,
}))
let mockRuns: Array<Record<string, unknown>> = []
const cockpitOptions = jest.fn()
jest.mock("@/hooks/agent-runs/use-agent-runs", () => ({
  useExecutionCockpit: (options: unknown) => {
    cockpitOptions(options)
    return { rows: mockRuns }
  },
}))

import {
  ALL_SQUAD_RUNS_HREF,
  RECENT_RUN_LIMIT,
  SquadFleetOverview,
  squadRunHref,
} from "./squad-fleet-overview"

function row(over: Partial<SquadFleetRow> & { id: string }): SquadFleetRow {
  return { name: over.id, status: "idle", memberCount: 1, live: false, waiting: false, ...over }
}

function run(i: number, over: Record<string, unknown> = {}) {
  return {
    rowId: `execution:${i}`,
    nativeId: `native_${i}`,
    runId: `execution:team:r${i}`,
    label: `Run ${i}`,
    status: "succeeded",
    startedAt: 1_700_000_000_000 - i * 1000,
    kind: "team",
    source: "execution",
    cancellable: false,
    ...over,
  }
}

const setSelectedId = jest.fn()
const route = { setSelectedId } as unknown as SquadRouteState

beforeEach(() => {
  jest.clearAllMocks()
  mockSquads = []
  mockReviews = []
  mockRuns = []
})

it("addresses a run in its Squad's Runs tab, or in the cockpit without one", () => {
  expect(squadRunHref("team a", "execution:team:r1")).toBe(
    "/squads?id=team%20a&tab=runs&run=execution%3Ateam%3Ar1"
  )
  expect(squadRunHref(undefined, "x")).toBe(`${ALL_SQUAD_RUNS_HREF}&run=x`)
})

describe("needs you", () => {
  it("says calmly when nothing is waiting", () => {
    render(<SquadFleetOverview route={route} />)
    expect(screen.getByTestId("squad-fleet-overview-calm")).toHaveTextContent(
      "Nothing is waiting on you."
    )
  })

  /** Every open review on any Squad, each linked to the run that asks. */
  it("lists every open review, named by its Squad, linked to its run", () => {
    mockSquads = [row({ id: "a", name: "Alpha", waiting: true })]
    mockReviews = [
      {
        interruptId: "i1",
        executionRunId: "execution:team:r1",
        runId: "r1",
        teamId: "a",
        kind: "plan",
        createdAt: 1,
        expiresAt: 2,
        status: "open",
      },
    ]
    render(<SquadFleetOverview route={route} />)
    const review = screen.getByTestId("squad-fleet-overview-review")
    expect(review).toHaveTextContent("Plan approval")
    expect(review).toHaveTextContent("Alpha")
    expect(review).toHaveAttribute("href", "/squads?id=a&tab=runs&run=execution%3Ateam%3Ar1")
  })
})

describe("working now", () => {
  it("lists only the Squads that are working, one click from their page", async () => {
    mockSquads = [
      row({ id: "a", name: "Alpha", status: "executing", live: true }),
      row({ id: "b", name: "Bravo" }),
    ]
    render(<SquadFleetOverview route={route} />)
    const rows = screen.getAllByTestId("squad-fleet-overview-working-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("Alpha")
    await userEvent.click(rows[0]!)
    expect(setSelectedId).toHaveBeenCalledWith("a")
  })

  it("says where to start when nothing is working", () => {
    mockSquads = [row({ id: "b" })]
    render(<SquadFleetOverview route={route} />)
    expect(screen.getByTestId("squad-fleet-overview-idle")).toBeInTheDocument()
  })
})

describe("recent runs", () => {
  it("reads Squad runs only", () => {
    render(<SquadFleetOverview route={route} />)
    expect(cockpitOptions).toHaveBeenCalledWith({ kind: "team" })
  })

  it("shows the latest few and hands the rest to the cockpit", () => {
    mockSquads = [row({ id: "a", name: "Alpha" })]
    mockRuns = Array.from({ length: RECENT_RUN_LIMIT + 2 }, (_, i) =>
      run(i, i === 0 ? { teamId: "a" } : {})
    )
    render(<SquadFleetOverview route={route} />)
    const rows = screen.getAllByTestId("squad-fleet-overview-run")
    expect(rows).toHaveLength(RECENT_RUN_LIMIT)
    expect(rows[0]).toHaveTextContent("Alpha")
    expect(rows[0]).toHaveAttribute("href", "/squads?id=a&tab=runs&run=execution%3Ateam%3Ar0")
    expect(rows[1]).toHaveAttribute("href", `${ALL_SQUAD_RUNS_HREF}&run=execution%3Ateam%3Ar1`)
    expect(screen.getByTestId("squad-fleet-overview-all-runs")).toHaveAttribute(
      "href",
      ALL_SQUAD_RUNS_HREF
    )
  })

  it("says when no Squad has run yet", () => {
    render(<SquadFleetOverview route={route} />)
    expect(screen.getByTestId("squad-fleet-overview-no-runs")).toBeInTheDocument()
  })
})

/** The console composition `/bots` and `/devices` use. */
it("lays out its sections as console cards", () => {
  render(<SquadFleetOverview route={route} />)
  for (const id of ["needs-you", "working", "recent-runs"]) {
    expect(screen.getByTestId(`squad-fleet-overview-${id}`)).toHaveAttribute("data-variant", "card")
  }
})
