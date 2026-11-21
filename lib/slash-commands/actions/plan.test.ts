// `/plan` command family — the surface that makes every PlanSource reachable.
//
// `@/lib/agent/plan/projections` is deliberately NOT mocked: the point of these
// tests is to prove the real `planInputFromGoal` / `planInputFromTeam` mappers
// are on a live call path, not just that a stub was invoked.

jest.mock("@/lib/agent/plan/runtime", () => ({ getPlanRuntime: jest.fn() }))
jest.mock("@/lib/agent/plan/plan-settings", () => ({ loadPlanConfigDefaults: jest.fn() }))
jest.mock("@/lib/agent/plan/planner", () => ({ decomposeIntoPlan: jest.fn() }))
jest.mock("@/lib/ai/generation/agent-role-client", () => ({
  buildAgentRoleLlmClient: jest.fn(),
}))
jest.mock("@/lib/goal/runtime", () => ({ getGoalRuntime: jest.fn() }))
jest.mock("@/lib/db/plans", () => ({ listPlanEvents: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: { getState: jest.fn() } }))
jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: { getState: jest.fn() },
}))
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: jest.fn(),
  listWorkflows: jest.fn(),
  createWorkflow: jest.fn(),
}))
// Which installed plugin registers a `tool_call` step's tool (export resolves it).
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => ({
  resolvePluginToolByName: jest.fn(),
}))

// `next-intl` ships ESM Jest does not transform. The `/plan to-workflow`
// replies go through `getRuntimeTranslator("plan.export")`, replaced here by
// one over the real `plan` bundle of the locale under test, so the cases prove
// every key resolves in both locales.
let mockLocale: "en" | "zh-CN" = "en"
const mockMissing: string[] = []
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async (namespace?: string) => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const bundle = (
      mockLocale === "en"
        ? require("@/i18n/messages/en/plan.json")
        : require("@/i18n/messages/zh-CN/plan.json")
    ) as Record<string, unknown>
    /* eslint-enable @typescript-eslint/no-require-imports */
    const lookup = (key: string): unknown =>
      `${namespace ? namespace.replace(/^plan\.?/, "") + "." : ""}${key}`
        .split(".")
        .filter(Boolean)
        .reduce<unknown>(
          (node, seg) =>
            node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined,
          bundle
        )
    return (key: string, values: Record<string, unknown> = {}) => {
      const message = lookup(key)
      if (typeof message !== "string") {
        mockMissing.push(key)
        return `${namespace}.${key}`
      }
      return message
        .replace(
          /\{(\w+), plural, (?:one \{([^{}]*)\} )?other \{([^{}]*)\}\}/g,
          (_m, name: string, one: string | undefined, other: string) =>
            (values[name] === 1 && one !== undefined ? one : other).replace(
              "#",
              String(values[name])
            )
        )
        .replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]))
    }
  },
}))

import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { loadPlanConfigDefaults } from "@/lib/agent/plan/plan-settings"
import { decomposeIntoPlan } from "@/lib/agent/plan/planner"
import { buildAgentRoleLlmClient } from "@/lib/ai/generation/agent-role-client"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { listPlanEvents } from "@/lib/db/plans"
import { getSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { createWorkflow, getWorkflow, listWorkflows } from "@/lib/db/workflows"
import { resolvePluginToolByName } from "@/lib/plugin/core/invoke-plugin-tool"
import { dispatchPlanSubcommand } from "./plan"
import type { SlashContext } from "../builtin"
import type { AgentPlan, CreatePlanInput } from "@/types/agent/plan"

const getPlanRuntimeMock = getPlanRuntime as jest.Mock
const loadPlanConfigDefaultsMock = loadPlanConfigDefaults as jest.Mock
const decomposeIntoPlanMock = decomposeIntoPlan as jest.Mock
const buildAgentRoleLlmClientMock = buildAgentRoleLlmClient as jest.Mock
const getGoalRuntimeMock = getGoalRuntime as jest.Mock
const getSessionMock = getSession as jest.Mock
const settingsStateMock = useSettingsStore.getState as jest.Mock
const teamStateMock = useAgentTeamStore.getState as jest.Mock
const getWorkflowMock = getWorkflow as jest.Mock
const listWorkflowsMock = listWorkflows as jest.Mock
const createWorkflowMock = createWorkflow as jest.Mock

const createPlan = jest.fn()
const getOpenPlanForSession = jest.fn()
const listPlansBySession = jest.fn()
const getPlan = jest.fn()
const cancelPlan = jest.fn()
const rejectPlan = jest.fn()
const recordWorkflowExport = jest.fn()
const getOpenGoalForSession = jest.fn()

/** The plan `createPlan` echoes back, shaped from whatever input it received. */
function planFrom(input: CreatePlanInput): AgentPlan {
  const steps = (input.steps ?? []).map((s, i) => ({
    id: `st${i}`,
    title: s.title,
    kind: s.kind,
    status: "pending" as const,
    order: i,
    dependencies: [] as string[],
    ...(s.params ? { params: s.params } : {}),
  }))
  return {
    id: "p1",
    sessionId: input.sessionId,
    title: input.title,
    source: input.source,
    executionMode: input.executionMode ?? "auto",
    steps,
    status: "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: (input.config ?? {}) as AgentPlan["config"],
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  } as AgentPlan
}

function ctx(over: Partial<SlashContext> = {}): SlashContext {
  return {
    args: "",
    activeSessionId: "ses_a",
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: () => {},
    openSettings: () => {},
    setPermissionMode: () => {},
    pushSystemMessage: () => {},
    ...over,
  } as SlashContext
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLocale = "en"
  mockMissing.length = 0
  recordWorkflowExport.mockResolvedValue(undefined)
  jest.mocked(resolvePluginToolByName).mockResolvedValue(undefined)
  createPlan.mockImplementation(async (input: CreatePlanInput) => planFrom(input))
  getOpenPlanForSession.mockResolvedValue(undefined)
  listPlansBySession.mockResolvedValue([])
  getPlan.mockResolvedValue(undefined)
  jest.mocked(listPlanEvents).mockResolvedValue([])
  cancelPlan.mockResolvedValue(null)
  getOpenGoalForSession.mockResolvedValue(undefined)
  rejectPlan.mockImplementation(async (id: string) => ({ id, status: "rejected" }))
  getPlanRuntimeMock.mockReturnValue({
    createPlan,
    getOpenPlanForSession,
    listPlansBySession,
    getPlan,
    cancelPlan,
    rejectPlan,
    recordWorkflowExport,
  })
  getGoalRuntimeMock.mockReturnValue({ getOpenGoalForSession })
  loadPlanConfigDefaultsMock.mockResolvedValue(undefined)
  getSessionMock.mockResolvedValue({ id: "ses_a", characterId: "char_1" })
  settingsStateMock.mockReturnValue({ settings: {} })
  teamStateMock.mockReturnValue({ teams: {}, tasks: {} })
  buildAgentRoleLlmClientMock.mockResolvedValue({ complete: jest.fn() })
})

describe("guards", () => {
  it("refuses without an active session", async () => {
    const res = await dispatchPlanSubcommand(ctx({ activeSessionId: null }))
    expect(res.system).toMatch(/Start a chat session first/)
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("refuses mid-stream", async () => {
    const res = await dispatchPlanSubcommand(ctx({ chatStatus: "streaming", args: "do a thing" }))
    expect(res.system).toMatch(/still streaming/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan (status)", () => {
  it("lists the ways to start one when there is no open plan", async () => {
    const res = await dispatchPlanSubcommand(ctx())
    expect(res.system).toMatch(/No open plan/)
    expect(res.system).toContain("/plan from-goal")
  })

  it("renders a checklist for the open plan", async () => {
    getOpenPlanForSession.mockResolvedValue({
      ...planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] }),
      status: "executing",
      totalSteps: 2,
      completedSteps: 1,
      steps: [
        {
          id: "a",
          title: "one",
          kind: "agent_turn",
          status: "completed",
          order: 0,
          dependencies: [],
        },
        {
          id: "b",
          title: "two",
          kind: "agent_turn",
          status: "in_progress",
          order: 1,
          dependencies: [],
        },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "status" }))
    expect(res.system).toContain("EXECUTING")
    expect(res.system).toContain("- [x] one")
    expect(res.system).toContain("- [~] two")
  })

  it("treats a bare `/plan` with no argument as status", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: undefined }))
    expect(res.system).toMatch(/No open plan/)
  })

  // Every status/step-status pair renders its own glyph, so a checklist is
  // readable at a glance without opening the tracker dock.
  it.each([
    ["executing", "🟢"],
    ["paused", "⏸️"],
    ["completed", "✅"],
    ["failed", "🛑"],
    ["cancelled", "⏹️"],
    ["awaiting_approval", "🕐"],
    ["draft", "•"],
  ] as const)("marks a %s plan with %s", async (status, glyph) => {
    getOpenPlanForSession.mockResolvedValue({
      ...planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] }),
      status,
    })
    expect((await dispatchPlanSubcommand(ctx({ args: "status" }))).system).toContain(glyph)
  })

  it.each([
    ["failed", "- [!]"],
    ["blocked", "- [!]"],
    ["skipped", "- [-]"],
    ["pending", "- [ ]"],
  ] as const)("marks a %s step with `%s`", async (status, glyph) => {
    getOpenPlanForSession.mockResolvedValue({
      ...planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] }),
      steps: [
        {
          id: "a",
          title: "one",
          kind: "agent_turn",
          status,
          order: 0,
          dependencies: [] as string[],
        },
      ],
    })
    expect((await dispatchPlanSubcommand(ctx({ args: "status" }))).system).toContain(`${glyph} one`)
  })
})

describe("/plan <objective> — planner_llm", () => {
  it("decomposes and creates the plan", async () => {
    decomposeIntoPlanMock.mockResolvedValue({
      sessionId: "ses_a",
      title: "Migrate auth",
      source: "planner_llm",
      executionMode: "auto",
      steps: [
        { title: "audit callers", kind: "agent_turn" },
        { title: "swap the adapter", kind: "agent_turn", dependsOn: [0] },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "migrate the auth module" }))
    expect(decomposeIntoPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_a", characterId: "char_1" })
    )
    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ source: "planner_llm" }))
    expect(res.system).toContain("Plan created")
    expect(res.system).toContain("1. audit callers")
  })

  it("PII red-line: redacts the objective before it reaches the planner", async () => {
    decomposeIntoPlanMock.mockResolvedValue(null)
    await dispatchPlanSubcommand(ctx({ args: "email john.doe@example.com the rollout plan" }))
    const objective = decomposeIntoPlanMock.mock.calls[0][0].objective as string
    expect(objective).not.toContain("john.doe@example.com")
  })

  it("explains how to proceed when no planner model is configured", async () => {
    buildAgentRoleLlmClientMock.mockResolvedValue(null)
    const res = await dispatchPlanSubcommand(ctx({ args: "do the thing" }))
    expect(res.system).toMatch(/No planner model available/)
    expect(decomposeIntoPlanMock).not.toHaveBeenCalled()
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("reports an unusable planner response without creating a plan", async () => {
    decomposeIntoPlanMock.mockResolvedValue(null)
    const res = await dispatchPlanSubcommand(ctx({ args: "vague" }))
    expect(res.system).toMatch(/no usable steps/)
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("decomposes without a session row or app settings (no characterId pinned)", async () => {
    // A session that cannot be read must not block planning — the character
    // binding is optional context, not a precondition.
    getSessionMock.mockResolvedValue(undefined)
    settingsStateMock.mockReturnValue({})
    decomposeIntoPlanMock.mockResolvedValue({
      sessionId: "ses_a",
      title: "T",
      source: "planner_llm",
      steps: [{ title: "one", kind: "agent_turn" }],
    })
    await dispatchPlanSubcommand(ctx({ args: "do it" }))
    expect(buildAgentRoleLlmClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "plan", session: null, appSettings: null })
    )
    expect(decomposeIntoPlanMock.mock.calls[0][0]).not.toHaveProperty("characterId")
  })

  it("announces that an auto-approved plan skipped the gate", async () => {
    createPlan.mockImplementation(async (input: CreatePlanInput) => ({
      ...planFrom(input),
      status: "approved",
    }))
    decomposeIntoPlanMock.mockResolvedValue({
      sessionId: "ses_a",
      title: "T",
      source: "planner_llm",
      steps: [{ title: "one", kind: "agent_turn" }],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "do it" }))
    expect(res.system).toMatch(/Approval is off/)
  })
})

describe("/plan new — manual", () => {
  it("splits on pipes into a title + linear steps", async () => {
    const res = await dispatchPlanSubcommand(
      ctx({ args: "new Ship v2 | write changelog | tag the release | publish" })
    )
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("manual")
    expect(input.title).toBe("Ship v2")
    expect(input.steps.map((s) => s.title)).toEqual([
      "write changelog",
      "tag the release",
      "publish",
    ])
    // Linear chain: every step but the first depends on its predecessor.
    expect(input.steps[0].dependsOn).toBeUndefined()
    expect(input.steps[1].dependsOn).toEqual([0])
    expect(res.system).toContain("hand-authored")
  })

  it("also accepts newline-separated steps", async () => {
    await dispatchPlanSubcommand(ctx({ args: "new Ship v2\nstep one\nstep two" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.steps.map((s) => s.title)).toEqual(["step one", "step two"])
  })

  it("prints usage when no steps are supplied", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "new just a title" }))
    expect(res.system).toMatch(/Usage:/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan from-goal — goal_projection", () => {
  it("projects the open goal's subgoals into linear agent_turn steps", async () => {
    getOpenGoalForSession.mockResolvedValue({
      id: "g1",
      sessionId: "ses_a",
      characterId: "char_1",
      safeObjective: "ship the redesign",
      subgoals: [
        { id: "sg2", text: "second", order: 1, done: false },
        { id: "sg1", text: "first", order: 0, done: false },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "from-goal" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("goal_projection")
    expect(input.executionMode).toBe("in_session")
    // Ordered by `order`, not array position.
    expect(input.steps.map((s) => s.title)).toEqual(["first", "second"])
    expect(input.metadata).toEqual({ goalId: "g1" })
    expect(res.system).toContain("projected from the active goal")
  })

  it("tells the user to start a goal first", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "from-goal" }))
    expect(res.system).toMatch(/No open goal/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan from-team — team_projection", () => {
  const team = { id: "team_a", name: "Team tasks", description: "team tasks" }

  it("projects the session team's tasks into runnable teammate_dispatch steps", async () => {
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId: team.id })
    teamStateMock.mockReturnValue({
      teams: { [team.id]: team },
      tasks: {
        t2: {
          id: "t2",
          teamId: team.id,
          title: "second",
          description: "",
          dependencies: ["t1"],
          order: 1,
          assignedTo: "mate_a",
        },
        t1: {
          id: "t1",
          teamId: team.id,
          title: "first",
          description: "",
          dependencies: [],
          order: 0,
          assignedTo: "any",
        },
        other: { id: "other", teamId: "team_z", title: "elsewhere", dependencies: [], order: 0 },
      },
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("team_projection")
    expect(input.executionMode).toBe("orchestrated")
    expect(input.steps.map((s) => s.title)).toEqual(["first", "second"])
    // `assignedTo: "any"` is not a teammate id and must not be pinned; every
    // step names its team, which the dispatcher requires to run it.
    expect(input.steps[0].params).toEqual({ kind: "teammate_dispatch", teamId: team.id })
    expect(input.steps[1].params).toEqual({
      kind: "teammate_dispatch",
      teamId: team.id,
      teammateId: "mate_a",
    })
    // Dependencies survive as index refs into the ordered list.
    expect(input.steps[1].dependsOn).toEqual([0])
    expect(res.system).toContain("projected from the team task list")
  })

  /**
   * ADR-0140 binds a conversation to a Squad with `ChatSession.squadId`, which
   * is where its task DAG actually lives. Reading only `teamId` sent every
   * Squad-bound conversation to a team it was not handed to, so `/plan from-team`
   * reported "no team tasks" for a Squad that had them.
   */
  it("prefers the Squad the conversation is handed to", async () => {
    getSessionMock.mockResolvedValue({ id: "ses_a", squadId: "squad_1", teamId: "team_real" })
    teamStateMock.mockReturnValue({
      teams: { squad_1: { id: "squad_1", name: "Review Crew" } },
      tasks: { t1: { id: "t1", teamId: "squad_1", title: "a", dependencies: [], order: 0 } },
    })
    await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).metadata).toEqual({
      teamId: "squad_1",
    })
  })

  it("uses the session's own team when it is not handed to a Squad", async () => {
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId: "team_real" })
    teamStateMock.mockReturnValue({
      teams: { team_real: { id: "team_real", name: "Real team" } },
      tasks: { t1: { id: "t1", teamId: "team_real", title: "a", dependencies: [], order: 0 } },
    })
    await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).metadata).toEqual({
      teamId: "team_real",
    })
  })

  it("explains that a plain chat has no team to project", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect(res.system).toMatch(/No team tasks/)
    expect(createPlan).not.toHaveBeenCalled()
  })

  it("reports an empty team instead of creating a zero-step plan", async () => {
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId: team.id })
    teamStateMock.mockReturnValue({ teams: { [team.id]: team }, tasks: {} })
    const res = await dispatchPlanSubcommand(ctx({ args: "from-team" }))
    expect(res.system).toMatch(/no tasks to project/)
    expect(createPlan).not.toHaveBeenCalled()
  })
})

describe("/plan to-team — reverse projection", () => {
  const upsertTask = jest.fn()
  const teamId = "team_a"

  beforeEach(() => {
    upsertTask.mockReset()
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId })
    teamStateMock.mockReturnValue({
      teams: { [teamId]: { id: teamId, name: "Team tasks" } },
      tasks: {},
      upsertTask,
    })
  })

  it("mirrors the plan's steps into team tasks, preserving ids and the DAG", async () => {
    getOpenPlanForSession.mockResolvedValue({
      id: "p1",
      title: "Ship v2",
      steps: [
        { id: "st0", title: "first", description: "", dependencies: [], order: 0 },
        { id: "st1", title: "second", description: "detail", dependencies: ["st0"], order: 1 },
      ],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).toHaveBeenCalledTimes(2)
    // Step ids become task ids, so the dependency edge survives verbatim —
    // that is the whole reason this uses upsertTask over createTask.
    expect(upsertTask.mock.calls[0][0]).toMatchObject({ id: "st0", teamId, dependencies: [] })
    expect(upsertTask.mock.calls[1][0]).toMatchObject({ id: "st1", dependencies: ["st0"] })
    expect(res.system).toContain("Projected 2 step(s)")
  })

  it("refuses without an open plan", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).not.toHaveBeenCalled()
    expect(res.system).toMatch(/No open plan to project/)
  })

  it("refuses to project a plan with no steps", async () => {
    getOpenPlanForSession.mockResolvedValue({ id: "p1", title: "Empty", steps: [] })
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).not.toHaveBeenCalled()
    expect(res.system).toMatch(/no steps to project/)
  })

  it("reports a team it could not resolve rather than dropping the steps", async () => {
    // The session points at a team that is no longer in the store. Writing
    // tasks against a missing team would silently lose them.
    getSessionMock.mockResolvedValue({ id: "ses_a", teamId: "team_deleted" })
    teamStateMock.mockReturnValue({ teams: {}, tasks: {}, upsertTask })
    getOpenPlanForSession.mockResolvedValue({
      id: "p1",
      title: "Ship v2",
      steps: [{ id: "st0", title: "first", dependencies: [], order: 0 }],
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "to-team" }))
    expect(upsertTask).not.toHaveBeenCalled()
    expect(res.system).toMatch(/Could not resolve a team/)
  })
})

describe("/plan status — halts and rejection", () => {
  const base = () => planFrom({ sessionId: "ses_a", title: "Ship", source: "manual", steps: [] })

  it("shows a halted step's error and where to recover it", async () => {
    getOpenPlanForSession.mockResolvedValue({
      ...base(),
      status: "paused",
      steps: [
        {
          id: "a",
          title: "migrate",
          kind: "agent_turn",
          status: "failed",
          order: 0,
          dependencies: [],
          error: "Pi process exited",
        },
      ],
      stepHalt: { stepId: "a", cause: "turn_failed", detail: "Pi process exited", at: 1 },
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "status" }))
    expect(res.system).toContain("- [!] migrate")
    expect(res.system).toContain("⚠️ Pi process exited")
    expect(res.system).toContain('Halted on "migrate"')
    expect(res.system).toContain("turn failed")
    // A running plan is cancelled, not rejected.
    expect(res.system).not.toContain("/plan reject")
  })

  it("offers /plan reject while the plan awaits approval", async () => {
    getOpenPlanForSession.mockResolvedValue(base())
    const res = await dispatchPlanSubcommand(ctx({ args: "status" }))
    expect(res.system).toContain("/plan reject")
  })
})

describe("/plan reject", () => {
  it("rejects a plan awaiting approval with the reason", async () => {
    getOpenPlanForSession.mockResolvedValue({
      id: "p9",
      title: "Ship",
      status: "awaiting_approval",
    })
    const res = await dispatchPlanSubcommand(ctx({ args: "reject out of scope" }))
    expect(rejectPlan).toHaveBeenCalledWith("p9", "out of scope")
    expect(res.system).toContain("🚫 Plan rejected")
    expect(res.system).toContain("> out of scope")
  })

  it("rejects without a reason", async () => {
    getOpenPlanForSession.mockResolvedValue({ id: "p9", title: "Ship", status: "draft" })
    const res = await dispatchPlanSubcommand(ctx({ args: "reject" }))
    expect(rejectPlan).toHaveBeenCalledWith("p9", undefined)
    expect(res.system).not.toContain(">")
  })

  it("points a running plan at /plan cancel instead", async () => {
    getOpenPlanForSession.mockResolvedValue({ id: "p9", title: "Ship", status: "executing" })
    const res = await dispatchPlanSubcommand(ctx({ args: "reject" }))
    expect(rejectPlan).not.toHaveBeenCalled()
    expect(res.system).toContain("/plan cancel")
  })

  it("reports a rejection the runtime refused, and the no-plan case", async () => {
    getOpenPlanForSession.mockResolvedValue({ id: "p9", title: "Ship", status: "approved" })
    rejectPlan.mockResolvedValueOnce({ id: "p9", status: "approved" })
    expect((await dispatchPlanSubcommand(ctx({ args: "reject" }))).system).toMatch(
      /could not be rejected/
    )
    getOpenPlanForSession.mockResolvedValue(undefined)
    expect((await dispatchPlanSubcommand(ctx({ args: "reject" }))).system).toMatch(
      /No open plan to reject/
    )
  })
})

describe("/plan cancel", () => {
  it.each(["cancel", "stop", "clear"])("%s cancels the open plan", async (word) => {
    getOpenPlanForSession.mockResolvedValue({
      id: "p9",
      title: "Ship",
      completedSteps: 1,
      totalSteps: 3,
    })
    const res = await dispatchPlanSubcommand(ctx({ args: word }))
    expect(cancelPlan).toHaveBeenCalledWith("p9")
    expect(res.system).toContain("1/3")
  })

  it("is a no-op without an open plan", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "cancel" }))
    expect(cancelPlan).not.toHaveBeenCalled()
    expect(res.system).toMatch(/No open plan to cancel/)
  })
})

describe("plan settings defaults", () => {
  it("merges the user's plan defaults into every created plan", async () => {
    loadPlanConfigDefaultsMock.mockResolvedValue({ requireApproval: false, maxAutoRefinements: 5 })
    await dispatchPlanSubcommand(ctx({ args: "new T | a | b" }))
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).config).toEqual({
      requireApproval: false,
      maxAutoRefinements: 5,
    })
  })

  it("keeps working when the session row cannot be read", async () => {
    getSessionMock.mockRejectedValue(new Error("dexie down"))
    await dispatchPlanSubcommand(ctx({ args: "new T | a" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.characterId).toBeUndefined()
    expect(input.title).toBe("T")
  })
})

// `/plan to-workflow` / `/plan from-workflow` — the durable half of the
// plan⇄workflow conversion. The ephemeral compile that `runPlan` performs is
// never persisted; these two are.
describe("plan ⇄ workflow conversion", () => {
  /** An open plan with the given steps, in order, each depending on the last. */
  function openPlan(
    steps: Array<Pick<AgentPlan["steps"][number], "id" | "title" | "kind" | "params">>
  ): AgentPlan {
    return {
      id: "p1",
      sessionId: "ses_1",
      title: "Ship v2",
      status: "awaiting_approval",
      config: {},
      steps: steps.map((step, i) => ({
        ...step,
        status: "pending",
        order: i,
        dependencies: i === 0 ? [] : [steps[i - 1].id],
      })),
    } as unknown as AgentPlan
  }

  it("saves the open plan as a standalone workflow and links it from the plan", async () => {
    getOpenPlanForSession.mockResolvedValue(
      openPlan([
        {
          id: "a",
          title: "one",
          kind: "agent_turn",
          params: { kind: "agent_turn", prompt: "Do one" },
        },
        { id: "b", title: "two", kind: "agent_turn" },
      ])
    )
    createWorkflowMock.mockResolvedValue({ id: "wf_new", name: "Ship v2" })

    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))

    expect(createWorkflowMock).toHaveBeenCalledTimes(1)
    const draft = createWorkflowMock.mock.calls[0][0]
    expect(draft.name).toBe("Ship v2")
    expect(draft.nodes.map((n: { type: string }) => n.type)).toEqual([
      "trigger.manual",
      "action.agent.turn",
      "action.agent.turn",
    ])
    // Standalone: the steps' content is in the nodes, nothing names the plan.
    expect(draft.nodes[1].data.params.prompt).toBe("Do one")
    expect(JSON.stringify(draft.nodes.slice(1))).not.toContain("planId")
    expect(recordWorkflowExport).toHaveBeenCalledWith("p1", "wf_new")
    expect(res.system).toContain('Saved "Ship v2" as a workflow (2 steps and a manual trigger)')
    expect(res.system).toContain("`/plan from-workflow wf_new`")
    expect(mockMissing).toEqual([])
  })

  it("names the tool's plugin on an exported tool call", async () => {
    jest
      .mocked(resolvePluginToolByName)
      .mockImplementation(async (name) =>
        name === "search_docs" ? { pluginId: "docs" } : undefined
      )
    getOpenPlanForSession.mockResolvedValue(
      openPlan([
        {
          id: "a",
          title: "search",
          kind: "tool_call",
          params: { kind: "tool_call", toolName: "search_docs", input: { q: "v2" } },
        },
      ])
    )
    createWorkflowMock.mockResolvedValue({ id: "wf_new" })

    await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))

    const toolNode = createWorkflowMock.mock.calls[0][0].nodes[1]
    expect(toolNode.type).toBe("action.plugin.invoke")
    expect(toolNode.data.params).toEqual({
      pluginId: "docs",
      mode: "tool",
      toolName: "search_docs",
      args: { q: "v2" },
    })
  })

  it("refuses a tool call no installed plugin registers, naming the step and tool", async () => {
    getOpenPlanForSession.mockResolvedValue(
      openPlan([
        {
          id: "a",
          title: "search",
          kind: "tool_call",
          params: { kind: "tool_call", toolName: "search_docs", input: {} },
        },
      ])
    )
    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))
    expect(createWorkflowMock).not.toHaveBeenCalled()
    expect(recordWorkflowExport).not.toHaveBeenCalled()
    expect(res.system).toContain('Step "search" calls tool "search_docs"')
    expect(mockMissing).toEqual([])
  })

  it.each([
    ["en" as const, 'Step "ask the reviewer" dispatches a teammate'],
    ["zh-CN" as const, "步骤「ask the reviewer」会派发给队友"],
  ])("refuses a teammate step in %s without writing anything", async (locale, expected) => {
    mockLocale = locale
    getOpenPlanForSession.mockResolvedValue(
      openPlan([
        { id: "a", title: "draft", kind: "agent_turn" },
        {
          id: "b",
          title: "ask the reviewer",
          kind: "teammate_dispatch",
          params: { kind: "teammate_dispatch", teammateId: "tm_1" },
        },
      ])
    )
    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))
    expect(createWorkflowMock).not.toHaveBeenCalled()
    expect(recordWorkflowExport).not.toHaveBeenCalled()
    expect(res.system).toContain(expected)
    expect(mockMissing).toEqual([])
  })

  it("refuses to export when there is no open plan", async () => {
    getOpenPlanForSession.mockResolvedValue(undefined)
    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))
    expect(createWorkflowMock).not.toHaveBeenCalled()
    expect(res.system).toContain("No open plan to export")
    expect(mockMissing).toEqual([])
  })

  it("says so in Chinese when the plan has nothing to export", async () => {
    mockLocale = "zh-CN"
    getOpenPlanForSession.mockResolvedValue(openPlan([]))
    const res = await dispatchPlanSubcommand(ctx({ args: "to-workflow" }))
    expect(createWorkflowMock).not.toHaveBeenCalled()
    expect(res.system).toBe("计划「Ship v2」没有可导出的步骤。")
  })

  it("wraps a workflow found by id in an approval-gated plan", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf_1", name: "Nightly report" })
    await dispatchPlanSubcommand(ctx({ args: "from-workflow wf_1" }))
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.steps.map((s) => s.kind)).toEqual(["approval_gate", "sub_workflow"])
    expect(input.metadata).toEqual({ workflowId: "wf_1" })
  })

  // WF-12: with approval off, creation pins the sub-workflow step at once; an
  // unpublished workflow refuses the plan by step, in the UI's language.
  it.each([
    ["en" as const, 'Step "Nightly report" runs a workflow that is not published.'],
    ["zh-CN" as const, "步骤「Nightly report」运行的工作流尚未发布。"],
  ])(
    "names the unpublished step when an auto-approved wrap is refused (%s)",
    async (locale, expected) => {
      mockLocale = locale
      const { PlanApprovalBlockedError } = jest.requireActual(
        "@/lib/agent/plan/sub-workflow-binding"
      ) as typeof import("@/lib/agent/plan/sub-workflow-binding")
      getWorkflowMock.mockResolvedValue({ id: "wf_1", name: "Nightly report" })
      createPlan.mockRejectedValue(
        new PlanApprovalBlockedError("not-published", "st1", "Nightly report", "wf_1", "")
      )
      const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow wf_1" }))
      expect(res.system).toContain(expected)
      expect(mockMissing).toEqual([])
    }
  )

  it("does not swallow other creation failures", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf_1", name: "Nightly report" })
    createPlan.mockRejectedValue(new Error("dexie down"))
    await expect(dispatchPlanSubcommand(ctx({ args: "from-workflow wf_1" }))).rejects.toThrow(
      "dexie down"
    )
  })

  it("falls back to a name search and reports an ambiguous match", async () => {
    getWorkflowMock.mockResolvedValue(undefined)
    listWorkflowsMock.mockResolvedValue([
      { id: "wf_1", name: "Nightly report" },
      { id: "wf_2", name: "Nightly digest" },
    ])
    const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow nightly" }))
    expect(createPlan).not.toHaveBeenCalled()
    expect(res.system).toContain("matches 2 workflows")
  })

  it("reports a miss instead of creating an empty plan", async () => {
    getWorkflowMock.mockResolvedValue(undefined)
    listWorkflowsMock.mockResolvedValue([])
    const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow nope" }))
    expect(createPlan).not.toHaveBeenCalled()
    expect(res.system).toContain("No workflow matches")
  })

  it("explains the usage when no workflow is named", async () => {
    const res = await dispatchPlanSubcommand(ctx({ args: "from-workflow" }))
    expect(res.system).toContain("Usage:")
  })
})

describe("/plan history cards", () => {
  const historical = (
    id: string,
    createdAt: number,
    status: AgentPlan["status"] = "completed"
  ) => ({
    ...planFrom({ sessionId: "ses_a", title: id, source: "manual", steps: [] }),
    id,
    title: `Plan ${id}`,
    createdAt,
    status,
    completedSteps: 1,
    totalSteps: 2,
  })

  it("lists session plans newest first and marks the open one without calling the planner", async () => {
    const older = historical("old", 1)
    const open = historical("open", 2, "paused")
    listPlansBySession.mockResolvedValue([older, open])
    getOpenPlanForSession.mockResolvedValue(open)
    const { system } = await dispatchPlanSubcommand(ctx({ args: "list" }))
    expect(listPlansBySession).toHaveBeenCalledWith("ses_a")
    expect(system.indexOf("Plan open")).toBeLessThan(system.indexOf("Plan old"))
    expect(system).toContain("paused")
    expect(system).toContain("1/2")
    expect(system).toContain("(open)")
    expect(decomposeIntoPlanMock).not.toHaveBeenCalled()
  })

  it.each(["list", "show"])("reports an empty history for %s", async (args) => {
    expect((await dispatchPlanSubcommand(ctx({ args }))).system).toMatch(/no plans yet/i)
    expect(decomposeIntoPlanMock).not.toHaveBeenCalled()
  })

  it("shows the open plan by default, ordered step glyphs and recent events", async () => {
    const open = historical("open", 2, "paused")
    open.steps = [
      {
        id: "b",
        title: "Second",
        kind: "agent_turn",
        status: "blocked",
        order: 1,
        dependencies: ["a"],
      },
      { id: "a", title: "First", kind: "agent_turn", status: "failed", order: 0, dependencies: [] },
    ]
    getOpenPlanForSession.mockResolvedValue(open)
    jest.mocked(listPlanEvents).mockResolvedValue([
      {
        id: "e2",
        planId: "open",
        ts: 2000,
        kind: "paused",
        payload: { kind: "paused" },
      },
      {
        id: "e1",
        planId: "open",
        ts: 1000,
        kind: "step_failed",
        payload: { kind: "step_failed", stepId: "a", title: "First", error: "boom", attempt: 1 },
      },
    ])
    const { system } = await dispatchPlanSubcommand(ctx({ args: "show" }))
    expect(system).toContain("Plan open")
    expect(system).toContain("PAUSED")
    expect(system).toContain("- [!] First")
    expect(system.indexOf("First")).toBeLessThan(system.indexOf("Second"))
    expect(system.indexOf("paused")).toBeLessThan(system.indexOf("step failed"))
    // A readable line per event, never the raw payload.
    expect(system).toContain("step failed · First — boom")
    expect(system).not.toContain("{")
    expect(listPlanEvents).toHaveBeenCalledWith("open", 5)
    expect(listPlansBySession).not.toHaveBeenCalled()
  })

  it("defaults to the newest plan when none is open", async () => {
    listPlansBySession.mockResolvedValue([historical("old", 1), historical("new", 2)])
    expect((await dispatchPlanSubcommand(ctx({ args: "show" }))).system).toContain("Plan new")
  })

  it("shows a requested plan and rejects unknown or other-session ids", async () => {
    getPlan.mockResolvedValue(historical("old", 1))
    expect((await dispatchPlanSubcommand(ctx({ args: "show old" }))).system).toContain("Plan old")
    expect(getPlan).toHaveBeenCalledWith("old")
    getPlan.mockResolvedValue(undefined)
    expect((await dispatchPlanSubcommand(ctx({ args: "show missing" }))).system).toMatch(
      /not found/i
    )
    getPlan.mockResolvedValue({ ...historical("foreign", 3), sessionId: "ses_other" })
    expect((await dispatchPlanSubcommand(ctx({ args: "show foreign" }))).system).toMatch(
      /not found/i
    )
    expect(decomposeIntoPlanMock).not.toHaveBeenCalled()
  })
})
