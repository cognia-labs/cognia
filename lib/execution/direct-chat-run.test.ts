/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import { recordedRunMetadata, LOCAL_PERSON_RUN } from "./acting-authority"
import {
  ensureDirectChatExecutionRun,
  releasePreparedDirectChatExecutionRun,
  finishUnstartedDirectChatExecutionRun,
  finishDirectChatExecutionRun,
  hasActiveDirectChatExecutionRun,
  projectDirectChatCaptureEvent,
  projectDirectChatSdkMessage,
  recoverStaleDirectChatExecutionRuns,
  startDirectChatExecutionRun,
} from "./direct-chat-run"

const settlePlanChatHandoffAfterTurn = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/agent/plan/chat-handoff", () => ({
  settlePlanChatHandoffAfterTurn: (...args: unknown[]) => settlePlanChatHandoffAfterTurn(...args),
}))

describe("direct chat execution run", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("settles a plan handed to the turn when the turn ends, once", async () => {
    settlePlanChatHandoffAfterTurn.mockClear()
    await startDirectChatExecutionRun({
      sessionId: "session-plan",
      runId: "run:session-plan:1",
      startedAt: 5_000,
    })
    await finishDirectChatExecutionRun("session-plan", "cancelled", 6_000, "stopped")
    await finishDirectChatExecutionRun("session-plan", "cancelled", 6_000, "stopped")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settlePlanChatHandoffAfterTurn).toHaveBeenCalledTimes(1)
    expect(settlePlanChatHandoffAfterTurn).toHaveBeenCalledWith(
      "session-plan",
      "cancelled",
      5_000,
      "stopped"
    )
  })

  it("reports a turn as active only between start and finish", async () => {
    expect(hasActiveDirectChatExecutionRun("session-live")).toBe(false)
    await startDirectChatExecutionRun({
      sessionId: "session-live",
      runId: "run:session-live:1",
      startedAt: 1_000,
    })
    expect(hasActiveDirectChatExecutionRun("session-live")).toBe(true)
    await finishDirectChatExecutionRun("session-live", "failed", 2_000, "boom")
    expect(hasActiveDirectChatExecutionRun("session-live")).toBe(false)
  })

  it("creates one canonical run and journals tool lifecycle through the existing producer", async () => {
    const input = {
      localAuthorization: LOCAL_PERSON_RUN as typeof LOCAL_PERSON_RUN,
      sessionId: "session-1",
      runId: "run:session-1:1",
      projectId: "project-1",
      workspaceRoot: "/workspace",
      startedAt: 1_000,
    }

    await startDirectChatExecutionRun(input)
    await startDirectChatExecutionRun(input)
    await projectDirectChatCaptureEvent("session-1", {
      type: "tool-call",
      id: "tool-1",
      toolName: "Read",
      input: { file_path: "/workspace/src/index.ts" },
    })
    await projectDirectChatCaptureEvent("session-1", {
      type: "tool-result",
      id: "tool-1",
      toolName: "Read",
      result: "private file content must not be journaled",
    })
    await finishDirectChatExecutionRun("session-1", "completed", 2_000)

    const run = await getDb().executionRuns.get(input.runId)
    expect(run?.actingIdentity).toMatchObject({
      schemaVersion: 1,
      lane: "legacy",
      trigger: "local",
      authorizingPrincipal: { kind: "local-person" },
      requesters: [{ kind: "local-person" }],
      actingPrincipal: { kind: "local-person" },
      authorityRevision: 0,
    })
    expect(run?.authority).toBeUndefined()
    expect(run).toMatchObject({
      id: input.runId,
      kind: "agent-turn",
      sourceId: input.runId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      title: "Chat run",
      status: "completed",
    })
    const events = await listExecutionRunEvents(input.runId)
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "step.added",
      "step.started",
      "tool.started",
      "tool.completed",
      "step.completed",
      "run.completed",
    ])
    expect(JSON.stringify(events)).not.toContain("private file content")
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1)
  })

  it("marks stale non-terminal direct chat runs as recovery required", async () => {
    await createExecutionRun({
      id: "run:stale",
      kind: "agent-turn",
      sourceId: "run:stale",
      sessionId: "session-stale",
      title: "Chat run",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await createExecutionRun({
      id: "run:done",
      kind: "agent-turn",
      sourceId: "run:done",
      sessionId: "session-done",
      title: "Chat run",
      status: "completed",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
    })

    await expect(recoverStaleDirectChatExecutionRuns(5_000, 2)).resolves.toBe(1)
    await expect(getDb().executionRuns.get("run:stale")).resolves.toMatchObject({
      status: "recovery_required",
    })
    await expect(getDb().executionRuns.get("run:done")).resolves.toMatchObject({
      status: "completed",
    })
  })

  it("leaves a turn this load started, or still holds, out of the boot sweep", async () => {
    const loadedAt = 10_000
    const row = (id: string, startedAt: number) =>
      createExecutionRun({
        id,
        kind: "agent-turn",
        sourceId: id,
        sessionId: `session-${id}`,
        title: "Chat run",
        status: "running",
        currentRevision: 0,
        startedAt,
        updatedAt: startedAt,
      })
    await row("run:left-behind", 9_000)
    // Started after this renderer loaded: the sweep running late must not park it.
    await row("run:after-load", 10_500)
    // Started before the load was stamped, but this renderer holds its handle.
    await startDirectChatExecutionRun({
      sessionId: "session-held",
      runId: "run:held",
      startedAt: 9_500,
    })

    await expect(recoverStaleDirectChatExecutionRuns(20_000, loadedAt)).resolves.toBe(1)
    await expect(getDb().executionRuns.get("run:left-behind")).resolves.toMatchObject({
      status: "recovery_required",
    })
    await expect(getDb().executionRuns.get("run:after-load")).resolves.toMatchObject({
      status: "running",
    })
    await expect(getDb().executionRuns.get("run:held")).resolves.not.toMatchObject({
      status: "recovery_required",
    })
    await finishDirectChatExecutionRun("session-held", "completed", 21_000)
  })

  it("holds a run lock while a turn runs, and leaves a turn another tab holds alone", async () => {
    const held = new Set<string>()
    const foreign = new Set(["cognia.direct-chat-run:run:other-tab"])
    const locks = {
      request: jest.fn((name: string, hold: () => Promise<void>) => {
        held.add(name)
        return hold().finally(() => held.delete(name))
      }),
      query: jest.fn(async () => ({
        held: [...held, ...foreign].map((name) => ({ name })),
        pending: [],
      })),
    }
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true })
    try {
      await startDirectChatExecutionRun({
        sessionId: "session-mine",
        runId: "run:mine",
        startedAt: 1,
      })
      expect(held.has("cognia.direct-chat-run:run:mine")).toBe(true)
      await createExecutionRun({
        id: "run:other-tab",
        kind: "agent-turn",
        sourceId: "run:other-tab",
        sessionId: "session-other-tab",
        title: "Chat run",
        status: "running",
        currentRevision: 0,
        startedAt: 1,
        updatedAt: 1,
      })

      await expect(recoverStaleDirectChatExecutionRuns(20_000, 10_000)).resolves.toBe(0)
      await expect(getDb().executionRuns.get("run:other-tab")).resolves.toMatchObject({
        status: "running",
      })

      await finishDirectChatExecutionRun("session-mine", "completed", 2)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(held.has("cognia.direct-chat-run:run:mine")).toBe(false)
    } finally {
      delete (navigator as { locks?: unknown }).locks
    }
  })

  it("projects SDK tool snapshots once and records compaction without content", async () => {
    await startDirectChatExecutionRun({
      sessionId: "session-sdk",
      runId: "run:session-sdk:1",
      startedAt: 1,
    })
    const assistant = {
      type: "assistant" as const,
      message: {
        id: "message-1",
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "tool-sdk", name: "Bash", input: { command: "pwd" } },
        ],
      },
      parent_tool_use_id: null,
      uuid: "message-1",
      session_id: "sdk-1",
    }
    await projectDirectChatSdkMessage("session-sdk", assistant, 2)
    await projectDirectChatSdkMessage("session-sdk", assistant, 3)
    await projectDirectChatSdkMessage(
      "session-sdk",
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-sdk",
              content: "secret output",
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: "message-2",
        session_id: "sdk-1",
      },
      4
    )
    await projectDirectChatSdkMessage(
      "session-sdk",
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 20 },
        uuid: "compact-1",
        session_id: "sdk-1",
      },
      5
    )

    const events = await listExecutionRunEvents("run:session-sdk:1")
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1)
    expect(events.some((event) => event.type === "milestone.created")).toBe(true)
    expect(JSON.stringify(events)).not.toContain("secret output")
  })
})

it("admits an ordinary chat row before authority resolution without starting execution", async () => {
  await getDb().delete()
  __resetDbForTesting()
  const input: import("./direct-chat-run").StartDirectChatExecutionRunInput = {
    sessionId: "planned-session",
    runId: "planned-run",
    localAuthorization: LOCAL_PERSON_RUN,
  }
  const admitted = await ensureDirectChatExecutionRun(input)
  expect(admitted.status).toBe("queued")
  expect(hasActiveDirectChatExecutionRun(input.sessionId)).toBe(false)
  expect(await listExecutionRunEvents(input.runId)).toEqual([])
  const { enforceRunAuthorityOnSendOptions } = await import("./run-authority")
  const options = {
    permissionMode: "default" as const,
    maxTurns: 20,
    runAuthority: { schemaVersion: 1 as const, maxTurns: 20 },
  }
  await enforceRunAuthorityOnSendOptions(input.runId, options)
  await startDirectChatExecutionRun({ ...input, workspaceRoot: "/resolved" })
  expect(hasActiveDirectChatExecutionRun(input.sessionId)).toBe(true)
  expect((await getDb().executionRuns.get(input.runId))?.authority?.maxTurns).toBe(20)
  await finishDirectChatExecutionRun(input.sessionId, "completed")
})

it("inherits a Host-captured coordinator parent before its first option resolution", async () => {
  await getDb().delete()
  __resetDbForTesting()
  await createExecutionRun({
    ...recordedRunMetadata("local", { runId: "coordinator-parent" }),
    id: "coordinator-parent",
    sourceId: "parent",
    kind: "agent-turn",
    title: "parent",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    authority: {
      schemaVersion: 1,
      permissionMode: "plan",
      maxTurns: 2,
      tools: { allow: ["Read"], deny: ["Bash"] },
    },
  })
  const child = await ensureDirectChatExecutionRun({
    sessionId: "thread",
    runId: "thread-turn",
    parentRunId: "coordinator-parent",
  })
  expect(child.parentRunId).toBe("coordinator-parent")
  expect(child.actingIdentity).toEqual(
    (await getDb().executionRuns.get("coordinator-parent"))?.actingIdentity
  )
  expect(child.authority).toMatchObject({
    permissionMode: "plan",
    maxTurns: 2,
    tools: { allow: ["Read"], deny: ["Bash"] },
  })
})

it("cancels a prepared row when options or routing refuse before dispatch", async () => {
  await getDb().delete()
  __resetDbForTesting()
  await ensureDirectChatExecutionRun({
    sessionId: "refused-preparation",
    runId: "refused-preparation-run",
  })
  expect(await finishUnstartedDirectChatExecutionRun("refused-preparation-run")).toBe(true)
  expect(await finishUnstartedDirectChatExecutionRun("refused-preparation-run")).toBe(false)
  expect((await getDb().executionRuns.get("refused-preparation-run"))?.status).toBe("cancelled")
  expect(hasActiveDirectChatExecutionRun("refused-preparation")).toBe(false)
})

it("settles its own early preparation and releases it when another durable claimant wins", async () => {
  await getDb().delete()
  __resetDbForTesting()
  await ensureDirectChatExecutionRun({
    sessionId: "early",
    runId: "early-owned",
    ownsDispatch: false,
  })
  await finishUnstartedDirectChatExecutionRun("early-owned")
  expect((await getDb().executionRuns.get("early-owned"))?.status).toBe("cancelled")
  const queued = await ensureDirectChatExecutionRun({
    sessionId: "early",
    runId: "early-transferred",
    ownsDispatch: false,
  })
  releasePreparedDirectChatExecutionRun(queued.id)
  await finishUnstartedDirectChatExecutionRun(queued.id)
  expect(await getDb().executionRuns.get(queued.id)).toEqual(queued)
})

it("settles only the owning preparation when sends overlap on one session", async () => {
  await getDb().delete()
  __resetDbForTesting()
  await ensureDirectChatExecutionRun({ sessionId: "overlap", runId: "prepare-a" })
  await ensureDirectChatExecutionRun({ sessionId: "overlap", runId: "prepare-b" })
  await finishUnstartedDirectChatExecutionRun("prepare-a")
  expect((await getDb().executionRuns.get("prepare-a"))?.status).toBe("cancelled")
  expect((await getDb().executionRuns.get("prepare-b"))?.status).toBe("queued")
  await startDirectChatExecutionRun({ sessionId: "overlap", runId: "prepare-b" })
  await finishUnstartedDirectChatExecutionRun("prepare-a")
  expect((await getDb().executionRuns.get("prepare-b"))?.status).toBe("running")
  await finishDirectChatExecutionRun("overlap", "completed")
})

it("falls back to a root and observes a captured coordinator parent missing on this device", async () => {
  await getDb().delete()
  __resetDbForTesting()
  const child = await ensureDirectChatExecutionRun({
    sessionId: "thread",
    runId: "missing-parent-thread",
    parentRunId: "missing",
  })
  expect(child.parentRunId).toBeUndefined()
  expect(child.actingIdentity?.rootRunId).toBe(child.id)
  expect(JSON.stringify(await listExecutionRunEvents(child.id))).toContain(
    "coordinator_parent_unavailable"
  )
})

it("keeps a legacy coordinator thread with no parent claim top-level with its own options", async () => {
  await getDb().delete()
  __resetDbForTesting()
  const child = await ensureDirectChatExecutionRun({
    sessionId: "legacy-thread",
    runId: "legacy-thread-run",
  })
  const { enforceRunAuthorityOnSendOptions } = await import("./run-authority")
  const ownOptions = {
    permissionMode: "bypassPermissions" as const,
    allowedTools: ["Read", "Bash"],
    maxTurns: 10,
  }
  await enforceRunAuthorityOnSendOptions(child.id, ownOptions)
  expect(ownOptions.permissionMode).toBe("bypassPermissions")
  expect(ownOptions.maxTurns).toBe(10)
  expect((await getDb().executionRuns.get(child.id))?.parentRunId).toBeUndefined()
})
