/**
 * A Copilot request handed to the editor that is about to open a workflow.
 *
 * "Open as workflow" on a skill without `references/flow.yaml` creates an
 * empty workflow and asks the Copilot to draft it from the skill (ADR-0254
 * §2). The request is prepared before the editor exists, so it waits here,
 * keyed by workflow id, until that editor mounts and takes it. Kept in memory
 * on purpose: a reload must not send the draft request a second time.
 */

const pending = new Map<string, string>()

export function queueCopilotRequest(workflowId: string, prompt: string): void {
  pending.set(workflowId, prompt)
}

/** The waiting request for this workflow, removed as it is read. */
export function takeCopilotRequest(workflowId: string): string | undefined {
  const prompt = pending.get(workflowId)
  pending.delete(workflowId)
  return prompt
}
