/** @jest-environment jsdom */

// The wide-pane console. Triage, workspace scope and narrowing moved into
// `useSquadFleet` and are tested there, against the store rather than through
// two layers of rendering. One Squad's view is `SquadDetailView` with its own
// suite, and so are the overview, the New Squad dialog and the edit drawer.
// What is left here is the frame: which panes exist, what the centre shows for
// each state of the URL, and where the header and the drawer send you.

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

import { SquadFleetConsole } from "./squad-fleet-console"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam, AgentTeammate, TeamStatus } from "@/types/agent/agent-team"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"

// Both are surfaces of their own with live Dexie queries. This suite is about
// the fleet frame around them.
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
// The board is `AgentTeamTasks`, its own surface with its own suite.
jest.mock("@/components/agent/workspace/tasks", () => ({
  AgentTeamTasks: ({ teamId }: { teamId: string }) => <div data-testid="task-board">{teamId}</div>,
}))
jest.mock("@/components/agent/workspace/team-run-controls", () => ({
  TeamRunControls: ({ status }: { status: string }) => (
    <div data-testid="run-controls">{status}</div>
  ),
}))
// The shell decides between side panes and overlay sheets by breakpoint.
let mockBreakpoint: "mobile" | "tablet" | "desktop" = "desktop"
jest.mock("@/hooks/ui", () => ({
  ...jest.requireActual("@/hooks/ui"),
  useBreakpoint: () => mockBreakpoint,
}))
// Radix menus do not open under jsdom's pointer model. Rendered flat, the
// content says what the overflow holds, and the trigger what opens it.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const mockRouterReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: jest.fn() }),
  usePathname: () => "/squads",
  useSearchParams: () => new URLSearchParams(),
}))

// The overview's run list is the cockpit's projection, with its own suite.
let mockRuns: Array<Record<string, unknown>> = []
jest.mock("@/hooks/agent-runs/use-agent-runs", () => ({
  useExecutionCockpit: () => ({ rows: mockRuns }),
}))
// `useClientLiveQuery` asks Dexie whether the mirror holds anything, to tell
// "not loaded yet" from "none". Answering 0 keeps every case here on the
// loaded path. The loading path is the hook's own case.
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => 0 }))

// The dialog and the drawer are surfaces with their own suites. Here they only
// have to show they were opened, and hand back what they made.
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
  SquadEditSheet: ({
    squadId,
    focus,
    onDeleted,
    onOpenSquad,
  }: {
    squadId: string
    focus?: string
    onDeleted: (id: string) => void
    onOpenSquad: (id: string) => void
  }) => (
    <div data-testid="edit-sheet-stub" data-squad={squadId} data-focus={focus ?? ""}>
      <button type="button" onClick={() => onDeleted(squadId)}>
        delete
      </button>
      <button type="button" onClick={() => onOpenSquad("copy")}>
        duplicate
      </button>
    </div>
  ),
}))

let fleetSource: "tauri" | "companion" | "none" = "none"
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({
  useFleetSnapshot: () => ({ source: fleetSource, snapshot: { sessions: [] } }),
}))
jest.mock("@/lib/ai/agent/team/agent-team", () => ({
  agentTeamManager: {
    start: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
  },
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

function seed(teams: AgentTeam[], members: AgentTeammate[] = []) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: Object.fromEntries(members.map((m) => [m.id, m])) as never,
    tasks: {} as never,
  })
}

const setSelectedId = jest.fn()
const setEditing = jest.fn()
const setRunId = jest.fn()
const setRunStatus = jest.fn()
const setTab = jest.fn()

/**
 * The URL state as a plain object. The route owns the hook, so a console case
 * poses the four answers directly instead of mocking `next/navigation`.
 */
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

/** The header's action buttons carry tooltips, mounted app-wide in the layout. */
function renderConsole(state: SquadRouteState) {
  return render(
    <TooltipProvider>
      <SquadFleetConsole route={state} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockBreakpoint = "desktop"
  mockRuns = []
  usePendingGatesStore.setState({ gates: [] } as never)
  fleetSource = "none"
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadFleetConsole", () => {
  it("counts the fleet in the header", () => {
    renderConsole(route())
    expect(screen.getByText("2 Squads · idle")).toBeInTheDocument()
  })

  it("leaves the header uncounted when there is no Squad to count", () => {
    // It read "none working of 0 Squads" beside the empty state.
    seed([])
    renderConsole(route())
    expect(screen.queryByText(/0 Squads/)).not.toBeInTheDocument()
    expect(screen.getByTestId("squad-fleet-onboarding")).toBeInTheDocument()
  })

  /**
   * One verb in the header. Creating used to be two sibling buttons, beside
   * two links of the same weight, and none of them said which came first.
   */
  it("offers New Squad as the header's only button, the rest in a menu", () => {
    fleetSource = "companion"
    renderConsole(route())
    const actions = screen.getByTestId("feature-header-actions")
    expect(within(actions).getByTestId("squad-fleet-new")).toHaveTextContent("New Squad")
    expect(within(actions).getByRole("button", { name: "More actions" })).toBeInTheDocument()
    const menu = screen.getByTestId("overflow-menu")
    expect(within(menu).getByTestId("squad-fleet-manage")).toHaveAttribute(
      "href",
      expect.stringContaining("section=squads")
    )
    expect(within(menu).getByTestId("squad-fleet-host-activity")).toHaveAttribute("href", "/fleet")
  })

  it("renders the rail as a real pane, never behind a Sheet glyph", () => {
    renderConsole(route())
    expect(screen.getAllByTestId("squad-fleet-row")).toHaveLength(2)
  })

  /** Only Squads in the rail; the chat sidebar's built-in Teams are not Squads. */
  it("lists only Squads in the rail", () => {
    renderConsole(route())
    expect(screen.queryByText("Built-in teams")).not.toBeInTheDocument()
  })

  /**
   * Two panes, not three: a selected Squad heads its own view in the centre,
   * and nothing opens a fourth column on the right.
   */
  it("never opens a right-hand pane", () => {
    renderConsole(route({ selectedId: "b" }))
    expect(screen.queryByLabelText("Squad detail")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("squad-detail-view")).toHaveLength(1)
  })
})

describe("SquadFleetConsole centre, nothing selected", () => {
  /**
   * The centre answers "what should I do next" across the fleet: what needs
   * an answer, what is working, the latest runs. It used to be a second list
   * (every Squad's runs) beside the rail's list.
   */
  it("shows the fleet overview", () => {
    seed([squad("a", "Alpha", "executing"), squad("b", "Bravo")])
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-overview")).toBeInTheDocument()
    expect(screen.getByTestId("squad-fleet-overview-working-row")).toHaveTextContent("Alpha")
    expect(screen.getByTestId("squad-fleet-overview-all-runs")).toHaveAttribute(
      "href",
      "/agent-runs?kind=team"
    )
    expect(screen.queryByTestId("squad-fleet-inspector")).not.toBeInTheDocument()
  })

  /** A Board with no Squad could only ever say "pick one", so there is none. */
  it("offers no Squad tabs, whatever tab the link named", () => {
    renderConsole(route({ tab: "board" }))
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument()
  })

  /**
   * `?run=` with no Squad named the all-runs cockpit this centre used to be.
   * That cockpit is `/agent-runs`, so the old link goes on to the same run.
   */
  it("sends an old all-runs link on to the run in /agent-runs", () => {
    renderConsole(route({ runId: "execution:team:run_9" }))
    expect(mockRouterReplace).toHaveBeenCalledWith(
      "/agent-runs?kind=team&run=execution%3Ateam%3Arun_9"
    )
  })

  it("leaves a run open inside a selected Squad alone", () => {
    renderConsole(route({ selectedId: "b", tab: "runs", runId: "execution:team:run_9" }))
    expect(mockRouterReplace).not.toHaveBeenCalled()
  })

  it("opens a working Squad from the overview", async () => {
    seed([squad("a", "Alpha", "executing")])
    renderConsole(route())
    await userEvent.click(screen.getByTestId("squad-fleet-overview-working-row"))
    expect(setSelectedId).toHaveBeenCalledWith("a")
  })
})

describe("SquadFleetConsole centre, a Squad selected", () => {
  it("lands on the Squad's overview, headed by its controls", () => {
    renderConsole(route({ selectedId: "b" }))
    expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Bravo")
    expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute("data-state", "active")
    expect(screen.getByTestId("squad-overview")).toBeInTheDocument()
  })

  it("pins the cockpit to the selected Squad's runs", async () => {
    renderConsole(route({ selectedId: "b", tab: "runs", runId: "execution:team:run_9" }))
    const panel = screen.getByTestId("agent-runs-panel")
    expect(panel).toHaveAttribute("data-team", "b")
    // `?run=` shares the `/agent-runs` id space, so a card's deep link lands here too.
    expect(panel).toHaveAttribute("data-run", "execution:team:run_9")
    await userEvent.click(screen.getByTestId("agent-runs-status-chip"))
    expect(setRunStatus).toHaveBeenCalledWith("failed")
  })

  it("shows the chosen Squad's board", () => {
    renderConsole(route({ tab: "board", selectedId: "a" }))
    expect(screen.getByTestId("task-board")).toHaveTextContent("a")
  })

  /** `squads` is the phone's list tab; a selected Squad has no such tab. */
  it("resolves the phone-only tab to the overview", () => {
    renderConsole(route({ tab: "squads", selectedId: "a" }))
    expect(screen.getByTestId("squad-detail-tab-overview")).toHaveAttribute("data-state", "active")
  })

  /**
   * Configure, Edit roster and Add a teammate edit the Squad beside the run
   * being watched, instead of leaving for Settings.
   */
  it("opens the edit drawer from Configure and Edit roster", async () => {
    renderConsole(route({ selectedId: "b" }))
    await userEvent.click(screen.getByTestId("squad-fleet-configure"))
    expect(setEditing).toHaveBeenCalledWith("general")
    await userEvent.click(screen.getByTestId("squad-overview-edit-roster"))
    expect(setEditing).toHaveBeenLastCalledWith("roster")
  })

  it("mounts the drawer on the selected Squad with what the URL opened", () => {
    renderConsole(route({ selectedId: "b", editing: "roster" }))
    const sheet = screen.getByTestId("edit-sheet-stub")
    expect(sheet).toHaveAttribute("data-squad", "b")
    expect(sheet).toHaveAttribute("data-focus", "roster")
  })

  it("leaves a deleted Squad, and opens a duplicate with its drawer", async () => {
    renderConsole(route({ selectedId: "b", editing: "general" }))
    await userEvent.click(screen.getByRole("button", { name: "delete" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
    await userEvent.click(screen.getByRole("button", { name: "duplicate" }))
    expect(setSelectedId).toHaveBeenLastCalledWith("copy", { edit: "general" })
  })

  it("has no drawer while nothing is selected", () => {
    renderConsole(route())
    expect(screen.queryByTestId("edit-sheet-stub")).not.toBeInTheDocument()
  })

  it("selects a Squad, and deselects when the same row is clicked again", async () => {
    const { unmount } = renderConsole(route())
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[0]!)
    expect(setSelectedId).toHaveBeenCalledWith("a")
    unmount()

    renderConsole(route({ selectedId: "a" }))
    await userEvent.click(screen.getAllByTestId("squad-fleet-row")[0]!)
    expect(setSelectedId).toHaveBeenLastCalledWith(undefined)
  })

  /**
   * Narrowing is about the list, not about what you were reading. Deriving the
   * view from the narrowed rows would blank the Squad you had open the moment
   * you typed into the search box.
   */
  it("keeps a Squad open after the filter has hidden its row", () => {
    renderConsole(route({ selectedId: "b", query: "Alpha", narrowed: true }))
    expect(screen.queryAllByTestId("squad-fleet-row")).toHaveLength(1)
    expect(screen.getByTestId("squad-fleet-inspector")).toHaveTextContent("Bravo")
  })

  /** A stale link used to leave a blank centre. */
  it("says a Squad is gone, and offers the way back to all of them", async () => {
    renderConsole(route({ selectedId: "gone" }))
    expect(screen.getByTestId("squad-fleet-missing")).toHaveTextContent("Squad unavailable")
    await userEvent.click(screen.getByRole("button", { name: "Show all Squads" }))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })
})

describe("SquadFleetConsole between md and lg", () => {
  /**
   * The shell moves the rail into a sheet below `lg`. Picking a Squad there is
   * the whole reason the sheet was opened, so the pick closes it and the
   * Squad's view is what the reader sees next.
   */
  it("closes the rail sheet on a pick", async () => {
    mockBreakpoint = "tablet"
    renderConsole(route())
    await userEvent.click(screen.getByRole("button", { name: /Squad list/ }))
    await userEvent.click((await screen.findAllByTestId("squad-fleet-row"))[0]!)
    expect(setSelectedId).toHaveBeenCalledWith("a")
    await waitFor(() => expect(screen.queryByTestId("squad-fleet-row")).not.toBeInTheDocument())
  })
})

describe("SquadFleetConsole host activity link", () => {
  /**
   * `/fleet` declares `standalone: "hidden"`, so on an unpaired browser the
   * route does not exist and the link would be a dead end.
   */
  it("hides it in an unpaired browser", () => {
    fleetSource = "none"
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-manage")).toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-host-activity")).not.toBeInTheDocument()
  })
})

describe("SquadFleetConsole creation", () => {
  /**
   * "New Squad" opens the dialog that names every way to start, and the Squad
   * it made opens with its drawer, because naming and staffing it is next.
   */
  it("creates from the header and opens the new Squad with its drawer", async () => {
    renderConsole(route())
    expect(screen.queryByTestId("create-dialog-stub")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("squad-fleet-new"))
    await userEvent.click(screen.getByTestId("create-dialog-stub"))
    expect(setSelectedId).toHaveBeenCalledWith("new", { edit: "general" })
  })

  /**
   * An empty workspace gets one full empty state, in the centre, with the way
   * to make a Squad. The rail beside it only says the list is empty.
   */
  it("offers the first Squad from the centre", async () => {
    seed([])
    renderConsole(route())
    expect(screen.getByTestId("squad-fleet-onboarding")).toBeInTheDocument()
    expect(screen.getByTestId("squad-fleet-empty-quiet")).toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-overview")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    expect(screen.getByTestId("create-dialog-stub")).toBeInTheDocument()
  })
})
