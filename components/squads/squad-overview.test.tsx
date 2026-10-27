/** @jest-environment jsdom */

// The Squad overview: which sections appear, in what order, and what each one
// says. Readiness is its own surface with its own suite, so it is stubbed.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockReadiness = { ready: true, loading: false, blockers: [] as { code: string }[] }
jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({ ...mockReadiness, evaluatedAt: 1 }),
}))
jest.mock("@/components/squads/squad-readiness-card", () => ({
  SquadReadinessCard: ({
    squadId,
    readiness,
    onAddTeammate,
  }: {
    squadId: string
    readiness?: { ready: boolean }
    onAddTeammate?: () => void
  }) => (
    <div
      data-testid="squad-readiness"
      data-squad={squadId}
      data-provided={readiness ? String(readiness.ready) : "none"}
      data-add-teammate={String(Boolean(onAddTeammate))}
    />
  ),
}))
jest.mock("@/hooks/agent-runs/use-team-pr-status", () => ({
  useTeamPrStatusByTeammate: () => new Map(),
}))

import { SquadOverview, countTasksByGlance, orderRoster } from "./squad-overview"
import type { PendingSquadReview } from "@/hooks/squads/use-pending-squad-reviews"
import type { SquadRunControl } from "@/hooks/squads/use-squad-run-control"
import {
  DEFAULT_TEAM_CONFIG,
  type AgentTeam,
  type AgentTeamTask,
  type AgentTeammate,
} from "@/types/agent/agent-team"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type { ExecutionRun } from "@/types/execution/run"

const squad = {
  id: "a",
  name: "Review Crew",
  description: "",
  status: "idle",
  teammateIds: [],
  taskIds: [],
  messageIds: [],
  config: DEFAULT_TEAM_CONFIG,
  task: "",
  leadId: "lead",
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as AgentTeam

function member(over: Partial<AgentTeammate>): AgentTeammate {
  return {
    id: "m",
    teamId: "a",
    name: "Member",
    role: "teammate",
    status: "idle",
    config: { runtime: "claude" },
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...over,
  } as AgentTeammate
}

function task(id: string, status: AgentTeamTask["status"]): AgentTeamTask {
  return { id, teamId: "a", title: id, status } as AgentTeamTask
}

function control(over: Partial<SquadRunControl> = {}): SquadRunControl {
  return {
    run: null,
    record: null,
    status: "idle",
    busy: false,
    remote: false,
    startDisabledReason: undefined,
    startOutcome: null,
    retryable: false,
    refusalMessage: undefined,
    refusalBlockers: [],
    canPause: false,
    canResume: false,
    canStop: false,
    start: jest.fn(),
    control: jest.fn(),
    ...over,
  }
}

const review: PendingSquadReview = {
  interruptId: "int_1",
  executionRunId: "execution:team:r1",
  runId: "r1",
  teamId: "a",
  kind: "plan",
  createdAt: 1,
  expiresAt: 2,
  status: "open",
}

const runHref = (id: string) => `/squads?id=a&tab=runs&run=${encodeURIComponent(id)}`
const onOpenBoard = jest.fn()
const onEditRoster = jest.fn()

/** The cards in reading order: the grid fills row by row. */
function sectionOrder(): string[] {
  const grid = screen.getByTestId("squad-overview").firstElementChild!
  return Array.from(grid.children).map((card) => card.getAttribute("data-testid") ?? "")
}

function mount(
  over: {
    members?: AgentTeammate[]
    tasks?: AgentTeamTask[]
    reviews?: PendingSquadReview[]
    control?: SquadRunControl
  } = {}
) {
  return render(
    <SquadOverview
      squad={squad}
      members={over.members ?? []}
      tasks={over.tasks ?? []}
      reviews={over.reviews ?? []}
      control={over.control ?? control()}
      runHref={runHref}
      onOpenBoard={onOpenBoard}
      onEditRoster={onEditRoster}
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockReadiness = { ready: true, loading: false, blockers: [] }
})

describe("triage order", () => {
  it("leads with the reviews that need you, linked into the run that asks", () => {
    mount({ reviews: [review] })
    expect(sectionOrder()[0]).toBe("squad-overview-needs-you")
    const link = screen.getByTestId("squad-overview-review")
    expect(link).toHaveTextContent("Plan approval")
    expect(link).toHaveAttribute("href", "/squads?id=a&tab=runs&run=execution%3Ateam%3Ar1")
  })

  it("has no Needs you section when nothing is waiting", () => {
    mount()
    expect(screen.queryByTestId("squad-overview-needs-you")).not.toBeInTheDocument()
  })

  /** A Squad that cannot start leads with what to fix, across the full width. */
  it("moves readiness to the front when the Squad is blocked", () => {
    mockReadiness = { ready: false, loading: false, blockers: [{ code: "no_teammates" }] }
    mount()
    expect(sectionOrder()).toEqual([
      "squad-overview-readiness",
      "squad-overview-latest-run",
      "squad-overview-tasks",
      "squad-overview-roster",
    ])
    expect(screen.getByTestId("squad-overview-readiness").className).toContain("col-span-2")
    expect(screen.getByTestId("squad-overview")).toHaveAttribute("data-blocked", "true")
  })

  /** Settled, readiness is reference material and pairs with the roster. */
  it("puts settled readiness last, beside the roster", () => {
    mount()
    expect(sectionOrder()).toEqual([
      "squad-overview-latest-run",
      "squad-overview-tasks",
      "squad-overview-roster",
      "squad-overview-readiness",
    ])
    expect(screen.getByTestId("squad-overview-roster").className).not.toContain("col-span-2")
  })

  /** Every section is a console card, the frame `/bots` and `/devices` use. */
  it("frames each section as a console card", () => {
    mount({ reviews: [review] })
    for (const id of sectionOrder()) {
      expect(screen.getByTestId(id)).toHaveAttribute("data-variant", "card")
    }
  })

  /** On a companion the Host judges readiness, so nothing local can block. */
  it("defers readiness to the Host on a companion", () => {
    mockReadiness = { ready: false, loading: false, blockers: [{ code: "host_unavailable" }] }
    mount({ control: control({ remote: true }) })
    expect(screen.getByTestId("squad-overview")).toHaveAttribute("data-blocked", "false")
    expect(screen.getByTestId("squad-overview-remote-readiness")).toHaveTextContent(
      "The Host checks readiness"
    )
    expect(screen.queryByTestId("squad-readiness")).not.toBeInTheDocument()
  })
})

/** One readiness read serves both the section order and the card. */
it("hands its readiness to the card rather than letting it read again", () => {
  mount()
  expect(screen.getByTestId("squad-readiness")).toHaveAttribute("data-provided", "true")
})

describe("latest run", () => {
  it("says there has been no run, and how to make one", () => {
    mount()
    expect(screen.getByTestId("squad-overview-no-run")).toHaveTextContent("No runs yet")
  })

  it("shows the objective, status and what the run cost", () => {
    const run = {
      id: "execution:team:r1",
      kind: "team",
      sourceId: "r1",
      title: "Fallback title",
      status: "completed",
      currentRevision: 1,
      startedAt: 1_000,
      updatedAt: 5_000,
      endedAt: 5_000,
    } as ExecutionRun
    const record = {
      id: "r1",
      objective: "Review the release branch",
      resourceUsage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        costUsd: 0.42,
        wallTimeMs: 62_000,
        toolTimeMs: 0,
        attempts: 1,
        failures: 0,
      },
    } as AgentTeamRunRecord
    mount({ control: control({ run, record }) })
    const section = screen.getByTestId("squad-overview-latest-run")
    expect(screen.getByTestId("squad-overview-objective")).toHaveTextContent(
      "Review the release branch"
    )
    expect(section).toHaveTextContent("1m 2s")
    expect(section).toHaveTextContent("1.5K")
    expect(section).toHaveTextContent("$0.42")
    expect(screen.getByTestId("squad-overview-open-run")).toHaveAttribute(
      "href",
      "/squads?id=a&tab=runs&run=execution%3Ateam%3Ar1"
    )
  })

  /** A paired device has no durable record, only the run's synced snapshot. */
  it("reads the spend off the synced snapshot when the record is not here", () => {
    const run = {
      id: "execution:team:r1",
      kind: "team",
      sourceId: "r1",
      title: "Remote run",
      status: "completed",
      currentRevision: 3,
      startedAt: 1_000,
      updatedAt: 5_000,
      endedAt: 5_000,
      latestSnapshot: {
        usage: {
          promptTokens: 2000,
          completionTokens: 500,
          totalTokens: 2500,
          costUsd: 1.25,
          wallTimeMs: 90_000,
        },
      },
    } as unknown as ExecutionRun
    mount({ control: control({ run }) })
    const section = screen.getByTestId("squad-overview-latest-run")
    expect(section).toHaveTextContent("2.5K")
    expect(section).toHaveTextContent("$1.25")
    expect(section).toHaveTextContent("1m 30s")
    expect(section).not.toHaveTextContent("Not recorded")
  })

  /** A companion may carry the journal row without the durable record. */
  it("falls back to the run title and says usage was not recorded", () => {
    const run = {
      id: "execution:team:r1",
      kind: "team",
      sourceId: "r1",
      title: "Fallback title",
      status: "running",
      currentRevision: 1,
      startedAt: 1_000,
      updatedAt: 5_000,
    } as ExecutionRun
    mount({ control: control({ run }) })
    expect(screen.getByTestId("squad-overview-objective")).toHaveTextContent("Fallback title")
    expect(screen.getByTestId("squad-overview-latest-run")).toHaveTextContent("Not recorded")
  })
})

describe("tasks", () => {
  it("counts the board in the groups a glance needs and opens it", async () => {
    mount({
      tasks: [
        task("t1", "pending"),
        task("t2", "in_progress"),
        task("t3", "review"),
        task("t4", "blocked"),
        task("t5", "completed"),
        task("t6", "cancelled"),
      ],
    })
    expect(screen.getByTestId("squad-overview-tasks-open")).toHaveTextContent("1")
    expect(screen.getByTestId("squad-overview-tasks-active")).toHaveTextContent("2")
    expect(screen.getByTestId("squad-overview-tasks-blocked")).toHaveTextContent("1")
    expect(screen.getByTestId("squad-overview-tasks-done")).toHaveTextContent("1")
    expect(screen.getByTestId("squad-overview-tasks-failed")).toHaveTextContent("1")
    await userEvent.click(screen.getByTestId("squad-overview-open-board"))
    expect(onOpenBoard).toHaveBeenCalled()
  })

  it("says where tasks come from when there are none", () => {
    mount()
    expect(screen.getByTestId("squad-overview-no-tasks")).toHaveTextContent("No tasks yet")
  })
})

describe("roster", () => {
  it("lists the lead first, marked, then teammates by name", () => {
    mount({
      members: [
        member({ id: "z", name: "Zed" }),
        member({ id: "lead", name: "Lead", role: "lead" }),
        member({ id: "b", name: "Bea", status: "executing" }),
      ],
    })
    const rows = screen.getAllByTestId(/^squad-overview-member-/)
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "squad-overview-member-lead",
      "squad-overview-member-b",
      "squad-overview-member-z",
    ])
    expect(rows[0]).toHaveTextContent("Lead")
  })

  /** Editing happens in the drawer over this page, not in Settings. */
  it("opens the edit drawer on the roster", async () => {
    mount()
    await userEvent.click(screen.getByTestId("squad-overview-edit-roster"))
    expect(onEditRoster).toHaveBeenCalled()
  })

  /** The readiness card's "Add a teammate" goes to the same drawer. */
  it("hands the drawer to the readiness card for adding a teammate", () => {
    mount()
    expect(screen.getByTestId("squad-readiness")).toHaveAttribute("data-add-teammate", "true")
  })
})

describe("pure helpers", () => {
  it("folds every task status into a glance group", () => {
    expect(
      countTasksByGlance([{ status: "claimed" }, { status: "failed" }, { status: "review" }])
    ).toEqual({ open: 1, active: 1, blocked: 0, done: 0, failed: 1 })
  })

  it("orders by role then name, honouring the Squad's lead id", () => {
    const ordered = orderRoster(
      [member({ id: "b", name: "B" }), member({ id: "x", name: "A" })],
      "b"
    )
    expect(ordered.map((m) => m.id)).toEqual(["b", "x"])
  })
})
