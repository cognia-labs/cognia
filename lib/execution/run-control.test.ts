/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import type { ExecutionRun, RunControlCommand } from "@/types/execution/run"
import {
  createRunInterrupt,
  executeRunControlCommand,
  recoverPendingRunInterrupts,
  registerRunControlHandler,
  RUNTIME_STOP_ACTOR,
  stopRunTree,
} from "./run-control"
import { __resetRunRetryHandlersForTesting, registerRunRetryHandler } from "./run-retry-registry"
import { registerRunStop } from "./run-stops"

describe("execution run controls", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  async function seed(): Promise<void> {
    await createExecutionRun({
      id: "run-1",
      kind: "agent-turn",
      sourceId: "turn-1",
      title: "Agent",
      status: "running",
      initiator: { remoteUserId: "owner" },
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
  }

  it("journals a declared safe bare tool identity for approval correlation", async () => {
    await seed()
    await createRunInterrupt({
      id: "tool-interrupt:run-1:request-1",
      runId: "run-1",
      type: "tool_approval",
      title: "Allow",
      toolName: "mcp__issues__issue_list",
      status: "pending",
      createdAt: 2,
      expiresAt: 1000,
    })
    const events = await getDb().executionRunEvents.where("runId").equals("run-1").toArray()
    expect(events[0].payload).toMatchObject({ toolName: "issue_list", safeToolName: true })
    expect((await getDb().executionRuns.get("run-1"))?.latestSnapshot?.activities).toEqual([
      expect.objectContaining({
        toolName: "issue_list",
        approval: { requestId: "request-1", status: "pending" },
      }),
    ])
  })

  it("does not publish a settled interrupt before its resolution event commits", async () => {
    await seed()
    await createRunInterrupt({
      id: "approval-atomic",
      runId: "run-1",
      type: "tool_approval",
      title: "Allow",
      status: "pending",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    })
    const unregister = registerRunControlHandler("agent-turn", async () => undefined)
    const db = getDb()
    const before = await db.executionRuns.get("run-1")
    const beforeOutbox = await db.notificationProjectionWork.toArray()
    const failResolution = (_key: unknown, event: { type: string }) => {
      if (event.type === "interrupt.resolved") throw new Error("journal unavailable")
    }
    db.executionRunEvents.hook("creating", failResolution)
    try {
      await expect(
        executeRunControlCommand({
          runId: "run-1",
          action: "approve",
          interruptId: "approval-atomic",
          expectedRevision: 1,
          idempotencyKey: "atomic-approval",
          actor: { remoteUserId: "owner" },
        })
      ).rejects.toThrow("journal unavailable")
      expect(await getDb().executionRunInterrupts.get("approval-atomic")).toMatchObject({
        status: "pending",
      })
      expect(await db.executionRuns.get("run-1")).toEqual(before)
      expect(await db.executionRunEvents.where("runId").equals("run-1").count()).toBe(1)
      expect(await db.notificationProjectionWork.toArray()).toEqual(beforeOutbox)
    } finally {
      db.executionRunEvents.hook("creating").unsubscribe(failResolution)
      unregister()
    }
  })

  it.each(["approve", "deny"] as const)(
    "commits %s with its projection and notification outbox",
    async (action) => {
      await seed()
      await createRunInterrupt({
        id: "approval-success",
        runId: "run-1",
        type: "tool_approval",
        title: "Allow",
        status: "pending",
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      })
      const unregister = registerRunControlHandler("agent-turn", async () => undefined)
      const append = jest.spyOn(runEventJournal, "append")
      try {
        await expect(
          executeRunControlCommand({
            runId: "run-1",
            action,
            interruptId: "approval-success",
            expectedRevision: 1,
            idempotencyKey: `success-${action}`,
            actor: { remoteUserId: "owner" },
          })
        ).resolves.toMatchObject({ accepted: true, currentRevision: 3 })
        const db = getDb()
        expect(await db.executionRunInterrupts.get("approval-success")).toMatchObject({
          status: action === "approve" ? "approved" : "denied",
        })
        expect(
          (await db.executionRuns.get("run-1"))?.latestSnapshot?.pendingInterrupt
        ).toBeUndefined()
        expect(await db.executionRunEvents.where("runId").equals("run-1").sortBy("seq")).toEqual([
          expect.objectContaining({ type: "interrupt.requested", seq: 1 }),
          expect.objectContaining({ type: "interrupt.resolved", seq: 2 }),
          expect.objectContaining({ type: "control.accepted", seq: 3 }),
        ])
        expect(await db.notificationProjectionWork.toArray()).toEqual([
          expect.objectContaining({ runId: "run-1", desiredRunSeq: 3 }),
        ])
        // Only the independent acknowledgement uses the retrying journal. The
        // resolution must remain on the interrupt's bound transaction.
        expect(append).toHaveBeenCalledTimes(1)
        expect(append).toHaveBeenCalledWith(
          "run-1",
          expect.objectContaining({ type: "control.accepted" })
        )
      } finally {
        append.mockRestore()
        unregister()
      }
    }
  )

  it("allows only the initiator or configured operators", async () => {
    await seed()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const denied = await executeRunControlCommand(
      {
        runId: "run-1",
        action: "stop",
        idempotencyKey: "cmd-denied",
        expectedRevision: 1,
        actor: { remoteUserId: "stranger" },
      },
      { operatorIds: ["operator"] }
    )
    const accepted = await executeRunControlCommand(
      {
        runId: "run-1",
        action: "stop",
        idempotencyKey: "cmd-operator",
        expectedRevision: 1,
        actor: { remoteUserId: "operator" },
      },
      { operatorIds: ["operator"] }
    )

    expect(denied).toMatchObject({ accepted: false, reason: "forbidden" })
    expect(accepted.accepted).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  it("deduplicates callbacks and rejects stale optimistic revisions", async () => {
    await seed()
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)
    const command = {
      runId: "run-1",
      action: "pause" as const,
      idempotencyKey: "same-callback",
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    }

    const first = await executeRunControlCommand(command)
    const duplicate = await executeRunControlCommand(command)
    const stale = await executeRunControlCommand({
      ...command,
      idempotencyKey: "stale",
      expectedRevision: 0,
    })

    expect(first.accepted).toBe(true)
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true })
    expect(stale).toMatchObject({ accepted: false, reason: "revision_conflict" })
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  it("serializes concurrent controls so only one matching revision reaches the source", async () => {
    await seed()
    const handler = jest.fn(async () => Promise.resolve())
    const unregister = registerRunControlHandler("agent-turn", handler)
    const command = (idempotencyKey: string) => ({
      runId: "run-1",
      action: "stop" as const,
      idempotencyKey,
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    })

    const results = await Promise.all([
      executeRunControlCommand(command("concurrent-1")),
      executeRunControlCommand(command("concurrent-2")),
    ])

    expect(results.filter((result) => result.accepted)).toHaveLength(1)
    expect(results).toContainEqual(expect.objectContaining({ reason: "revision_conflict" }))
    expect(handler).toHaveBeenCalledTimes(1)
    unregister()
  })

  it("rejects controls for terminal runs without mutating the immutable journal", async () => {
    await createExecutionRun({
      id: "terminal-run",
      kind: "agent-turn",
      sourceId: "turn-terminal",
      title: "Done",
      status: "completed",
      initiator: { remoteUserId: "owner" },
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
    })
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand({
      runId: "terminal-run",
      action: "stop",
      idempotencyKey: "terminal-control",
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    })

    expect(result).toEqual({
      accepted: false,
      reason: "source_rejected",
      currentRevision: 0,
    })
    expect(handler).not.toHaveBeenCalled()
    expect(await getDb().executionRunEvents.where("runId").equals("terminal-run").count()).toBe(0)
    unregister()
  })

  it("expires approvals without executing a source handler", async () => {
    await seed()
    await createRunInterrupt({
      id: "interrupt-1",
      runId: "run-1",
      type: "tool_approval",
      status: "pending",
      title: "Run shell command",
      expiresAt: 10,
      createdAt: 1,
    })
    const handler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", handler)

    const result = await executeRunControlCommand(
      {
        runId: "run-1",
        action: "approve",
        idempotencyKey: "approval",
        expectedRevision: 1,
        actor: { remoteUserId: "owner" },
        interruptId: "interrupt-1",
      },
      { now: 11 }
    )

    expect(result).toMatchObject({ accepted: false, reason: "interrupt_expired" })
    expect(handler).not.toHaveBeenCalled()
    expect(await getDb().executionRunInterrupts.get("interrupt-1")).toMatchObject({
      status: "expired",
    })
    unregister()
  })

  it("marks a non-expired agent approval as recovery-required after restart", async () => {
    await seed()
    await createRunInterrupt({
      id: "interrupt-restart",
      runId: "run-1",
      type: "tool_approval",
      status: "pending",
      title: "Run shell command",
      expiresAt: 100,
      createdAt: 1,
    })

    await recoverPendingRunInterrupts(50)

    expect(await getDb().executionRuns.get("run-1")).toMatchObject({
      status: "recovery_required",
    })
  })
})

describe("tree stop (ADR-0252 §3)", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  function row(id: string, patch: Partial<ExecutionRun> = {}): ExecutionRun {
    return {
      id,
      kind: "job",
      sourceId: id,
      title: id,
      status: "running",
      initiator: { remoteUserId: "owner" },
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
      ...patch,
    }
  }

  /** root(team) → a(job) → a1(job); root → b(job, settled); root → c(workflow). */
  async function seedTree(rootPatch: Partial<ExecutionRun> = {}): Promise<void> {
    await createExecutionRun(row("root", { kind: "team", ...rootPatch }))
    await createExecutionRun(row("a", { parentRunId: "root", startedAt: 2 }))
    await createExecutionRun(row("a1", { parentRunId: "a", startedAt: 3 }))
    await createExecutionRun(row("b", { parentRunId: "root", status: "completed", startedAt: 4 }))
    await createExecutionRun(row("c", { kind: "workflow", parentRunId: "root", startedAt: 5 }))
  }

  function record() {
    const stopped: string[] = []
    const handler = (fail?: string) =>
      jest.fn(async (command: RunControlCommand) => {
        stopped.push(command.runId)
        if (command.runId === fail) throw new Error("wedged")
      })
    return { stopped, handler }
  }

  it("stops the root through its kind, then every live run under it, parents first", async () => {
    await seedTree()
    const { stopped, handler } = record()
    const team = handler()
    const job = handler()
    const workflow = handler()
    const off = [
      registerRunControlHandler("team", team),
      registerRunControlHandler("job", job),
      registerRunControlHandler("workflow", workflow),
    ]

    const result = await stopRunTree("root")

    expect(result).toEqual({ stopped: true, descendantsStopped: 3 })
    // The settled child is skipped; a child's child is reached after its parent.
    expect(stopped).toEqual(["root", "a", "a1", "c"])
    expect(team.mock.calls[0][0]).toMatchObject({
      action: "stop",
      runId: "root",
      expectedRevision: 0,
      actor: RUNTIME_STOP_ACTOR,
    })
    off.forEach((unregister) => unregister())
  })

  it("keeps stopping the rest when one child refuses", async () => {
    await seedTree()
    const { stopped, handler } = record()
    const off = [
      registerRunControlHandler("team", handler()),
      registerRunControlHandler("job", handler("a")),
      registerRunControlHandler("workflow", handler()),
    ]
    const result = await stopRunTree("root")
    expect(result.descendantsStopped).toBe(2)
    expect(stopped).toEqual(["root", "a", "a1", "c"])
    off.forEach((unregister) => unregister())
  })

  it("still stops the live runs under a settled root", async () => {
    await seedTree({ status: "cancelled" })
    const { stopped, handler } = record()
    const off = [
      registerRunControlHandler("team", handler()),
      registerRunControlHandler("job", handler()),
      registerRunControlHandler("workflow", handler()),
    ]
    const result = await stopRunTree("root")
    expect(result).toEqual({ stopped: false, reason: "terminal", descendantsStopped: 3 })
    expect(stopped).toEqual(["a", "a1", "c"])
    off.forEach((unregister) => unregister())
  })

  it("reports a root its kind refused, or that nothing handles", async () => {
    await createExecutionRun(row("lonely", { kind: "goal" }))
    await expect(stopRunTree("lonely")).resolves.toEqual({
      stopped: false,
      reason: "unsupported",
      descendantsStopped: 0,
    })
    const off = registerRunControlHandler("goal", async () => {
      throw new Error("engine said no")
    })
    await expect(stopRunTree("lonely")).resolves.toMatchObject({
      stopped: false,
      reason: "source_rejected",
    })
    off()
    await expect(stopRunTree("missing")).resolves.toEqual({
      stopped: false,
      reason: "run_not_found",
      descendantsStopped: 0,
    })
    // A child running here still stops when its row cannot be read.
    const stop = jest.fn()
    const unregister = registerRunStop("unreadable", stop)
    await expect(stopRunTree("unreadable")).resolves.toEqual({
      stopped: true,
      descendantsStopped: 0,
    })
    expect(stop).toHaveBeenCalledWith("execution_run_stopped")
    unregister()
  })

  it("stops a child through its registered stop without any handler installed", async () => {
    await createExecutionRun(row("solo"))
    await createExecutionRun(row("solo-child", { parentRunId: "solo" }))
    const rootStop = jest.fn()
    const childStop = jest.fn()
    const off = [registerRunStop("solo", rootStop), registerRunStop("solo-child", childStop)]
    await expect(stopRunTree("solo")).resolves.toEqual({ stopped: true, descendantsStopped: 1 })
    expect(rootStop).toHaveBeenCalled()
    expect(childStop).toHaveBeenCalled()
    off.forEach((unregister) => unregister())
  })

  it("cascades an operator's stop through the control gate to the live tree", async () => {
    await seedTree()
    const { stopped, handler } = record()
    const off = [
      registerRunControlHandler("team", handler()),
      registerRunControlHandler("job", handler()),
      registerRunControlHandler("workflow", handler()),
    ]
    const result = await executeRunControlCommand({
      runId: "root",
      action: "stop",
      idempotencyKey: "cockpit:root:stop:0",
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    })
    expect(result.accepted).toBe(true)
    expect(stopped).toEqual(["root", "a", "a1", "c"])
    off.forEach((unregister) => unregister())
  })

  it("does not cascade a control other than stop", async () => {
    await seedTree()
    const { stopped, handler } = record()
    const off = [
      registerRunControlHandler("team", handler()),
      registerRunControlHandler("job", handler()),
    ]
    await executeRunControlCommand({
      runId: "root",
      action: "pause",
      idempotencyKey: "cockpit:root:pause:0",
      expectedRevision: 0,
      actor: { remoteUserId: "owner" },
    })
    expect(stopped).toEqual(["root"])
    off.forEach((unregister) => unregister())
  })
})

describe("stop against a handler that settles the journal itself", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("answers accepted when the stop handler journals the terminal event before the gate", async () => {
    await createExecutionRun({
      id: "run-team-1",
      kind: "team",
      sourceId: "run_team_1",
      title: "Squad",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const { runEventJournal, semanticRunEvent } = await import("@/lib/db/execution-runs")
    const handler = jest.fn(async () => {
      // What controlSquadRun does when no lifecycle is alive to abort.
      await runEventJournal.append(
        "run-team-1",
        semanticRunEvent(
          "run.cancelled",
          { reason: "operator_stop" },
          { ts: 5, sourceEventId: "agent-team:run_team_1:run.cancelled:5" }
        )
      )
    })
    const unregister = registerRunControlHandler("team", handler)
    try {
      const result = await executeRunControlCommand(
        {
          runId: "run-team-1",
          action: "stop",
          idempotencyKey: "cmd-stop",
          expectedRevision: 0,
          actor: { remoteUserId: "operator" },
        },
        { operatorIds: ["operator"] }
      )
      expect(result.accepted).toBe(true)
      const run = await getDb().executionRuns.get("run-team-1")
      expect(run?.status).toBe("cancelled")
      expect(result.currentRevision).toBe(run?.currentRevision)
    } finally {
      unregister()
    }
  })

  it("still throws for a non-stop action whose handler settled the run", async () => {
    await createExecutionRun({
      id: "run-team-2",
      kind: "team",
      sourceId: "run_team_2",
      title: "Squad",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const { runEventJournal, semanticRunEvent } = await import("@/lib/db/execution-runs")
    const unregister = registerRunControlHandler("team", async () => {
      await runEventJournal.append(
        "run-team-2",
        semanticRunEvent(
          "run.completed",
          { reason: "done" },
          { ts: 5, sourceEventId: "agent-team:run_team_2:run.completed:5" }
        )
      )
    })
    try {
      await expect(
        executeRunControlCommand(
          {
            runId: "run-team-2",
            action: "pause",
            idempotencyKey: "cmd-pause",
            expectedRevision: 0,
            actor: { remoteUserId: "operator" },
          },
          { operatorIds: ["operator"] }
        )
      ).rejects.toThrow(/terminal/)
    } finally {
      unregister()
    }
  })
})

describe("execution run retry", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetRunRetryHandlersForTesting()
  })

  async function seedSettled(
    status: "failed" | "cancelled" | "completed" = "failed"
  ): Promise<void> {
    await createExecutionRun({
      id: "run-settled",
      kind: "workflow",
      sourceId: "wf-run-1",
      title: "Nightly export",
      status,
      initiator: { remoteUserId: "owner" },
      currentRevision: 3,
      startedAt: 1,
      updatedAt: 9,
      endedAt: 9,
    })
  }

  function retryCommand(over: Record<string, unknown> = {}) {
    return {
      runId: "run-settled",
      action: "retry" as const,
      idempotencyKey: "press-1",
      expectedRevision: 3,
      actor: { remoteUserId: "owner" },
      ...over,
    }
  }

  /** A handler that behaves like a real engine: it mints its own run row. */
  function mintingHandler(replacementId = "run-replacement") {
    return jest.fn(async () => {
      await createExecutionRun({
        id: replacementId,
        kind: "workflow",
        sourceId: "wf-run-2",
        title: "Nightly export",
        status: "running",
        currentRevision: 0,
        startedAt: 20,
        updatedAt: 20,
      })
      return { runId: replacementId }
    })
  }

  it("mints a replacement, links it, and leaves the settled journal final", async () => {
    await seedSettled()
    const handler = mintingHandler()
    registerRunRetryHandler("workflow", handler)

    const result = await executeRunControlCommand(retryCommand())

    expect(result).toMatchObject({ accepted: true, retryRunId: "run-replacement" })
    expect(handler).toHaveBeenCalledTimes(1)
    // The whole reason retry could not land before: nothing may be appended to
    // a settled run, so the provenance is a row stamp instead.
    expect(await getDb().executionRunEvents.where("runId").equals("run-settled").count()).toBe(0)
    const settled = await getDb().executionRuns.get("run-settled")
    expect(settled).toMatchObject({
      status: "failed",
      currentRevision: 3,
      retry: { idempotencyKey: "press-1", runId: "run-replacement" },
    })
    expect((await getDb().executionRuns.get("run-replacement"))?.parentRunId).toBe("run-settled")
  })

  it("stops offering retry on the run it already replaced", async () => {
    await seedSettled()
    registerRunRetryHandler("workflow", mintingHandler())
    await executeRunControlCommand(retryCommand())

    const settled = await getDb().executionRuns.get("run-settled")
    expect(settled?.latestSnapshot?.allowedActions).toEqual(["open_details"])
  })

  it("answers a redelivered press with the replacement it already made", async () => {
    await seedSettled()
    const handler = mintingHandler()
    registerRunRetryHandler("workflow", handler)

    await executeRunControlCommand(retryCommand())
    const again = await executeRunControlCommand(retryCommand())

    expect(again).toMatchObject({
      accepted: true,
      duplicate: true,
      retryRunId: "run-replacement",
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("refuses a SECOND fork off one settled run and names the replacement", async () => {
    // Two live descendants of one commitment, and no way to say which one is
    // it. The answer is "retry the replacement", which is why the id comes back.
    await seedSettled()
    registerRunRetryHandler("workflow", mintingHandler())
    await executeRunControlCommand(retryCommand())

    const second = await executeRunControlCommand(retryCommand({ idempotencyKey: "press-2" }))

    expect(second).toMatchObject({
      accepted: false,
      reason: "already_retried",
      retryRunId: "run-replacement",
    })
  })

  it("refuses a kind with no re-dispatch instead of a generic engine refusal", async () => {
    await seedSettled()
    const result = await executeRunControlCommand(retryCommand())
    expect(result).toMatchObject({ accepted: false, reason: "unsupported_for_kind" })
  })

  it("keeps every OTHER action refused on a settled run", async () => {
    await seedSettled()
    registerRunRetryHandler("workflow", mintingHandler())
    const stopped = await executeRunControlCommand(retryCommand({ action: "stop" }))
    expect(stopped).toMatchObject({ accepted: false, reason: "source_rejected" })
  })

  it("does not retry a run that succeeded", async () => {
    // The button is never offered for `completed`, and the gate agrees: redoing
    // work that worked is a new request, not a retry of this one.
    await seedSettled("completed")
    const handler = mintingHandler()
    registerRunRetryHandler("workflow", async (context) => {
      if (context.run.status === "completed") {
        const error = new Error("cannot retry a completed run")
        error.name = "UnsupportedForKindError"
        throw error
      }
      return handler()
    })
    const result = await executeRunControlCommand(retryCommand())
    expect(result).toMatchObject({ accepted: false, reason: "unsupported_for_kind" })
  })

  it("authorizes and revision-checks without touching the settled journal", async () => {
    await seedSettled()
    const handler = mintingHandler()
    registerRunRetryHandler("workflow", handler)

    const stranger = await executeRunControlCommand(
      retryCommand({ actor: { remoteUserId: "stranger" } })
    )
    const stale = await executeRunControlCommand(retryCommand({ expectedRevision: 1 }))

    expect(stranger).toMatchObject({ accepted: false, reason: "forbidden" })
    expect(stale).toMatchObject({ accepted: false, reason: "revision_conflict" })
    expect(handler).not.toHaveBeenCalled()
    // `reject()` would have appended `control.rejected`, which a terminal
    // journal refuses — so a refusal here has to be an answer, not a throw.
    expect(await getDb().executionRunEvents.where("runId").equals("run-settled").count()).toBe(0)
  })

  it("reports an engine refusal without stamping the settled run", async () => {
    await seedSettled()
    registerRunRetryHandler("workflow", async () => {
      throw new Error("deployment gone")
    })

    const result = await executeRunControlCommand(retryCommand())

    expect(result).toMatchObject({ accepted: false, reason: "source_rejected" })
    expect((await getDb().executionRuns.get("run-settled"))?.retry).toBeUndefined()
  })
})
