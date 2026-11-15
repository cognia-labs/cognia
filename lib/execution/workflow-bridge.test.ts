/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const stopAgentStateBridge = jest.fn()
jest.mock("./agent-state-bridge", () => ({
  startAgentStateExecutionBridge: jest.fn(() => stopAgentStateBridge),
}))

import { waitFor } from "@testing-library/dom"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "./acting-authority"
import {
  __resetWorkflowExecutionBridgeForTesting,
  executionKindForWorkflowRun,
  startWorkflowExecutionBridge,
  syncWorkflowExecutionRun,
  workflowExecutionRunId,
} from "./workflow-bridge"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import { RunAuthorityError } from "./run-authority"

function workflowRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "wf-run-1",
    workflowId: "wf-1",
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1,
    triggeredBySource: "im",
    triggeredBy: {
      source: "im",
      adapterId: "lark-1",
      conversationKey: "lark:lark-1:chat-1",
      sessionId: "session-1",
      sourceMessageId: "message-1",
    },
    workflowSnapshot: {
      id: "wf-1",
      name: "Release",
      description: "",
      schemaVersion: 2,
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: "step-1",
          type: "ai.prompt",
          typeVersion: 2,
          position: { x: 0, y: 0 },
          data: { label: "Draft", params: {} },
        },
      ],
      edges: [],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 0,
        concurrency: 1,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    },
    ...overrides,
  }
}

describe("workflow execution bridge", () => {
  it("does not record an IM connector ceiling as descendant authority", async () => {
    await getDb().mcpServers.put({ id: "mcp_x", name: "github", enabled: true } as never)
    await syncWorkflowExecutionRun(
      workflowRun({
        securityContext: {
          permissionCeiling: { mcpServers: [{ name: "github" }] },
        } as never,
      }),
      [],
      []
    )
    const parentId = workflowExecutionRunId("wf-run-1")
    const child = await startToolExecutionRun("child-session", { parentRunId: parentId })
    expect(child.authority).toBeUndefined()
    const { enforceRunAuthorityOnSendOptions } = await import("./run-authority")
    const options = {
      mcpServers: { github: { command: "github" }, other: { command: "other" } },
      runAuthorityMcpServerIds: { github: "mcp_x", other: "mcp_y" },
    }
    await enforceRunAuthorityOnSendOptions(child.id, options)
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["github", "other"])
  })
  it("does not infer local authority from a manual trigger or a UI origin supplied by a plugin", async () => {
    await syncWorkflowExecutionRun(
      workflowRun({ triggerKind: "trigger.manual", triggeredBy: { source: "ui" } }),
      [],
      []
    )
    expect(
      (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity?.trigger
    ).toBe("external-event")
  })
  it.each([
    "trigger.webhook",
    "trigger.integration.event",
    "trigger.connector.system",
    "trigger.goal.completed",
    "trigger.terminal.command",
    "trigger.pet.event",
    "trigger.issue.event",
    "trigger.plan.event",
    "trigger.scheduler.taskCompleted",
    "trigger.capture.item",
    "trigger.memory.written",
    "trigger.file.watch",
    "trigger.workflow.completed",
    "trigger.desktop.event",
    "trigger.chat.message",
  ] as const)(
    "records automatic %s without triggeredBy as an external event",
    async (triggerKind) => {
      await syncWorkflowExecutionRun(
        workflowRun({ triggerKind, triggeredBy: undefined, triggeredBySource: undefined }),
        [],
        []
      )
      expect(
        (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
      ).toMatchObject({ trigger: "external-event", requesters: [] })
    }
  )

  it("records an integration envelope's actor only as an event actor", async () => {
    await syncWorkflowExecutionRun(
      workflowRun({
        triggerKind: "trigger.integration.event",
        triggeredBy: undefined,
        triggerPayload: { actor: { id: "sender", label: "Sender" } },
      }),
      [],
      []
    )
    expect(
      (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
    ).toMatchObject({
      trigger: "external-event",
      requesters: [],
      eventActors: [
        {
          kind: "event-actor",
          source: "trigger.integration.event",
          externalId: "sender",
          displayName: "Sender",
        },
      ],
    })
  })

  it.each(["trigger.chat.message", "trigger.team"] as const)(
    "ignores the default UI index stamp on automatic %s",
    async (triggerKind) => {
      await syncWorkflowExecutionRun(
        workflowRun({ triggerKind, triggeredBy: undefined, triggeredBySource: "ui" }),
        [],
        []
      )
      expect(
        (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
      ).toMatchObject({ trigger: "external-event", requesters: [] })
    }
  )

  it.each([
    {
      triggerKind: "trigger.connector.system",
      triggerPayload: { sender: { remoteUserId: "sender", displayName: "Sender" } },
    },
    {
      triggerKind: "trigger.integration.event",
      triggerPayload: { event: { actor: { id: "sender", displayName: "Sender" } } },
    },
    {
      triggerKind: "trigger.webhook",
      triggerPayload: {},
      triggeredBy: {
        source: "bot" as const,
        initiator: { platformIdentityId: "sender", displayName: "Sender" },
      },
    },
  ])("keeps $triggerKind event senders out of requesters", async (overrides) => {
    await syncWorkflowExecutionRun(
      workflowRun({ triggeredBy: undefined, ...(overrides as Partial<WorkflowRunRow>) }),
      [],
      []
    )
    expect(
      (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
    ).toMatchObject({
      trigger: "external-event",
      requesters: [],
      eventActors: [
        {
          kind: "event-actor",
          source: overrides.triggerKind,
          externalId: "sender",
          displayName: "Sender",
        },
      ],
    })
  })

  it("records a connector message's existing sender as a requester", async () => {
    await syncWorkflowExecutionRun(
      workflowRun({
        triggerKind: "trigger.connector.inbound",
        triggeredBy: undefined,
        triggerPayload: {
          platform: "lark",
          adapterId: "adapter",
          sender: { remoteUserId: "alice" },
          channelData: { identityScope: { unionId: "union" } },
        },
      }),
      [],
      []
    )
    expect(
      (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
    ).toMatchObject({
      trigger: "requester",
      requesters: [
        {
          kind: "platform",
          platform: "lark",
          adapterId: "adapter",
          remoteUserId: "alice",
          unionId: "union",
        },
      ],
    })
  })

  it("does not infer an event actor from arbitrary webhook body fields", async () => {
    await syncWorkflowExecutionRun(
      workflowRun({
        triggerKind: "trigger.webhook",
        triggeredBy: undefined,
        triggerPayload: { body: { actor: { id: "untrusted" } } },
      }),
      [],
      []
    )
    expect(
      (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
    ).toMatchObject({ trigger: "external-event", requesters: [], eventActors: [] })
  })

  it.each([{ actor: "alice" }, { actor: null }, null])(
    "does not let malformed event metadata interrupt projection: %p",
    async (triggerPayload) => {
      await expect(
        syncWorkflowExecutionRun(
          workflowRun({
            triggerKind: "trigger.integration.event",
            triggeredBy: undefined,
            triggerPayload,
          }),
          [],
          []
        )
      ).resolves.toBeUndefined()
      expect(
        (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.actingIdentity
      ).toMatchObject({ trigger: "external-event", requesters: [], eventActors: [] })
    }
  )

  it("keeps a scheduled workflow's resolved ceiling out of descendant authority", async () => {
    await getDb().mcpServers.put({ id: "mcp_docs", name: "docs" } as never)
    const row = workflowRun({
      triggerKind: "trigger.cron",
      triggeredBy: { source: "schedule" },
      securityContext: {
        piiEgressRequired: true,
        sourceTriggerKind: "trigger.cron",
        permissionCeiling: {
          permissionMode: "plan",
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
          mcpServers: [{ name: "docs" }],
        },
      },
    })
    await syncWorkflowExecutionRun(row, [], [])
    const run = await getDb().executionRuns.get("execution:workflow:wf-run-1")
    expect(run?.actingIdentity).toMatchObject({
      lane: "legacy",
      trigger: "schedule",
      requesters: [],
    })
    expect(run?.actingIdentity?.authorizingPrincipal).toBeUndefined()
    expect(run?.authority).toBeUndefined()
  })
  beforeEach(async () => {
    __resetWorkflowExecutionBridgeForTesting()
    stopAgentStateBridge.mockClear()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(() => {
    __resetWorkflowExecutionBridgeForTesting()
  })

  it("creates one shared run, durable binding, and idempotently maps source events", async () => {
    const row = workflowRun()
    const event = {
      id: "source-event-1",
      runId: row.id,
      ts: 2,
      type: "step_started" as const,
      stepId: "step-1",
    }

    await syncWorkflowExecutionRun(row, [event], [])
    await syncWorkflowExecutionRun(row, [event], [])

    const run = await getDb().executionRuns.get("execution:workflow:wf-run-1")
    expect(run?.actingIdentity).toMatchObject({
      lane: "legacy",
      trigger: "requester",
      requesters: [],
      authorityRevision: 0,
    })
    expect(run?.latestSnapshot).toMatchObject({
      kind: "workflow",
      workflowGraph: {
        workflowId: "wf-1",
        sourceRunId: "wf-run-1",
        nodes: [expect.objectContaining({ id: "step-1" })],
        edges: [],
      },
      progress: { total: 1, trustworthy: true },
      activeSteps: [expect.objectContaining({ id: "step-1", title: "Step 1" })],
    })
    expect(await getDb().executionRunEvents.where("runId").equals(run!.id).count()).toBe(3)
    expect(await getDb().executionRunBindings.where("runId").equals(run!.id).first()).toMatchObject(
      {
        sourceMessageId: "message-1",
        deliveryMode: "native",
      }
    )
  })

  it("projects terminal workflow history in durable sequence order", async () => {
    const row = workflowRun({ status: "succeeded", completedAt: 5 })
    const events = [
      {
        id: "a-terminal-sorts-first-by-primary-key",
        runId: row.id,
        sequence: 3,
        ts: 5,
        type: "run_completed" as const,
      },
      {
        id: "z-step-started",
        runId: row.id,
        sequence: 1,
        ts: 3,
        type: "step_started" as const,
        stepId: "step-1",
      },
      {
        id: "y-step-completed",
        runId: row.id,
        sequence: 2,
        ts: 4,
        type: "step_completed" as const,
        stepId: "step-1",
      },
    ]

    await syncWorkflowExecutionRun(row, events, [])
    await expect(syncWorkflowExecutionRun(row, events, [])).resolves.toBeUndefined()

    const runId = "execution:workflow:wf-run-1"
    const run = await getDb().executionRuns.get(runId)
    expect(run?.status).toBe("completed")
    const projected = await getDb()
      .executionRunEvents.where("[runId+seq]")
      .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
      .toArray()
    expect(projected.slice(-3).map((event) => event.sourceEventId)).toEqual([
      "z-step-started",
      "y-step-completed",
      "a-terminal-sorts-first-by-primary-key",
    ])
  })

  it.each([
    ["trigger.manual", "workflow"],
    ["trigger.team", "team"],
    ["trigger.goal.completed", "workflow"],
    ["trigger.cron", "scheduled"],
  ] as const)("maps %s to the shared %s run kind", (triggerKind, expectedKind) => {
    expect(executionKindForWorkflowRun({ triggerKind } as WorkflowRunRow)).toBe(expectedKind)
  })

  it.each(["wf-run-1", "wf-run-2"])(
    "links a retry with workflow root %s to its verified execution parent",
    async (rootRunId) => {
      // A retry is a replacement, not a stranger. Deriving the link here — rather
      // than coordinating with whoever pressed the button — is what makes a retry
      // driven from the desktop history view join the same chain as one driven
      // through the run-control gate.
      await getDb().workflowRuns.put(workflowRun())
      await syncWorkflowExecutionRun(workflowRun(), [], [])
      const authority = { schemaVersion: 1 as const, caps: "explicit-v1" as const, maxTurns: 2 }
      await getDb().executionRuns.update("execution:workflow:wf-run-1", { authority })
      await syncWorkflowExecutionRun(
        workflowRun({
          id: "wf-run-2",
          lineage: {
            rootRunId,
            retryOfRunId: "wf-run-1",
            retryMode: "current-deployment",
          },
        }),
        [],
        []
      )

      expect((await getDb().executionRuns.get("execution:workflow:wf-run-2"))?.parentRunId).toBe(
        "execution:workflow:wf-run-1"
      )
      expect(
        (await getDb().executionRuns.get("execution:workflow:wf-run-2"))?.actingIdentity?.rootRunId
      ).toBe("execution:workflow:wf-run-1")
      expect((await getDb().executionRuns.get("execution:workflow:wf-run-2"))?.authority).toEqual(
        authority
      )
      // A first run is a root, and must not gain a parent it never had.
      expect(
        (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.parentRunId
      ).toBeUndefined()
    }
  )

  it("recreates a legacy workflow execution without claimed lineage", async () => {
    const source = workflowRun()
    await syncWorkflowExecutionRun(source, [], [])
    await getDb().executionRuns.delete(workflowExecutionRunId(source.id))
    await syncWorkflowExecutionRun(source, [], [])
    expect(await getDb().executionRuns.get(workflowExecutionRunId(source.id))).toBeDefined()
  })

  it("retains a canonical parent when its workflow source disappears mid-run", async () => {
    const parent = workflowRun({ id: "deleted-parent" })
    await getDb().workflowRuns.put(parent)
    await syncWorkflowExecutionRun(parent, [], [])
    const child = workflowRun({ lineage: { rootRunId: parent.id, parentRunId: parent.id } })
    await syncWorkflowExecutionRun(child, [], [])
    await getDb().workflowRuns.delete(parent.id)
    await syncWorkflowExecutionRun(child, [], [])
    const id = workflowExecutionRunId(child.id)
    expect((await getDb().executionRuns.get(id))?.parentRunId).toBe(
      workflowExecutionRunId(parent.id)
    )
    expect(
      await getDb()
        .executionRunEvents.where("runId")
        .equals(id)
        .filter((event) => event.seq === 0)
        .count()
    ).toBeGreaterThan(0)
  })

  it.each(["workflow", "project", "session", "source", "kind", "root"] as const)(
    "round 4: rejects a mismatched %s retry anchor through createExecutionRun",
    async (mismatch) => {
      const local = await startToolExecutionRun("session-1", {
        localAuthorization: LOCAL_PERSON_RUN,
      })
      const foreign = workflowRun({
        id: "foreign",
        workflowId: mismatch === "workflow" ? "other-workflow" : "wf-1",
        projectId: mismatch === "project" ? "other-project" : undefined,
      })
      await getDb().workflowRuns.put(foreign)
      await getDb().executionRuns.put({
        ...local,
        id: "execution:workflow:foreign",
        sessionId: mismatch === "session" ? "foreign-session" : "session-1",
        kind: mismatch === "kind" ? "agent-turn" : "workflow",
        sourceId: mismatch === "source" ? "different-source" : foreign.id,
        actingIdentity: { ...local.actingIdentity!, rootRunId: "execution:workflow:foreign" },
      })
      await expect(
        syncWorkflowExecutionRun(
          workflowRun({
            lineage: {
              rootRunId: mismatch === "root" ? "another-root" : foreign.id,
              retryOfRunId: foreign.id,
              retryMode: "current-deployment",
            },
          }),
          [],
          []
        )
      ).rejects.toBeInstanceOf(RunAuthorityError)
      expect(await getDb().executionRuns.get("execution:workflow:wf-run-1")).toBeUndefined()
    }
  )

  it.each(["both-missing", "source-missing", "execution-missing", "other-project"])(
    "starts an observed root for non-contradicting lineage verification misses: %s",
    async (missing) => {
      const parent = workflowRun({ id: "parent", projectId: "project-a" })
      if (missing !== "both-missing") {
        await getDb().workflowRuns.put(parent)
        await syncWorkflowExecutionRun(parent, [], [])
        await getDb().executionRuns.update(workflowExecutionRunId(parent.id), {
          authority: { schemaVersion: 1, caps: "explicit-v1", maxTurns: 2 },
        })
        if (missing === "source-missing") await getDb().workflowRuns.delete(parent.id)
        if (missing === "execution-missing")
          await getDb().executionRuns.delete(workflowExecutionRunId(parent.id))
      }
      await syncWorkflowExecutionRun(
        workflowRun({
          projectId: missing === "other-project" ? "project-b" : "project-a",
          lineage: { rootRunId: parent.id, parentRunId: parent.id },
        }),
        [],
        []
      )
      const run = await getDb().executionRuns.get("execution:workflow:wf-run-1")
      expect(run?.parentRunId).toBeUndefined()
      expect(run?.actingIdentity?.rootRunId).toBe(run?.id)
      expect(run?.authority).toEqual(
        missing === "other-project"
          ? { schemaVersion: 1, caps: "explicit-v1", maxTurns: 2 }
          : undefined
      )
      expect(await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              operation: "workflow-lineage-observed",
              inheritedAuthorityUnavailable: missing !== "other-project",
            }),
          }),
        ])
      )
    }
  )

  it("does not infer a parent or its caps from unclaimed same-session workflow history", async () => {
    const parent = workflowRun({ id: "parent" })
    await getDb().workflowRuns.put(parent)
    await syncWorkflowExecutionRun(parent, [], [])
    await getDb().executionRuns.update(workflowExecutionRunId(parent.id), {
      authority: { schemaVersion: 1, caps: "explicit-v1", maxTurns: 2 },
    })
    await syncWorkflowExecutionRun(workflowRun(), [], [])
    const run = await getDb().executionRuns.get("execution:workflow:wf-run-1")
    expect(run?.parentRunId).toBeUndefined()
    expect(run?.authority).toBeUndefined()
  })
  it.each([
    { rootRunId: "" },
    { rootRunId: "wf-run-1", parentRunId: "" },
    { rootRunId: "wf-run-1", retryOfRunId: "" },
  ])("refuses empty claimed lineage ids: %j", async (lineage) => {
    await expect(syncWorkflowExecutionRun(workflowRun({ lineage }), [], [])).rejects.toMatchObject({
      name: "RunAuthorityError",
      reason: "identity_mismatch",
    })
    expect(await getDb().executionRuns.count()).toBe(0)
  })

  it("recreates an uncapped retry after both seed rows were pruned and observes the missing seed", async () => {
    await syncWorkflowExecutionRun(
      workflowRun({
        lineage: { rootRunId: "pruned", retryOfRunId: "pruned", retryMode: "current-deployment" },
      }),
      [],
      []
    )
    const run = await getDb().executionRuns.get("execution:workflow:wf-run-1")
    expect(run?.parentRunId).toBeUndefined()
    expect(run?.authority).toBeUndefined()
    expect(await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            operation: "workflow-lineage-observed",
            parentSourceMissing: true,
          }),
        }),
      ])
    )
  })

  it.each([false, true])(
    "pruned retries become observed roots regardless of their own ceiling, capped=%s",
    async (capped) => {
      const source = workflowRun({
        lineage: { rootRunId: "pruned", retryOfRunId: "pruned", retryMode: "current-deployment" },
        securityContext: {
          piiEgressRequired: false,
          sourceTriggerKind: "trigger.manual",
          permissionCeiling: capped ? { permissionMode: "plan" } : {},
        },
      })
      await syncWorkflowExecutionRun(source, [], [])
      expect(
        (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.parentRunId
      ).toBeUndefined()
      expect(
        await getDb()
          .executionRunEvents.where("runId")
          .equals("execution:workflow:wf-run-1")
          .toArray()
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              inheritedAuthorityUnavailable: true,
              ownNodeCapsReapplied: true,
            }),
          }),
        ])
      )
    }
  )

  it("inherits the authority of a valid claimed parent", async () => {
    const parent = workflowRun({ id: "parent" })
    await getDb().workflowRuns.put(parent)
    await syncWorkflowExecutionRun(parent, [], [])
    const authority = {
      schemaVersion: 1 as const,
      caps: "explicit-v1" as const,
      permissionMode: "default" as const,
      maxTurns: 3,
    }
    await getDb().executionRuns.update("execution:workflow:parent", { authority })
    await syncWorkflowExecutionRun(
      workflowRun({ lineage: { rootRunId: "parent", parentRunId: "parent" } }),
      [],
      []
    )
    expect(await getDb().executionRuns.get("execution:workflow:wf-run-1")).toMatchObject({
      parentRunId: "execution:workflow:parent",
      authority,
    })
  })

  it("projects UI-triggered runs without fanout subscriptions", async () => {
    const row = workflowRun({
      id: "wf-run-ui",
      triggeredBySource: "ui",
      triggeredBy: undefined,
    })
    await getDb().workflowRuns.put(row)

    startWorkflowExecutionBridge()

    await waitFor(async () => {
      expect(await getDb().executionRuns.get("execution:workflow:wf-run-ui")).toBeDefined()
    })
  })
})

it("refuses a new typed workflow with a missing Host calling run", async () => {
  const { getDb } = await import("@/lib/db/schema")
  const source = workflowRun({
    id: "typed-missing-caller",
    lineage: { rootRunId: "typed-missing-caller", authorityParentRunId: "missing-host-caller" },
  })
  await expect(syncWorkflowExecutionRun(source, [], [])).rejects.toMatchObject({
    reason: "parent_not_found",
  })
  expect(await getDb().executionRuns.get("execution:workflow:typed-missing-caller")).toBeUndefined()
})
