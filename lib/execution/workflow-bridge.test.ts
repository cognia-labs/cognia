/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const stopAgentStateBridge = jest.fn()
jest.mock("./agent-state-bridge", () => ({
  startAgentStateExecutionBridge: jest.fn(() => stopAgentStateBridge),
}))

import { waitFor } from "@testing-library/dom"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetWorkflowExecutionBridgeForTesting,
  executionKindForWorkflowRun,
  startWorkflowExecutionBridge,
  syncWorkflowExecutionRun,
} from "./workflow-bridge"
import type { WorkflowRunRow } from "@/types/workflow/visual"

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
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: "step-1",
          type: "ai.prompt",
          typeVersion: 1,
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

  it("records a scheduled workflow's resolved ceiling without inventing its authorizer", async () => {
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
    expect(run?.authority).toEqual({
      schemaVersion: 1,
      permissionMode: "plan",
      tools: { allow: ["Read"], deny: ["Bash"] },
      mcpServers: { only: ["docs"] },
    })
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

  it("links a retry to the run it replaced, from the lineage the row already carries", async () => {
    // A retry is a replacement, not a stranger. Deriving the link here — rather
    // than coordinating with whoever pressed the button — is what makes a retry
    // driven from the desktop history view join the same chain as one driven
    // through the run-control gate.
    await syncWorkflowExecutionRun(workflowRun(), [], [])
    await syncWorkflowExecutionRun(
      workflowRun({
        id: "wf-run-2",
        lineage: {
          rootRunId: "wf-run-1",
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
    // A first run is a root, and must not gain a parent it never had.
    expect(
      (await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.parentRunId
    ).toBeUndefined()
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
