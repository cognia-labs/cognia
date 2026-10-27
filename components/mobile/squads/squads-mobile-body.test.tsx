/** @jest-environment jsdom */

// `/squads` on a phone: the list as the page, then one Squad full-screen. The
// Squad view itself (`SquadDetailView`) has its own suite; these cases are
// about which level is showing and how the phone moves between them.

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadsMobileBody } from "./squads-mobile-body"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam, TeamStatus } from "@/types/agent/agent-team"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"

jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({ ready: true, loading: false, blockers: [], evaluatedAt: 1 }),
}))
jest.mock("@/components/squads/squad-readiness-card", () => ({
  SquadReadinessCard: ({ squadId }: { squadId: string }) => (
    <div data-testid="squad-readiness" data-squad={squadId} />
  ),
}))
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: ({
    teamId,
    embedded,
    filterKind,
    selectedId,
    statusGroup,
    onStatusGroup,
  }: {
    teamId?: string
    embedded?: boolean
    filterKind?: string
    selectedId?: string
    statusGroup?: string
    onStatusGroup?: (group: string) => void
  }) => (
    <div
      data-testid="agent-runs-panel"
      data-team={teamId ?? ""}
      data-embedded={String(Boolean(embedded))}
      data-kind={filterKind ?? "all"}
      data-run={selectedId ?? ""}
      data-status={statusGroup ?? ""}
    >
      {/* The chips were rendered with no setter behind them. This stands in
          for one, so a case can prove the click reaches the URL. */}
      <button
        type="button"
        data-testid="agent-runs-status-chip"
        onClick={() => onStatusGroup?.("failed")}
      />
    </div>
  ),
}))
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId }: { teamId: string }) => <div data-testid="task-board">{teamId}</div>,
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: ({ status }: { status: string }) => (
    <div data-testid="run-controls">{status}</div>
  ),
}))
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => 0 }))
// The overview's run list is the cockpit's projection, with its own suite.
let mockRuns: Array<Record<string, unknown>> = []
jest.mock("@/hooks/agent-runs/use-agent-runs", () => ({
  useExecutionCockpit: () => ({ rows: mockRuns }),
}))
let fleetSource: "tauri" | "companion" | "none" = "none"
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({
  useFleetSnapshot: () => ({ source: fleetSource, snapshot: { sessions: [] } }),
}))
// Radix menus do not open under jsdom's pointer model; rendered flat, the
// content says what the menu holds.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="more-menu">{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
// The dialog and the drawer have suites of their own; here they only have to
// show they were opened and hand back what they made.
jest.mock("@/components/squads/create-squad-dialog", () => ({
  CreateSquadDialog: ({
    open,
    onCreated,
  }: {
    open: boolean
    onCreated: (squadId: string) => void
  }) =>
    open ? (
      <button type="button" data-testid="create-dialog-stub" onClick={() => onCreated("new")}>
        create
      </button>
    ) : null,
}))
jest.mock("@/components/squads/squad-edit-sheet", () => ({
  SquadEditSheet: ({ squadId, focus }: { squadId: string; focus?: string }) => (
    <div data-testid="edit-sheet-stub" data-squad={squadId} data-focus={focus ?? ""} />
  ),
}))

function squad(id: string, name: string, status: TeamStatus = "idle"): AgentTeam {
  return {
    id,
    name,
    description: "",
    status,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
  } as unknown as AgentTeam
}

function seed(teams: AgentTeam[]) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: {} as never,
    tasks: {} as never,
  })
}

const setSelectedId = jest.fn()
const setEditing = jest.fn()
const setRunId = jest.fn()
const setRunStatus = jest.fn()
const setTab = jest.fn()

function route(over: Partial<SquadRouteState> = {}): SquadRouteState {
  return {
    selectedId: undefined,
    runId: undefined,
    runStatus: "all",
    tab: undefined,
    query: "",
    filter: "all",
    editing: undefined,
    narrowed: false,
    runHref: (runId) => `/squads?tab=runs&run=${encodeURIComponent(runId)}`,
    setSelectedId,
    setEditing,
    setRunId,
    setRunStatus,
    setTab,
    setQuery: jest.fn(),
    setFilter: jest.fn(),
    clearFilters: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRuns = []
  fleetSource = "none"
  usePendingGatesStore.setState({ gates: [] } as never)
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadsMobileBody, the list", () => {
  /**
   * The shell owns `data-bg-target` for every route that goes through it.
   * This body does not go through it, so without the mark the wallpaper has
   * nothing to paint against and the page renders on bare canvas.
   */
  it("marks itself as a wallpaper target, which the shell would otherwise do", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-body")).toHaveAttribute("data-bg-target", "chat")
  })

  /**
   * Landing a phone on "no durable runs match these filters" is the page
   * answering a question nobody asked while withholding the one they did.
   */
  it("opens on the Squads when the URL names no tab", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squads-mobile-tab-squads")).toHaveAttribute("data-state", "active")
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
  })

  /** Over the wallpaper the rows share one surface rather than a card each. */
  it("groups the rows on the page", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByTestId("squad-fleet-rail")).toHaveAttribute("data-variant", "page")
  })

  /**
   * The list and the fleet overview, the same component the wide pane centres.
   * A Board with no Squad selected rendered the list a second time.
   */
  it("offers the fleet overview and the list, and no Squad-less board", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Squads",
    ])
  })

  it("lands a board link with no Squad on the list", () => {
    render(<SquadsMobileBody route={route({ tab: "board" })} />)
    expect(screen.getByTestId("squads-mobile-tab-squads")).toHaveAttribute("data-state", "active")
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument()
  })

  it("shows the fleet overview on its tab", () => {
    seed([squad("a", "Alpha", "executing"), squad("b", "Bravo")])
    render(<SquadsMobileBody route={route({ tab: "overview" })} />)
    expect(screen.getByTestId("squad-fleet-overview")).toBeInTheDocument()
    expect(screen.getByTestId("squad-fleet-overview-working-row")).toHaveTextContent("Alpha")
  })

  /** The retired all-runs tab: an old link lands on the overview. */
  it("opens an old all-runs link on the overview", () => {
    render(<SquadsMobileBody route={route({ tab: "runs" })} />)
    expect(screen.getByTestId("squads-mobile-tab-overview")).toHaveAttribute(
      "data-state",
      "active"
    )
  })

  it("reports a tab change instead of owning it", async () => {
    const user = userEvent.setup()
    render(<SquadsMobileBody route={route()} />)
    screen.getByRole("tab", { name: "Squads" }).focus()
    await user.keyboard("{ArrowLeft}")
    expect(setTab).toHaveBeenCalledWith("overview")
  })

  it("opens a Squad from its row", async () => {
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[1]!)
    expect(setSelectedId).toHaveBeenCalledWith("b")
  })
})

describe("SquadsMobileBody, one Squad", () => {
  /**
   * The selection is a URL param, so a link opens the Squad directly. It used
   * to open a drawer over the list, whose Runs and Board tabs stayed scoped to
   * a Squad nothing on screen named.
   */
  it("replaces the list with the Squad's own view", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Bravo")
    expect(screen.queryByTestId("squads-mobile-tab-squads")).not.toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("lands on the overview and keeps the Squad's tabs", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute(
      "data-state",
      "active"
    )
    expect(screen.getByTestId("squad-detail-tab-runs")).toBeInTheDocument()
    expect(screen.getByTestId("squad-detail-tab-board")).toBeInTheDocument()
  })

  it("goes back to the list", async () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    await userEvent.click(screen.getByRole("button", { name: "Back to Squads" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })

  it("pins the compact cockpit to the Squad", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b", tab: "runs" })} />)
    expect(screen.getByTestId("agent-runs-panel")).toHaveAttribute("data-team", "b")
  })

  it("shows the chosen Squad's board", () => {
    render(<SquadsMobileBody route={route({ tab: "board", selectedId: "a" })} />)
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })

  /** Configuring opens the drawer over the Squad instead of leaving for Settings. */
  it("opens the edit drawer from Configure", async () => {
    render(<SquadsMobileBody route={route({ selectedId: "b" })} />)
    await userEvent.click(screen.getByTestId("squad-fleet-configure"))
    expect(setEditing).toHaveBeenCalledWith("general")
  })

  it("mounts the drawer on the Squad the URL opened it on", () => {
    render(<SquadsMobileBody route={route({ selectedId: "b", editing: "roster" })} />)
    expect(screen.getByTestId("edit-sheet-stub")).toHaveAttribute("data-squad", "b")
    expect(screen.getByTestId("edit-sheet-stub")).toHaveAttribute("data-focus", "roster")
  })

  /** A stale link says so, and the way back clears the dead `?id=`. */
  it("says a Squad is gone and offers the way back to all of them", async () => {
    render(<SquadsMobileBody route={route({ selectedId: "gone" })} />)
    expect(screen.getByTestId("squads-mobile-missing")).toHaveTextContent("Squad unavailable")
    expect(screen.queryByTestId("squad-fleet-row")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Show all Squads" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })
})

describe("creation", () => {
  /** The first Squad, and every one after, starts in the New Squad dialog. */
  it("offers a way to make the first Squad without leaving for Settings", async () => {
    seed([])
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    await userEvent.click(screen.getByTestId("create-dialog-stub"))
    // And lands on it with its drawer, since naming and staffing it is next.
    expect(setSelectedId).toHaveBeenCalledWith("new", { edit: "general" })
  })

  /** One verb in the top bar; the rest live in its menu. */
  it("creates from the top bar", async () => {
    render(<SquadsMobileBody route={route()} />)
    await userEvent.click(screen.getByTestId("squads-mobile-create"))
    expect(screen.getByTestId("create-dialog-stub")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Compose from an objective" })).toBeNull()
  })

  it("keeps Settings and the host's activity in the menu", () => {
    fleetSource = "companion"
    render(<SquadsMobileBody route={route()} />)
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument()
    const menu = screen.getByTestId("more-menu")
    expect(within(menu).getByTestId("squads-mobile-manage")).toHaveAttribute(
      "href",
      expect.stringContaining("section=squads")
    )
    expect(within(menu).getByTestId("squads-mobile-host-activity")).toHaveAttribute(
      "href",
      "/fleet"
    )
  })

  it("leaves the host's activity out in an unpaired browser", () => {
    render(<SquadsMobileBody route={route()} />)
    expect(screen.queryByTestId("squads-mobile-host-activity")).not.toBeInTheDocument()
  })
})
