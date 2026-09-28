/**
 * @jest-environment jsdom
 */
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  handleTeamRunStart,
  handleTeamTaskComment,
  handleTeamTaskCreate,
  handleTeamTaskMove,
} from "./agent-team-write-handlers"

jest.mock("@/lib/ai/agent/team/agent-team", () => ({
  agentTeamManager: {
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
  },
}))

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

const startSquadRun = jest.fn(
  async (): Promise<{ started: boolean; reason?: string; runId?: string }> => ({
    started: true,
    runId: "run_1",
  })
)
jest.mock("@/lib/ai/agent/team/squad/start-squad-run", () => ({
  startSquadRun: (...a: unknown[]) => startSquadRun(...(a as [])),
}))

const seed = () => {
  const state = useAgentTeamStore.getState()
  const team = state.createTeam({ name: "T", task: "t" })
  const mate = state.addTeammate({
    teamId: team.id,
    name: "Worker",
    description: "",
    role: "teammate",
  })
  const failed = state.createTask({ teamId: team.id, title: "F", description: "" })
  state.updateTask(failed.id, { status: "failed", error: "boom" })
  return { team, mate, failed }
}

beforeEach(() => {
  localStorage.clear()
  useAgentTeamStore.getState().reset()
  jest.clearAllMocks()
})

describe("handleTeamTaskMove", () => {
  it("rejects malformed payloads and unknown statuses/tasks", async () => {
    const { team } = seed()
    expect(await handleTeamTaskMove({})).toEqual({ ok: false, reason: "invalid-payload" })
    expect(await handleTeamTaskMove({ teamId: team.id, taskId: "t", to: "warp" })).toEqual({
      ok: false,
      reason: "invalid-status",
    })
    expect(await handleTeamTaskMove({ teamId: team.id, taskId: "nope", to: "pending" })).toEqual({
      ok: false,
      reason: "task-not-found",
    })
    // A task from another team is invisible through this team's id.
    const other = useAgentTeamStore.getState().createTeam({ name: "O", task: "" })
    const foreign = useAgentTeamStore
      .getState()
      .createTask({ teamId: other.id, title: "x", description: "" })
    expect(
      await handleTeamTaskMove({ teamId: team.id, taskId: foreign.id, to: "cancelled" })
    ).toEqual({ ok: false, reason: "task-not-found" })
  })

  it("applies guarded moves and surfaces guard denials", async () => {
    const { team, failed } = seed()
    expect(await handleTeamTaskMove({ teamId: team.id, taskId: failed.id, to: "pending" })).toEqual(
      { ok: true }
    )
    expect(useAgentTeamStore.getState().tasks[failed.id].status).toBe("pending")
    expect(
      await handleTeamTaskMove({ teamId: team.id, taskId: failed.id, to: "completed" })
    ).toEqual({ ok: false, reason: "illegal-transition" })
  })
})

describe("handleTeamTaskCreate", () => {
  it("creates a task with validated priority/assignee/tags", async () => {
    const { team, mate } = seed()
    const result = await handleTeamTaskCreate({
      teamId: team.id,
      title: "From phone",
      priority: "high",
      assignedTo: mate.id,
      tags: ["mobile", 42],
    })
    expect(result.ok).toBe(true)
    const task = useAgentTeamStore.getState().tasks[result.taskId!]
    expect(task).toMatchObject({
      title: "From phone",
      priority: "high",
      assignedTo: mate.id,
      tags: ["mobile"],
    })
  })

  it("defaults tags to [] when the payload omits or malforms them", async () => {
    const { team } = seed()
    const result = await handleTeamTaskCreate({ teamId: team.id, title: "no tags" })
    expect(useAgentTeamStore.getState().tasks[result.taskId!].tags).toEqual([])
    const result2 = await handleTeamTaskCreate({ teamId: team.id, title: "bad tags", tags: "x" })
    expect(useAgentTeamStore.getState().tasks[result2.taskId!].tags).toEqual([])
  })

  it("rejects unknown teams, bad priorities, and off-team assignees", async () => {
    const { team } = seed()
    expect(await handleTeamTaskCreate({ teamId: "ghost", title: "x" })).toEqual({
      ok: false,
      reason: "team-not-found",
    })
    expect(await handleTeamTaskCreate({ teamId: team.id, title: "x", priority: "asap" })).toEqual({
      ok: false,
      reason: "invalid-priority",
    })
    expect(
      await handleTeamTaskCreate({ teamId: team.id, title: "x", assignedTo: "stranger" })
    ).toEqual({ ok: false, reason: "assignee-not-on-team" })
  })
})

describe("handleTeamTaskComment", () => {
  it("appends an operator comment and returns its id", async () => {
    const { team, failed } = seed()
    const result = await handleTeamTaskComment({
      teamId: team.id,
      taskId: failed.id,
      text: "Look at this",
    })
    expect(result.ok).toBe(true)
    const comments = useAgentTeamStore.getState().tasks[failed.id].comments ?? []
    expect(comments.map((c) => c.id)).toContain(result.commentId)
    expect(comments[0]).toMatchObject({ authorId: "user", text: "Look at this" })
  })

  it("rejects unknown tasks", async () => {
    const { team } = seed()
    expect(await handleTeamTaskComment({ teamId: team.id, taskId: "zz", text: "x" })).toEqual({
      ok: false,
      reason: "task-not-found",
    })
  })
})

describe("handleTeamRunStart", () => {
  /**
   * A phone could pause, resume and stop a Squad and never start one, which is
   * a remote control with a brake and no accelerator.
   */
  it("starts through the one launch seam, not the manager", async () => {
    const { team } = seed()
    startSquadRun.mockResolvedValueOnce({ started: true, runId: "run_1" })
    const result = await handleTeamRunStart({ teamId: team.id, goal: "ship it" })
    expect(result).toEqual({ ok: true, runId: "run_1" })
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({ squadId: team.id, goal: "ship it", origin: "companion" })
    )
  })

  /**
   * Rust stamps the verified device id after schema validation, so the arm
   * forwards whatever arrived rather than trusting a client-supplied field.
   */
  it("carries the host-stamped device id onto the run", async () => {
    const { team } = seed()
    await handleTeamRunStart({ teamId: team.id, callerDeviceId: "dev_9" })
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredFrom: { source: "api", deviceId: "dev_9" },
      })
    )
  })

  it("leaves the device id off when none was stamped", async () => {
    const { team } = seed()
    await handleTeamRunStart({ teamId: team.id })
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "", triggeredFrom: { source: "api" } })
    )
  })

  /**
   * The seam owns the one-live-run rule. Its refusal carries the open run, so
   * a phone can follow that run instead of forking a duplicate.
   */
  it("hands back the open run when the Squad is already running", async () => {
    const { team } = seed()
    startSquadRun.mockResolvedValueOnce({
      started: false,
      reason: "already_running",
      runId: "run_open",
    })
    expect(await handleTeamRunStart({ teamId: team.id })).toEqual({
      ok: false,
      reason: "already_running",
      runId: "run_open",
    })
  })

  it("validates the payload and the Squad before dispatching", async () => {
    expect(await handleTeamRunStart({})).toEqual({ ok: false, reason: "invalid-payload" })
    expect(await handleTeamRunStart({ teamId: "ghost" })).toEqual({
      ok: false,
      reason: "team-not-found",
    })
    expect(startSquadRun).not.toHaveBeenCalled()
  })

  /** A denial is a normal result, never a thrown error the caller must catch. */
  it("reports a readiness refusal without throwing", async () => {
    const { team } = seed()
    startSquadRun.mockResolvedValueOnce({ started: false, reason: "not_ready" })
    expect(await handleTeamRunStart({ teamId: team.id })).toEqual({
      ok: false,
      reason: "not_ready",
    })
  })

  it("survives the seam throwing", async () => {
    const { team } = seed()
    startSquadRun.mockRejectedValueOnce(new Error("boom"))
    expect(await handleTeamRunStart({ teamId: team.id })).toEqual({
      ok: false,
      reason: "dispatch_error",
    })
  })
})
