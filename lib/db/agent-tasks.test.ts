import { createDbTestFixture } from "./test-fixture"
import {
  addAgentTaskComment,
  beginAgentTaskAttempt,
  createAgentTask,
  getAgentTask,
  linkAgentTaskAttemptExecution,
  listAgentTaskAttempts,
  listAgentTasks,
  listAgentTasksByProject,
  moveAgentTask,
  reconcileAgentTaskAttempts,
  reorderAgentTasks,
  settleAgentTaskAttempt,
} from "./agent-tasks"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("single-Agent task persistence", () => {
  it("creates and lists durable board cards per Agent", async () => {
    await createAgentTask({
      id: "task-1",
      agentId: "agent-a",
      title: "Research",
      description: "Find primary sources",
      priority: "high",
      approvalPolicy: "manual",
      now: 10,
    })
    await createAgentTask({
      id: "task-2",
      agentId: "agent-b",
      title: "Other",
      description: "Other",
      now: 11,
    })

    expect((await listAgentTasks("agent-a")).map((task) => task.id)).toEqual(["task-1"])
  })

  it("lists tasks by workspace, skipping rows that never carried a projectId", async () => {
    await createAgentTask({
      id: "w1-a",
      agentId: "a",
      projectId: "w1",
      title: "x",
      description: "",
    })
    await createAgentTask({
      id: "w1-b",
      agentId: "b",
      projectId: "w1",
      title: "y",
      description: "",
    })
    await createAgentTask({ id: "w2", agentId: "a", projectId: "w2", title: "z", description: "" })
    await createAgentTask({ id: "none", agentId: "a", title: "n", description: "" })
    expect((await listAgentTasksByProject("w1")).map((task) => task.id).sort()).toEqual([
      "w1-a",
      "w1-b",
    ])
    expect(await listAgentTasksByProject("w3")).toEqual([])
  })

  it("derives dependency blocking and refuses duplicate concurrent attempts", async () => {
    await createAgentTask({
      id: "dep",
      agentId: "agent-a",
      title: "Dependency",
      description: "",
      approvalPolicy: "auto",
    })
    await createAgentTask({
      id: "task",
      agentId: "agent-a",
      title: "Task",
      description: "",
      dependencies: ["dep"],
    })

    await expect(beginAgentTaskAttempt("task", { id: "attempt-1", now: 20 })).rejects.toThrow(
      /dependencies/
    )
    expect((await getAgentTask("task"))?.status).toBe("blocked")

    const depAttempt = await beginAgentTaskAttempt("dep", { id: "dep-attempt", now: 24 })
    await settleAgentTaskAttempt(depAttempt.id, { status: "completed", result: "done", now: 25 })

    const first = await beginAgentTaskAttempt("task", { id: "attempt-1", now: 26 })
    expect(first.attemptNo).toBe(1)
    await expect(beginAgentTaskAttempt("task", { id: "attempt-2", now: 27 })).rejects.toThrow(
      /already running/
    )
  })

  it("appends retry attempts and routes successful manual work through review", async () => {
    await createAgentTask({
      id: "task",
      agentId: "agent-a",
      title: "Task",
      description: "",
      approvalPolicy: "manual",
    })
    const first = await beginAgentTaskAttempt("task", { id: "attempt-1", now: 10 })
    await settleAgentTaskAttempt(first.id, {
      status: "failed",
      errorCode: "provider_error",
      errorMessage: "offline",
      now: 11,
    })
    await moveAgentTask("task", "pending", 12)
    const second = await beginAgentTaskAttempt("task", { id: "attempt-2", now: 13 })
    await settleAgentTaskAttempt(second.id, { status: "completed", result: "ok", now: 14 })

    expect((await listAgentTaskAttempts("task")).map((attempt) => attempt.status)).toEqual([
      "failed",
      "review",
    ])
    expect((await getAgentTask("task"))?.status).toBe("review")
  })

  it("links Scheduler execution ids and reconciles orphaned running attempts", async () => {
    await createAgentTask({ id: "task", agentId: "agent-a", title: "Task", description: "" })
    const attempt = await beginAgentTaskAttempt("task", { id: "attempt-1", now: 10 })
    await linkAgentTaskAttemptExecution(attempt.id, "execution-1", 11)

    await reconcileAgentTaskAttempts(
      async (executionId) => (executionId === "execution-1" ? null : null),
      20
    )

    expect((await listAgentTaskAttempts("task"))[0]).toEqual(
      expect.objectContaining({ status: "interrupted", errorCode: "execution_missing" })
    )
    expect((await getAgentTask("task"))?.status).toBe("failed")
  })

  it("persists bounded comments on the card", async () => {
    await createAgentTask({ id: "task", agentId: "agent-a", title: "Task", description: "" })
    await addAgentTaskComment("task", { id: "comment-1", author: "user", text: "Review this" }, 10)
    expect((await getAgentTask("task"))?.comments).toEqual([
      { id: "comment-1", author: "user", text: "Review this", createdAt: 10 },
    ])
  })

  it("writes a same-column reorder in one go and bumps each moved card's revision", async () => {
    for (const id of ["a", "b", "c"]) {
      await createAgentTask({ id, agentId: "agent-a", title: id, description: "", now: 1 })
    }
    await reorderAgentTasks(
      [
        { id: "c", order: 0 },
        { id: "a", order: 1 },
        { id: "b", order: 2 },
      ],
      50
    )
    const rows = await listAgentTasks("agent-a")
    expect(rows.map((row) => [row.id, row.order, row.revision, row.updatedAt])).toEqual(
      expect.arrayContaining([
        ["a", 1, 2, 50],
        ["b", 2, 2, 50],
        ["c", 0, 2, 50],
      ])
    )
  })

  it("refuses a reorder naming a missing task or spanning two Agents, writing nothing", async () => {
    await createAgentTask({ id: "a", agentId: "agent-a", title: "a", description: "", now: 1 })
    await createAgentTask({ id: "x", agentId: "agent-b", title: "x", description: "", now: 1 })
    await expect(
      reorderAgentTasks([
        { id: "a", order: 3 },
        { id: "missing", order: 4 },
      ])
    ).rejects.toThrow("Agent task not found")
    await expect(
      reorderAgentTasks([
        { id: "a", order: 3 },
        { id: "x", order: 4 },
      ])
    ).rejects.toThrow("within one Agent")
    expect((await getAgentTask("a"))?.order).toBe(0)
    expect((await getAgentTask("x"))?.order).toBe(0)
  })

  it("treats an empty reorder as a no-op", async () => {
    await expect(reorderAgentTasks([])).resolves.toBeUndefined()
  })
})

describe("cross-column Agent task placement", () => {
  it("writes the preview's insertion position in the status transaction", async () => {
    for (const [index, id] of ["first", "second", "target", "moving"].entries()) {
      await createAgentTask({
        id,
        agentId: "agent-a",
        title: id,
        description: "",
        order: index === 3 ? 0 : index,
        now: index + 1,
      })
    }
    await createAgentTask({
      id: "other-agent",
      agentId: "agent-b",
      title: "Other",
      description: "",
      order: 7,
      now: 5,
    })
    const other = await getAgentTask("other-agent")
    await beginAgentTaskAttempt("moving", { now: 10 })
    await moveAgentTask("moving", "paused", 11)
    await moveAgentTask("moving", "pending", 12, { targetIndex: 2 })
    const rows = await listAgentTasks("agent-a")
    expect(rows.sort((a, b) => a.order - b.order).map((row) => row.id)).toEqual([
      "first",
      "second",
      "moving",
      "target",
    ])
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2, 3])
    expect(await getAgentTask("other-agent")).toEqual(other)
  })
})

it("does not rewind an attempt that starts during Scheduler resume", async () => {
  await createAgentTask({ id: "race", agentId: "a", title: "race", description: "" })
  await beginAgentTaskAttempt("race", { id: "new-attempt" })
  const before = await getAgentTask("race")
  await expect(
    moveAgentTask("race", "pending", 100, { expectedStatus: "paused", targetIndex: 0 })
  ).resolves.toEqual(before)
  expect(await getAgentTask("race")).toEqual(before)
})

it("rejects a stale reorder spanning two status columns without partial writes", async () => {
  await createAgentTask({
    id: "pending",
    agentId: "a",
    title: "Pending",
    description: "",
    order: 3,
  })
  await createAgentTask({
    id: "running",
    agentId: "a",
    title: "Running",
    description: "",
    order: 4,
  })
  await beginAgentTaskAttempt("running")
  const before = await listAgentTasks("a")
  await expect(
    reorderAgentTasks([
      { id: "pending", order: 0 },
      { id: "running", order: 1 },
    ])
  ).rejects.toThrow("one column")
  expect(await listAgentTasks("a")).toEqual(before)
})
