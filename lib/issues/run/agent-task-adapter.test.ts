/**
 * @jest-environment jsdom
 */

import type { AgentTask, AgentTaskAttempt } from "@/types/agent/agent-task"
import type { Issue, IssueProject, IssueRun } from "@/types/issues"
import {
  AGENT_TASK_RUN_ADAPTER_ID,
  agentTaskArtifacts,
  buildAgentTaskDescription,
  createAgentTaskRunAdapter,
  sessionHref,
  type AgentTaskRunAdapterDeps,
} from "./agent-task-adapter"
import type { IssueRunTarget } from "./types"

const HUMAN = { kind: "human" } as const

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "iss-1",
    identifier: "MERC-1",
    number: 1,
    projectId: "w1",
    issueProjectId: "ip-1",
    title: "Fix the thing",
    description: "It is broken",
    status: "todo",
    statusCategory: "unstarted",
    priority: "high",
    assignee: { kind: "agent", id: "char-1", label: "Ada" },
    assigneeKind: "agent",
    assigneeId: "char-1",
    createdBy: HUMAN,
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function project(over: Partial<IssueProject> = {}): IssueProject {
  return {
    id: "ip-1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    description: "The Mercury project",
    status: "in_progress",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function target(over: Partial<IssueRunTarget> = {}): IssueRunTarget {
  return { issue: issue(), project: project(), ...over }
}

function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "agent-task:abc",
    agentId: "char-1",
    title: "MERC-1: Fix the thing",
    description: "…",
    status: "pending",
    priority: "high",
    dependencies: [],
    tags: [],
    order: 0,
    approvalPolicy: "on-risk",
    latestAttemptNo: 0,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...over,
  }
}

function attempt(over: Partial<AgentTaskAttempt> = {}): AgentTaskAttempt {
  return {
    id: "att-1",
    taskId: "agent-task:abc",
    agentId: "char-1",
    attemptNo: 1,
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "run-1",
    issueId: "iss-1",
    projectId: "w1",
    adapterId: AGENT_TASK_RUN_ADAPTER_ID,
    kind: "agent-task",
    targetId: "agent-task:abc",
    status: "running",
    by: HUMAN,
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  }
}

function makeDeps(over: Partial<AgentTaskRunAdapterDeps> = {}) {
  const created: Parameters<AgentTaskRunAdapterDeps["createTask"]>[0][] = []
  const started: string[] = []
  const cancelled: string[] = []
  const deps: AgentTaskRunAdapterDeps = {
    resolveCharacter: async (id) => (id === "char-1" ? { id, name: "Ada" } : undefined),
    createTask: async (input) => {
      created.push(input)
      return task({ id: "agent-task:new", agentId: input.agentId, title: input.title })
    },
    startTaskNow: async (id) => {
      started.push(id)
      return { status: "running" }
    },
    cancelTask: async (id) => {
      cancelled.push(id)
    },
    getTask: async () => undefined,
    listAttempts: async () => [],
    now: () => 42,
    ...over,
  }
  return { deps, created, started, cancelled }
}

const CTX = { runId: "run-claim", by: HUMAN } as const

describe("helpers", () => {
  it("builds the task prompt from identifier, project context and description", () => {
    expect(buildAgentTaskDescription(target())).toBe(
      "Issue MERC-1: Fix the thing\n\nProject context: The Mercury project\n\nIt is broken"
    )
    expect(
      buildAgentTaskDescription(
        target({ issue: issue({ description: undefined }), project: undefined })
      )
    ).toBe("Issue MERC-1: Fix the thing")
  })

  it("builds artifacts from attempts with sessions", () => {
    expect(sessionHref("s 1")).toBe("/?session=s%201")
    expect(agentTaskArtifacts([attempt(), attempt({ attemptNo: 2, sessionId: "s2" })])).toEqual([
      { label: "Session (attempt 2)", href: "/?session=s2" },
    ])
  })
})

describe("canRun", () => {
  it("accepts an agent assignee that resolves to a Character", async () => {
    const adapter = createAgentTaskRunAdapter(makeDeps().deps)
    expect(await adapter.canRun(target())).toEqual({ ok: true })
  })

  it("refuses missing / wrong-kind / id-less / unresolvable assignees", async () => {
    const adapter = createAgentTaskRunAdapter(makeDeps().deps)
    expect(await adapter.canRun(target({ issue: issue({ assignee: undefined }) }))).toEqual({
      ok: false,
      reason: "assignee-kind-mismatch",
    })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "team", id: "t" } }) }))
    ).toMatchObject({ ok: false, reason: "assignee-kind-mismatch" })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "agent" } }) }))
    ).toMatchObject({ ok: false, reason: "assignee-kind-mismatch" })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "agent", id: "ghost" } }) }))
    ).toEqual({ ok: false, reason: "assignee-not-found", detail: "ghost" })
  })
})

describe("start", () => {
  it("creates the AgentTask, starts it, and hands back the accepted dispatch", async () => {
    const { deps, created, started } = makeDeps()
    const adapter = createAgentTaskRunAdapter(deps)
    const dispatch = await adapter.start(target(), { ...CTX, origin: "interactive" })
    expect(created[0]).toMatchObject({
      agentId: "char-1",
      projectId: "w1",
      title: "MERC-1: Fix the thing",
      priority: "high",
      tags: ["issue", "issue:iss-1", "MERC-1"],
      now: 42,
    })
    expect(started).toEqual(["agent-task:new"])
    expect(dispatch).toEqual({ targetId: "agent-task:new", status: "running" })
  })

  it("reports queued when the Scheduler buffered the start", async () => {
    const { deps } = makeDeps({ startTaskNow: async () => ({ status: "queued" }) })
    expect(
      await createAgentTaskRunAdapter(deps).start(target(), { ...CTX, origin: "interactive" })
    ).toEqual({ targetId: "agent-task:new", status: "queued" })
  })

  it("does not wait for the task to finish", async () => {
    let finish: () => void = () => {}
    const { deps } = makeDeps({
      // Accepted immediately; the work itself would take as long as it takes.
      startTaskNow: async () => {
        void new Promise<void>((resolve) => {
          finish = resolve
        })
        return { status: "running" }
      },
    })
    await expect(
      createAgentTaskRunAdapter(deps).start(target(), { ...CTX, origin: "interactive" })
    ).resolves.toMatchObject({ status: "running" })
    finish()
  })

  it("appends a wakeup brief to the task", async () => {
    const { deps, created } = makeDeps()
    const wakeup = { taskId: "wk", chain: ["wk"], statusBefore: "todo" as const, periodic: true }
    await createAgentTaskRunAdapter(deps).start(target(), {
      ...CTX,
      origin: "wakeup",
      brief: "[WAKEUP wk] MERC-1",
      wakeup,
    })
    expect(created[0]!.description.endsWith("\n\n[WAKEUP wk] MERC-1")).toBe(true)
  })

  it("throws when the target is not runnable, and cancels the task the Scheduler refused", async () => {
    const { deps, cancelled } = makeDeps({
      startTaskNow: async () => {
        throw new Error("scheduler down")
      },
    })
    const adapter = createAgentTaskRunAdapter(deps)
    await expect(
      adapter.start(target({ issue: issue({ assignee: undefined }) }), { ...CTX, origin: "im" })
    ).rejects.toThrow(/refused: assignee-kind-mismatch/)
    await expect(adapter.start(target(), { ...CTX, origin: "im" })).rejects.toThrow(
      "scheduler down"
    )
    expect(cancelled).toEqual(["agent-task:new"])
  })

  it("still throws the Scheduler's refusal when cancelling the task also fails", async () => {
    const { deps } = makeDeps({
      startTaskNow: async () => {
        throw new Error("scheduler down")
      },
      cancelTask: async () => {
        throw new Error("cancel failed")
      },
    })
    await expect(
      createAgentTaskRunAdapter(deps).start(target(), { ...CTX, origin: "im" })
    ).rejects.toThrow("scheduler down")
  })
})

describe("poll", () => {
  it("returns null while the task is not terminal", async () => {
    for (const status of ["pending", "blocked", "in_progress", "paused"] as const) {
      const { deps } = makeDeps({ getTask: async () => task({ status }) })
      expect(await createAgentTaskRunAdapter(deps).poll(run())).toBeNull()
    }
  })

  it("reports running once a queued run's task is in progress", async () => {
    const { deps } = makeDeps({ getTask: async () => task({ status: "in_progress" }) })
    expect(await createAgentTaskRunAdapter(deps).poll(run({ status: "queued" }))).toEqual({
      status: "running",
    })
    const pending = makeDeps({ getTask: async () => task({ status: "pending" }) })
    expect(await createAgentTaskRunAdapter(pending.deps).poll(run({ status: "queued" }))).toBeNull()
  })

  it("settles from the task's terminal status with attempts as evidence", async () => {
    const attempts = [attempt({ sessionId: "s1", result: "did the thing" })]
    const completed = createAgentTaskRunAdapter(
      makeDeps({
        getTask: async () => task({ status: "completed" }),
        listAttempts: async () => attempts,
      }).deps
    )
    expect(await completed.poll(run())).toEqual({
      status: "succeeded",
      summary: "did the thing",
      artifacts: [{ label: "Session (attempt 1)", href: "/?session=s1" }],
    })

    const review = createAgentTaskRunAdapter(
      makeDeps({ getTask: async () => task({ status: "review" }), listAttempts: async () => [] })
        .deps
    )
    expect(await review.poll(run())).toEqual({ status: "succeeded", artifacts: [] })

    const failed = createAgentTaskRunAdapter(
      makeDeps({
        getTask: async () => task({ status: "failed" }),
        listAttempts: async () => [attempt({ status: "failed", errorCode: "E1" })],
      }).deps
    )
    expect(await failed.poll(run())).toEqual({ status: "failed", error: "E1", artifacts: [] })

    const failedNoAttempt = createAgentTaskRunAdapter(
      makeDeps({ getTask: async () => task({ status: "failed" }) }).deps
    )
    expect(await failedNoAttempt.poll(run())).toMatchObject({ error: "agent task failed" })

    const cancelled = createAgentTaskRunAdapter(
      makeDeps({ getTask: async () => task({ status: "cancelled" }) }).deps
    )
    expect(await cancelled.poll(run())).toEqual({ status: "cancelled" })

    const gone = createAgentTaskRunAdapter(makeDeps().deps)
    expect(await gone.poll(run())).toEqual({
      status: "failed",
      error: "agent task no longer exists",
    })
  })
})

describe("cancel", () => {
  it("cancels the AgentTask", async () => {
    const { deps, cancelled } = makeDeps()
    await createAgentTaskRunAdapter(deps).cancel!(run())
    expect(cancelled).toEqual(["agent-task:abc"])
  })
})

describe("sessionIds", () => {
  it("names the sessions of live attempts only, newest attempt first", async () => {
    const attempt = (
      attemptNo: number,
      status: AgentTaskAttempt["status"],
      sessionId?: string
    ): AgentTaskAttempt => ({
      id: `a${attemptNo}`,
      taskId: "agent-task:abc",
      agentId: "char-1",
      attemptNo,
      status,
      ...(sessionId ? { sessionId } : {}),
      createdAt: 0,
      updatedAt: 0,
    })
    const adapter = createAgentTaskRunAdapter(
      makeDeps({
        listAttempts: async () => [
          attempt(1, "failed", "s1"),
          attempt(2, "running", "s2"),
          attempt(3, "queued", "s3"),
          attempt(4, "running"),
        ],
      }).deps
    )
    expect(await adapter.sessionIds!(run())).toEqual(["s3", "s2"])
  })
})
