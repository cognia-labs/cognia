/** @jest-environment node */
import type { StepExecutionContext, WorkflowTriggerBinding } from "@/types/workflow/visual"
import { workflowSquadSurface } from "./workflow-squad-surface"

function ctx(binding?: WorkflowTriggerBinding, payload: Record<string, unknown> = {}) {
  return {
    runId: "run_outer",
    trigger: {
      workflowId: "wf",
      kind: "trigger.manual",
      payload,
      originAt: 1,
      ...(binding ? { binding } : {}),
    },
  } as unknown as StepExecutionContext
}
const none = { resolveKnowledgeAccess: async () => undefined }

describe("workflowSquadSurface", () => {
  it("makes the workflow run the parent and adds nothing it was not given", async () => {
    await expect(workflowSquadSurface(ctx(), none)).resolves.toEqual({
      kind: "workflow",
      workflowRunId: "run_outer",
    })
  })

  it("reports back to the IM conversation only a complete binding names", async () => {
    await expect(
      workflowSquadSurface(
        ctx({ adapterId: "lark:a1", conversationKey: "lark:a1:oc_1", sessionId: "s1" }),
        none
      )
    ).resolves.toMatchObject({
      conversation: { adapterId: "lark:a1", conversationKey: "lark:a1:oc_1", sessionId: "s1" },
    })
    await expect(
      workflowSquadSurface(ctx({ adapterId: "lark:a1" }), none)
    ).resolves.not.toHaveProperty("conversation")
    await expect(
      workflowSquadSurface(ctx({ conversationKey: "lark:a1:oc_1" }), none)
    ).resolves.not.toHaveProperty("conversation")
  })

  it("carries a numeric fan-out depth and the workflow's knowledge grant", async () => {
    const grant = { entrypoint: "manual", revisionBindings: {}, allowedKnowledgeBaseIds: [] }
    const resolveKnowledgeAccess = jest.fn(async () => grant as never)
    const context = ctx(undefined, { chainDepth: 3 })
    await expect(workflowSquadSurface(context, { resolveKnowledgeAccess })).resolves.toEqual({
      kind: "workflow",
      workflowRunId: "run_outer",
      knowledgeAccess: grant,
      triggerChainDepth: 3,
    })
    expect(resolveKnowledgeAccess).toHaveBeenCalledWith(context)
    await expect(
      workflowSquadSurface(ctx(undefined, { chainDepth: "3" }), none)
    ).resolves.not.toHaveProperty("triggerChainDepth")
  })
})
