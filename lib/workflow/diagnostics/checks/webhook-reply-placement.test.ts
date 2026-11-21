import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowNode,
} from "@/types/workflow/visual"
import { collectWorkflowPublishProblems } from "@/lib/workflow/publish/publish-validation"
import { runDiagnostics } from "../engine"
import { checkWebhookReplyPlacement } from "./webhook-reply-placement"

function node(id: string, type: string, disabled = false): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: {}, ...(disabled ? { disabled: true } : {}) },
  }
}

function workflow(
  runOn: VisualWorkflow["settings"]["runOn"],
  nodes: WorkflowNode[] = [node("hook", "trigger.webhook"), node("reply", "io.webhook.respond")]
): VisualWorkflow {
  return {
    id: "wf-1",
    schemaVersion: 2,
    name: "Hook",
    createdAt: 1,
    updatedAt: 1,
    nodes,
    edges: [],
    settings: { ...DEFAULT_WORKFLOW_SETTINGS, runOn },
  }
}

describe("checkWebhookReplyPlacement (WF-09)", () => {
  it("refuses a pin to another Host when the run must reply to its webhook caller", () => {
    expect(
      checkWebhookReplyPlacement(workflow({ mode: "pinned", ref: "host_b" }), "host_a")
    ).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "webhookReplyPinnedRemote",
        nodeId: "reply",
        messageKey: "workflows.diagnostics.webhookReplyPinnedRemote",
        messageParams: { ref: "host_b" },
      }),
    ])
  })

  it("allows colocate, auto, and a pin to local or to this Host itself", () => {
    expect(checkWebhookReplyPlacement(workflow({ mode: "colocate" }), "host_a")).toEqual([])
    expect(checkWebhookReplyPlacement(workflow({ mode: "auto" }), "host_a")).toEqual([])
    expect(checkWebhookReplyPlacement(workflow(undefined), "host_a")).toEqual([])
    expect(
      checkWebhookReplyPlacement(workflow({ mode: "pinned", ref: "local" }), "host_a")
    ).toEqual([])
    expect(
      checkWebhookReplyPlacement(workflow({ mode: "pinned", ref: "host_a" }), "host_a")
    ).toEqual([])
  })

  it("ignores a pinned workflow that never holds a webhook request open", () => {
    const pinned = { mode: "pinned" as const, ref: "host_b" }
    // No reply node: the receiver answers on admission, so the run may move.
    expect(
      checkWebhookReplyPlacement(workflow(pinned, [node("hook", "trigger.webhook")]), "host_a")
    ).toEqual([])
    // No armed webhook trigger: nothing is ever held.
    expect(
      checkWebhookReplyPlacement(
        workflow(pinned, [
          node("hook", "trigger.webhook", true),
          node("reply", "io.webhook.respond"),
        ]),
        "host_a"
      )
    ).toEqual([])
  })

  it("reaches the Problems panel and the publish gate through the engine", () => {
    const pinned = workflow({ mode: "pinned", ref: "host_b" })
    const expected = expect.objectContaining({ code: "webhookReplyPinnedRemote", nodeId: "reply" })
    expect(runDiagnostics({ workflow: pinned, isWeb: false }).diagnostics).toContainEqual(expected)
    expect(collectWorkflowPublishProblems(pinned)).toContainEqual(expected)
    expect(collectWorkflowPublishProblems(workflow({ mode: "colocate" }))).not.toContainEqual(
      expected
    )
  })
})
