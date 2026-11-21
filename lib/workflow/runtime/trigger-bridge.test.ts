import "fake-indexeddb/auto"
const mockAckFileWatch = jest.fn(async (_w: string, _t: string) => undefined)
jest.mock("./tauri-bridge", () => {
  const actual = jest.requireActual("./tauri-bridge")
  return {
    ...actual,
    ackFileWatch: (w: string, t: string) => mockAckFileWatch(w, t),
  }
})

import { dispatchTrigger, installTriggerBridge, isTriggerEvent } from "./trigger-bridge"
import { dispatchPlacedWorkflowTrigger } from "./placed-trigger"
import { webhookAdmissionAck } from "./webhook-admission"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow, listWorkflowRuns } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type { TriggerEvent } from "@/types/workflow/visual"

jest.setTimeout(15_000)

const dbFixture = createDbTestFixture()

beforeAll(() => dbFixture.initialize())
beforeEach(() => dbFixture.restore())
afterAll(() => dbFixture.dispose())

describe("isTriggerEvent", () => {
  it("accepts a well-formed event", () => {
    expect(
      isTriggerEvent({
        workflowId: "wf",
        kind: "trigger.cron",
        payload: {},
        originAt: 1,
      })
    ).toBe(true)
  })

  it.each([
    ["null", null],
    ["string", "wf"],
    ["missing workflowId", { kind: "trigger.cron", originAt: 0 }],
    ["missing kind", { workflowId: "wf", originAt: 0 }],
    ["missing originAt", { workflowId: "wf", kind: "trigger.cron" }],
    ["non-numeric originAt", { workflowId: "wf", kind: "trigger.cron", originAt: "x" }],
    ["non-string triggerId", { workflowId: "wf", kind: "trigger.cron", triggerId: 7, originAt: 0 }],
    [
      "non-string occurrenceKey",
      { workflowId: "wf", kind: "trigger.webhook", occurrenceKey: 7, originAt: 0 },
    ],
  ])("rejects %s", (_label, value) => {
    expect(isTriggerEvent(value as unknown)).toBe(false)
  })
})

describe("installTriggerBridge file-watch ack", () => {
  async function driveFileWatch(dispatch: jest.Mock) {
    let subscriber: ((raw: unknown) => void) | undefined
    const listen = jest.fn(async (handler: (raw: unknown) => void) => {
      subscriber = handler
      return () => undefined
    })
    const off = await installTriggerBridge({
      listen: listen as never,
      dispatch: dispatch as never,
    })
    await subscriber?.({
      workflowId: "wf1",
      kind: "trigger.file.watch",
      triggerId: "t1",
      payload: {},
      originAt: 1,
    } satisfies TriggerEvent)
    off()
  }

  beforeEach(() => mockAckFileWatch.mockClear())

  it("acks after the run finishes, which is what lifts the daemon's mute", async () => {
    // The mute holds from the fire until this lands, and `dispatch` awaits the
    // whole run, so the mute window strictly contains the run's execution
    // window. That is the self-feed guarantee.
    const order: string[] = []
    const dispatch = jest.fn(async () => {
      order.push("run")
    })
    mockAckFileWatch.mockImplementation(async () => {
      order.push("ack")
    })
    await driveFileWatch(dispatch)
    expect(order).toEqual(["run", "ack"])
    expect(mockAckFileWatch).toHaveBeenCalledWith("wf1", "t1")
  })

  it("acks even when the run fails, so a failure does not strand the watch", async () => {
    const dispatch = jest.fn(async () => {
      throw new Error("the run blew up")
    })
    await driveFileWatch(dispatch)
    expect(mockAckFileWatch).toHaveBeenCalledWith("wf1", "t1")
  })

  it("does not ack for any other trigger kind", async () => {
    let subscriber: ((raw: unknown) => void) | undefined
    const listen = jest.fn(async (handler: (raw: unknown) => void) => {
      subscriber = handler
      return () => undefined
    })
    const off = await installTriggerBridge({
      listen: listen as never,
      dispatch: (async () => undefined) as never,
    })
    await subscriber?.({
      workflowId: "wf1",
      kind: "trigger.cron",
      triggerId: "t1",
      payload: {},
      originAt: 1,
    } satisfies TriggerEvent)
    off()
    expect(mockAckFileWatch).not.toHaveBeenCalled()
  })
})

describe("installTriggerBridge", () => {
  it("discards malformed frames, dispatches valid frames, and disposes the listener", async () => {
    let subscriber: ((raw: unknown) => void) | undefined
    const dispose = jest.fn()
    const listen = jest.fn(async (handler: (raw: unknown) => void) => {
      subscriber = handler
      return dispose
    })
    const dispatch = jest.fn().mockResolvedValue(undefined)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const event: TriggerEvent = {
      workflowId: "workflow-1",
      kind: "trigger.cron",
      payload: {},
      originAt: 1,
    }

    const off = await installTriggerBridge({ listen, dispatch })
    await subscriber?.(null)
    await subscriber?.(event)
    off()

    expect(warn).toHaveBeenCalledWith("workflow trigger bridge: discarding malformed event", null)
    expect(dispatch).toHaveBeenCalledWith(event)
    expect(dispose).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("contains listener dispatch failures", async () => {
    let subscriber: ((raw: unknown) => void) | undefined
    const listen = jest.fn(async (handler: (raw: unknown) => void) => {
      subscriber = handler
      return jest.fn()
    })
    const dispatch = jest.fn().mockRejectedValue("offline")
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)

    await installTriggerBridge({ listen, dispatch })
    await subscriber?.({
      workflowId: "workflow-1",
      kind: "trigger.webhook",
      payload: {},
      originAt: 1,
    })

    expect(error).toHaveBeenCalledWith(
      "workflow trigger bridge: dispatch failed",
      expect.objectContaining({ workflowId: "workflow-1", error: "offline" })
    )
    error.mockRestore()
  })
})

describe("dispatchTrigger", () => {
  it("routes the canonical trigger ingress through placement with a durable key", async () => {
    const dispatchPlaced = jest
      .fn()
      .mockResolvedValue({ kind: "remote", dispatchId: "dispatch-1", targetRef: "cloud-a" })
    const trigger: TriggerEvent = {
      workflowId: "workflow-remote",
      kind: "trigger.cron",
      triggerId: "cron-1",
      payload: { scheduledAt: 100 },
      originAt: 100,
    }

    await dispatchTrigger(trigger, { triggeredBy: { source: "schedule" } }, { dispatchPlaced })

    expect(dispatchPlaced).toHaveBeenCalledWith(
      expect.objectContaining({
        event: trigger,
        triggeredBy: { source: "schedule" },
        idempotencyKey: expect.any(String),
      })
    )
  })

  it("keys a webhook on its delivery id, and leaves one without an id unkeyed", async () => {
    const dispatchPlaced = jest.fn().mockResolvedValue({ kind: "local" })
    const base: TriggerEvent = {
      workflowId: "workflow-hook",
      kind: "trigger.webhook",
      triggerId: "hook-1",
      payload: {},
      originAt: 1_700_000_000_100,
    }

    await dispatchTrigger(base, undefined, { dispatchPlaced })
    await dispatchTrigger({ ...base, originAt: 1_700_000_000_200 }, undefined, { dispatchPlaced })
    await dispatchTrigger({ ...base, occurrenceKey: "guid-1" }, undefined, { dispatchPlaced })

    const keys = dispatchPlaced.mock.calls.map(([input]) => input.idempotencyKey)
    // Same second, no delivery id: two runs, neither able to absorb the other.
    expect(keys[0]).toBeUndefined()
    expect(keys[1]).toBeUndefined()
    expect(keys[2]).toBe("trg:workflow-hook:hook-1:occ:guid-1")
  })

  it("propagates unexpected placement failures for triggers without an embedded id", async () => {
    const dispatchPlaced = jest.fn().mockRejectedValue(new Error("placement unavailable"))

    await expect(
      dispatchTrigger(
        {
          workflowId: "workflow-error",
          kind: "trigger.webhook",
          payload: "legacy-non-object" as never,
          originAt: 100,
        },
        undefined,
        { dispatchPlaced }
      )
    ).rejects.toThrow("placement unavailable")
  })

  it("runs a workflow from its real cron trigger node", async () => {
    const wf = await createWorkflow({
      name: "cron workflow",
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "cron", params: { cron: "* * * * *" } },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "set", params: { variable: "x", value: 1 } },
        },
      ],
      edges: [{ id: "e1", source: "n_cron", target: "n_set" }],
    })
    await publishWorkflow(wf.id, 1)

    await dispatchTrigger({
      workflowId: wf.id,
      kind: "trigger.cron",
      payload: { triggerId: "n_cron" },
      originAt: Date.now(),
    })

    const [run] = await listWorkflowRuns({ workflowId: wf.id })
    expect(run.status).toBe("succeeded")
  })

  it("activates only the trigger node identified by a legacy Rust payload", async () => {
    const wf = await createWorkflow({
      name: "multi-trigger workflow",
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "cron", params: { cron: "* * * * *" } },
        },
        {
          id: "n_other_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 200 },
          data: { label: "other cron", params: { cron: "0 * * * *" } },
        },
        {
          id: "n_cron_out",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "cron output", params: { variable: "branch", value: "cron" } },
        },
        {
          id: "n_other_cron_out",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 200 },
          data: { label: "other output", params: { variable: "branch", value: "other" } },
        },
      ],
      edges: [
        { id: "e_cron", source: "n_cron", target: "n_cron_out" },
        { id: "e_other", source: "n_other_cron", target: "n_other_cron_out" },
      ],
    })
    await publishWorkflow(wf.id, 1)

    await dispatchTrigger({
      workflowId: wf.id,
      kind: "trigger.cron",
      payload: { triggerId: "n_cron" },
      originAt: Date.now(),
    })

    const [run] = await listWorkflowRuns({ workflowId: wf.id })
    expect(run.output).toEqual({ variable: "branch", value: "cron" })
    expect(run.triggerId).toBe("n_cron")
  })

  it("ignores a stale trigger id instead of running another workflow root", async () => {
    const wf = await createWorkflow({
      name: "stale trigger workflow",
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "cron", params: { cron: "* * * * *" } },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)

    await dispatchTrigger({
      workflowId: wf.id,
      kind: "trigger.cron",
      triggerId: "n_deleted",
      payload: {},
      originAt: Date.now(),
    })

    expect(await listWorkflowRuns({ workflowId: wf.id })).toEqual([])
  })

  it("runs the workflow when the id resolves", async () => {
    const wf = await createWorkflow({
      name: "x",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "set", params: { variable: "x", value: 1 } },
        },
      ],
      edges: [{ id: "e1", source: "n_start", target: "n_set" }],
    })
    await publishWorkflow(wf.id, 1)
    const trigger: TriggerEvent = {
      workflowId: wf.id,
      kind: "trigger.cron",
      payload: { firedAt: 0 },
      originAt: Date.now(),
    }
    await dispatchTrigger(trigger)
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(1)
    expect(runs[0].workflowId).toBe(wf.id)
    expect(runs[0].triggerKind).toBe("trigger.cron")
    expect(runs[0].status).toBe("succeeded")
  })

  it("persists opts.triggeredBy onto the run row (ADR-0060)", async () => {
    const wf = await createWorkflow({
      name: "x",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)
    await dispatchTrigger(
      { workflowId: wf.id, kind: "trigger.manual", payload: {}, originAt: Date.now() },
      { triggeredBy: { source: "api", deviceId: "dev-42" } }
    )
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(1)
    expect(runs[0].triggeredBy).toEqual({ source: "api", deviceId: "dev-42" })
    expect(runs[0].triggeredBySource).toBe("api")
  })

  it("records an automatic trigger occurrence as source trigger, not ui (WF-22)", async () => {
    const wf = await createWorkflow({
      name: "cron origin",
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "cron", params: { cron: "* * * * *" } },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)
    await dispatchTrigger({
      workflowId: wf.id,
      kind: "trigger.cron",
      triggerId: "n_cron",
      payload: {},
      originAt: 5,
    })
    const [run] = await getDb().workflowRuns.toArray()
    expect(run.triggeredBy).toEqual({ source: "trigger" })
    expect(run.triggeredBySource).toBe("trigger")
  })

  it("fails a risky ungated node closed on an automatic trigger instead of waiting (WF-22)", async () => {
    const wf = await createWorkflow({
      name: "risky cron",
      nodes: [
        {
          id: "n_cron",
          type: "trigger.cron",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "cron", params: { cron: "* * * * *" } },
        },
        {
          id: "n_send",
          type: "action.connector.send",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "send",
            params: { adapterId: "lark", conversationKey: "c", content: "hi" },
          },
        },
      ],
      edges: [{ id: "e1", source: "n_cron", target: "n_send" }],
    })
    await getDb().workflows.update(wf.id, {
      settings: { ...(await getDb().workflows.get(wf.id))!.settings, riskGating: true },
    })
    await publishWorkflow(wf.id, 1)
    await dispatchTrigger({
      workflowId: wf.id,
      kind: "trigger.cron",
      triggerId: "n_cron",
      payload: {},
      originAt: 6,
    })
    const [run] = await getDb().workflowRuns.toArray()
    expect(run.status).toBe("failed")
    expect(run.error?.message).toContain("source=trigger")
    expect(await getDb().workflowWaitpoints.count()).toBe(0)
  })

  it("preserves trigger binding and origin time on the run", async () => {
    const wf = await createWorkflow({
      name: "bound trigger",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)

    await dispatchTrigger({
      workflowId: wf.id,
      kind: "trigger.manual",
      payload: {},
      originAt: 1234,
      binding: {
        adapterId: "lark",
        sessionId: "session-1",
        conversationKey: "chat-1",
        sourceMessageId: "message-1",
      },
    })

    const [run] = await listWorkflowRuns({ workflowId: wf.id })
    expect(run.triggerBinding).toEqual({
      adapterId: "lark",
      sessionId: "session-1",
      conversationKey: "chat-1",
      sourceMessageId: "message-1",
    })
    expect((run as typeof run & { triggerOriginAt?: number }).triggerOriginAt).toBe(1234)
  })

  it("fires the onWorkflowTriggerFired plugin hook before running", async () => {
    const wf = await createWorkflow({
      name: "x",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)
    const spy = jest.spyOn(getPluginEventHooks(), "dispatchWorkflowTriggerFired")
    const payload = { firedAt: 7 }
    await dispatchTrigger({ workflowId: wf.id, kind: "trigger.cron", payload, originAt: 1 })
    expect(spy).toHaveBeenCalledWith(wf.id, "trigger.cron", payload)
    spy.mockRestore()
  })

  it("does not throw when the workflow is missing", async () => {
    const trigger: TriggerEvent = {
      workflowId: "wf_does_not_exist",
      kind: "trigger.cron",
      payload: {},
      originAt: Date.now(),
    }
    await expect(dispatchTrigger(trigger)).resolves.toBeUndefined()
    const runs = await getDb().workflowRuns.toArray()
    expect(runs).toEqual([])
  })
})

describe("dispatchTrigger webhook admission receipts (WF-08)", () => {
  async function publishedWebhookWorkflow() {
    const wf = await createWorkflow({
      name: "hook",
      nodes: [
        {
          id: "n_hook",
          type: "trigger.webhook",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "hook", params: { path: "hook" } },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)
    return wf
  }

  function hookEvent(
    workflowId: string,
    admissionId: string,
    occurrenceKey?: string
  ): TriggerEvent {
    return {
      workflowId,
      kind: "trigger.webhook",
      triggerId: "n_hook",
      originAt: 10,
      ...(occurrenceKey ? { occurrenceKey } : {}),
      payload: { method: "POST", path: "hook", body: {}, admissionId },
    }
  }

  function depsWith(respond: jest.Mock) {
    return {
      dispatchPlaced: dispatchPlacedWorkflowTrigger,
      admissionAck: (event: TriggerEvent) => webhookAdmissionAck(event, respond),
    }
  }

  it("acknowledges the reserved run id before the run finishes", async () => {
    const wf = await publishedWebhookWorkflow()
    const respond = jest.fn().mockResolvedValue(true)
    await dispatchTrigger(hookEvent(wf.id, "wha_1"), undefined, depsWith(respond))
    const [run] = await getDb().workflowRuns.toArray()
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith("wha_1", {
      status: 202,
      body: "",
      headers: { "x-cognia-run-id": run.id },
    })
  })

  it("acknowledges a redelivery with the same delivery id with the same run", async () => {
    const wf = await publishedWebhookWorkflow()
    const respond = jest.fn().mockResolvedValue(true)
    await dispatchTrigger(hookEvent(wf.id, "wha_1", "delivery-1"), undefined, depsWith(respond))
    await dispatchTrigger(hookEvent(wf.id, "wha_2", "delivery-1"), undefined, depsWith(respond))
    const runs = await getDb().workflowRuns.toArray()
    expect(runs).toHaveLength(1)
    expect(respond.mock.calls.map(([id, reply]) => [id, reply.headers["x-cognia-run-id"]])).toEqual(
      [
        ["wha_1", runs[0].id],
        ["wha_2", runs[0].id],
      ]
    )
  })

  it("returns a refusal to the sender instead of a success when the workflow is not deployed", async () => {
    const respond = jest.fn().mockResolvedValue(true)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    await dispatchTrigger(hookEvent("wf_missing", "wha_9"), undefined, depsWith(respond))
    warn.mockRestore()
    expect(respond).toHaveBeenCalledTimes(1)
    const [id, reply] = respond.mock.calls[0]
    expect(id).toBe("wha_9")
    expect(reply.status).toBe(404)
    expect(JSON.parse(reply.body).code).toBe("deployment-not-found")
    expect(await getDb().workflowRuns.count()).toBe(0)
  })

  it("sends nothing for an event that did not come from a held webhook request", async () => {
    const wf = await publishedWebhookWorkflow()
    const respond = jest.fn().mockResolvedValue(true)
    const event = hookEvent(wf.id, "wha_x")
    await dispatchTrigger(
      { ...event, payload: { method: "POST", path: "hook", body: {} } },
      undefined,
      depsWith(respond)
    )
    expect(respond).not.toHaveBeenCalled()
  })
})
