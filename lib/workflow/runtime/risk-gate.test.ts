import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflowWaitpoint, decideWorkflowWaitpoint } from "@/lib/db/workflow-waitpoints"
import { appendEvent } from "./event-log"
import { approvalId, listPendingApprovals, respondToApproval } from "./approval-registry"
import {
  RISK_GATE_CHECKPOINT_KEY,
  RiskGateRejected,
  applyNodeRiskGate,
  gatingAncestorsOf,
  hasApprovedAncestor,
  isInteractiveRun,
  isRiskGatingEnabled,
} from "./risk-gate"

const notifyRequested = jest.fn().mockResolvedValue(undefined)
jest.mock("./approval-notify", () => ({
  notifyApprovalRequested: (...a: unknown[]) => notifyRequested(...a),
  notifyApprovalResolved: jest.fn(),
}))

// Overridable seams for the failure branches. `null` = delegate to the real
// implementation, so every other test in this file exercises the real thing.
const seam: {
  waitForWaitpoint: null | ((...args: unknown[]) => Promise<unknown>)
  listRunEvents: null | (() => Promise<unknown>)
  appendEvent: null | (() => Promise<unknown>)
} = { waitForWaitpoint: null, listRunEvents: null, appendEvent: null }

jest.mock("./waitpoint-repository", () => {
  const actual = jest.requireActual("./waitpoint-repository")
  return {
    ...actual,
    waitForWorkflowWaitpoint: (...a: unknown[]) =>
      seam.waitForWaitpoint ? seam.waitForWaitpoint(...a) : actual.waitForWorkflowWaitpoint(...a),
  }
})

jest.mock("./event-log", () => {
  const actual = jest.requireActual("./event-log")
  return {
    ...actual,
    listRunEvents: (...a: unknown[]) =>
      seam.listRunEvents ? seam.listRunEvents() : actual.listRunEvents(...a),
    appendEvent: (...a: unknown[]) =>
      seam.appendEvent ? seam.appendEvent() : actual.appendEvent(...a),
  }
})

const node = (id: string, type: string): WorkflowNode =>
  ({ id, type, typeVersion: 1, position: { x: 0, y: 0 }, params: {} }) as unknown as WorkflowNode

const workflow = (over: Partial<VisualWorkflow> = {}): VisualWorkflow =>
  ({
    id: "wf1",
    schemaVersion: 2,
    name: "W",
    nodes: [node("n1", "action.desktop.performAction")],
    edges: [],
    settings: { riskGating: true },
    ...over,
  }) as unknown as VisualWorkflow

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  notifyRequested.mockClear()
  seam.waitForWaitpoint = null
  seam.listRunEvents = null
  seam.appendEvent = null
  for (const p of await listPendingApprovals())
    await respondToApproval(p.approvalId, {
      decision: "rejected",
      respondedBy: "cleanup",
    })
})
afterAll(dbFixture.dispose)

describe("isRiskGatingEnabled — migration decision", () => {
  it("is OFF for a workflow with no field (authored before ADR-0070)", () => {
    // Opt-in by design: flipping this on retroactively would start failing
    // automations users already rely on.
    expect(isRiskGatingEnabled({ settings: {} } as never)).toBe(false)
  })

  it("is ON only when explicitly true", () => {
    expect(isRiskGatingEnabled({ settings: { riskGating: true } } as never)).toBe(true)
    expect(isRiskGatingEnabled({ settings: { riskGating: false } } as never)).toBe(false)
  })
})

describe("isInteractiveRun", () => {
  it("treats an absent trigger as a plain UI run", () => {
    expect(isInteractiveRun(undefined)).toBe(true)
  })

  it.each(["ui", "desktop", "chat"] as const)("%s is interactive", (source) => {
    expect(isInteractiveRun({ source } as never)).toBe(true)
  })

  it.each(["im", "api", "trigger"] as const)("%s is headless", (source) => {
    expect(isInteractiveRun({ source } as never)).toBe(false)
  })
})

describe("hasApprovedAncestor", () => {
  const wf = workflow({
    nodes: [
      node("a", "action.approval.request"),
      node("b", "flow.set"),
      node("risky", "action.desktop.performAction"),
      node("orphan", "action.system.terminal"),
    ],
    edges: [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "risky" },
    ] as never,
  })

  it("trusts an approval node transitively upstream that this run approved", () => {
    expect(hasApprovedAncestor(wf, "risky", new Set(["a"]))).toBe(true)
  })

  it("does not trust an upstream approval this run did not approve", () => {
    // Rejected, timed out or never executed (a skipped branch): the graph says
    // an approval is upstream, but nobody approved this execution.
    expect(hasApprovedAncestor(wf, "risky", new Set())).toBe(false)
  })

  it("returns false for a node with no approval ancestor", () => {
    expect(hasApprovedAncestor(wf, "orphan", new Set(["a"]))).toBe(false)
  })

  it("counts an approval before a loop as gating the loop's body", () => {
    const looped = workflow({
      nodes: [
        node("gate", "action.approval.request"),
        node("loop", "flow.loop"),
        { ...node("inner", "action.system.terminal"), parentId: "loop" } as WorkflowNode,
      ],
      edges: [{ id: "e1", source: "gate", target: "loop" }] as never,
    })
    expect(gatingAncestorsOf(looped, "inner")).toEqual(new Set(["loop", "gate"]))
    expect(hasApprovedAncestor(looped, "inner", new Set(["gate"]))).toBe(true)
  })
})

describe("applyNodeRiskGate", () => {
  it("returns immediately for a low-risk node — no registry entry, no checkpoint", async () => {
    await applyNodeRiskGate({
      workflow: workflow({ nodes: [node("n1", "flow.set")] }),
      node: node("n1", "flow.set"),
      runId: "r1",
      approvedApprovalIds: new Set(),
    })
    await expect(listPendingApprovals()).resolves.toHaveLength(0)
    expect(notifyRequested).not.toHaveBeenCalled()
  })

  it("returns immediately when the workflow has gating off", async () => {
    await applyNodeRiskGate({
      workflow: workflow({ settings: { riskGating: false } } as never),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
    })
    await expect(listPendingApprovals()).resolves.toHaveLength(0)
  })

  it("does not double-gate a node already covered by an approval this run approved", async () => {
    const wf = workflow({
      nodes: [node("a", "action.approval.request"), node("n1", "action.desktop.performAction")],
      edges: [{ id: "e1", source: "a", target: "n1" }] as never,
    })
    await applyNodeRiskGate({
      workflow: wf,
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(["a"]),
    })
    expect(notifyRequested).not.toHaveBeenCalled()
  })

  it("still gates when the upstream approval node was not approved in this run", async () => {
    const wf = workflow({
      nodes: [node("a", "action.approval.request"), node("n1", "action.desktop.performAction")],
      edges: [{ id: "e1", source: "a", target: "n1", sourceHandle: "rejected" }] as never,
    })
    const gate = applyNodeRiskGate({
      workflow: wf,
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
    })
    await new Promise((r) => setTimeout(r, 20))
    const pending = await listPendingApprovals()
    expect(pending).toHaveLength(1)
    await respondToApproval(pending[0].approvalId, { decision: "rejected", respondedBy: "alice" })
    await expect(gate).rejects.toThrow(RiskGateRejected)
  })

  it("asks once per loop iteration, never reusing an earlier iteration's answer", async () => {
    const first = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
      stepKey: "loop#0#n1",
    })
    await new Promise((r) => setTimeout(r, 20))
    const [request0] = await listPendingApprovals()
    expect(request0.approvalId).toBe(approvalId("r1", "loop#0#n1"))
    await respondToApproval(request0.approvalId, { decision: "approved", respondedBy: "alice" })
    await expect(first).resolves.toBeUndefined()

    const second = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
      stepKey: "loop#1#n1",
    })
    await new Promise((r) => setTimeout(r, 20))
    const pending = await listPendingApprovals()
    expect(pending.map((p) => p.approvalId)).toEqual([approvalId("r1", "loop#1#n1")])
    expect(notifyRequested).toHaveBeenCalledTimes(2)
    await respondToApproval(pending[0].approvalId, { decision: "rejected", respondedBy: "alice" })
    await expect(second).rejects.toThrow(/rejected by alice/)
  })

  it("fails closed on a headless run, naming the surfaces", async () => {
    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
        triggeredBy: { source: "im", adapterId: "a", conversationKey: "c" } as never,
      })
    ).rejects.toThrow(RiskGateRejected)

    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
        triggeredBy: { source: "im", adapterId: "a", conversationKey: "c" } as never,
      })
    ).rejects.toThrow(/computer-use/)
    // Fail-closed means it never registered a modal nobody would see.
    await expect(listPendingApprovals()).resolves.toHaveLength(0)
  })

  it("blocks interactively, then proceeds once approved", async () => {
    const p = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
    })
    await new Promise((r) => setTimeout(r, 20))
    const pending = await listPendingApprovals()
    expect(pending).toHaveLength(1)
    expect(pending[0].message).toMatch(/computer-use/)
    expect(notifyRequested).toHaveBeenCalledTimes(1)

    await respondToApproval(pending[0].approvalId, {
      decision: "approved",
      respondedBy: "alice",
    })
    await expect(p).resolves.toBeUndefined()
    // The entry is always cleaned up.
    await expect(listPendingApprovals()).resolves.toHaveLength(0)
  })

  it("throws when the human rejects", async () => {
    const p = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
    })
    await new Promise((r) => setTimeout(r, 20))
    const pending = await listPendingApprovals()
    await respondToApproval(pending[0].approvalId, {
      decision: "rejected",
      respondedBy: "alice",
    })
    await expect(p).rejects.toThrow(/rejected by alice/)
  })

  it("re-arms after a crash-resume WITHOUT re-notifying", async () => {
    // Mirror of the approval node's resume contract: a re-entered step must not
    // push the human a second copy of a question they already have.
    await appendEvent({
      runId: "r1",
      stepId: "n1",
      type: "step.long_running.checkpoint",
      payload: {
        checkpointKey: RISK_GATE_CHECKPOINT_KEY,
        state: { approvalId: approvalId("r1", "n1"), requestedAt: Date.now() },
      },
    })
    const p = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
      approvedApprovalIds: new Set(),
    })
    await new Promise((r) => setTimeout(r, 20))
    await expect(listPendingApprovals()).resolves.toHaveLength(1)
    expect(notifyRequested).not.toHaveBeenCalled()

    const pending = await listPendingApprovals()
    await respondToApproval(pending[0].approvalId, { decision: "approved", respondedBy: "bob" })
    await expect(p).resolves.toBeUndefined()
  })

  describe("failure branches", () => {
    it("treats an unreadable event log as a fresh gate rather than crashing", async () => {
      seam.listRunEvents = () => Promise.reject(new Error("no event log"))
      const p = applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
      })
      await new Promise((r) => setTimeout(r, 20))
      const pending = await listPendingApprovals()
      expect(pending).toHaveLength(1)
      await respondToApproval(pending[0].approvalId, {
        decision: "approved",
        respondedBy: "alice",
      })
      await expect(p).resolves.toBeUndefined()
    })

    it("still gates when the checkpoint cannot be persisted", async () => {
      // Losing crash-resumability is bad; silently skipping the gate is worse.
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      seam.appendEvent = () => Promise.reject(new Error("disk full"))
      const p = applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
      })
      await new Promise((r) => setTimeout(r, 20))
      const pending = await listPendingApprovals()
      expect(pending).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
      await respondToApproval(pending[0].approvalId, {
        decision: "approved",
        respondedBy: "alice",
      })
      await expect(p).resolves.toBeUndefined()
      warn.mockRestore()
    })

    it("rejects when the wait times out", async () => {
      seam.waitForWaitpoint = async (id) => {
        const result = await decideWorkflowWaitpoint(String(id), {
          outcome: "timed_out",
          respondedBy: "timeout",
          resolvedAt: Date.now(),
        })
        if (!result.ok) throw new Error(result.reason)
        return result.waitpoint
      }
      await expect(
        applyNodeRiskGate({
          workflow: workflow(),
          node: node("n1", "action.desktop.performAction"),
          runId: "r1",
          approvedApprovalIds: new Set(),
        })
      ).rejects.toThrow(/timed out unanswered/)
      await expect(listPendingApprovals()).resolves.toHaveLength(0)
    })

    it("propagates a non-timeout wake error unchanged (e.g. run cancelled)", async () => {
      const controller = new AbortController()
      const run = applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
        signal: controller.signal,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      await expect(run).rejects.toThrow(/cancelled/)
      // An abort is not a rejection — it must not masquerade as one.
      await expect(listPendingApprovals()).resolves.toHaveLength(0)
    })
  })

  it("rejects rather than passing when the original budget expired unanswered", async () => {
    await appendEvent({
      runId: "r1",
      stepId: "n1",
      type: "step.long_running.checkpoint",
      payload: {
        checkpointKey: RISK_GATE_CHECKPOINT_KEY,
        state: { approvalId: approvalId("r1", "n1"), requestedAt: Date.now() - 7_200_000 },
      },
    })
    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
      })
    ).rejects.toThrow(/timed out unanswered/)
  })

  it("honours an approval persisted before the deadline when re-entered after it", async () => {
    const id = approvalId("r1", "n1")
    const requestedAt = Date.now() - 7_200_000
    await appendEvent({
      runId: "r1",
      stepId: "n1",
      type: "step.long_running.checkpoint",
      payload: { checkpointKey: RISK_GATE_CHECKPOINT_KEY, state: { approvalId: id, requestedAt } },
    })
    // The process died after this approval was stored, 30 minutes before the
    // 1 h deadline; the run is re-entered an hour after the deadline.
    await createWorkflowWaitpoint({
      id,
      kind: "risk_gate",
      status: "pending",
      runId: "r1",
      workflowId: "wf1",
      stepId: "n1",
      key: "approval:r1:n1",
      createdAt: requestedAt,
      notBefore: requestedAt,
      expiresAt: requestedAt + 3_600_000,
      updatedAt: requestedAt,
    })
    const decided = await decideWorkflowWaitpoint(id, {
      outcome: "approved",
      respondedBy: "alice",
      resolvedAt: requestedAt + 1_800_000,
    })
    expect(decided.ok).toBe(true)

    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        approvedApprovalIds: new Set(),
      })
    ).resolves.toBeUndefined()
  })
})
