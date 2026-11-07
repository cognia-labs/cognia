/**
 * The workflow module's tool family (ADR-0250 §14 amendment): the typed
 * runner, `wf_run_workflow_typed`, which runs a published workflow as one
 * typed call.
 *
 * The `cognia-workflow-ai` plugin registers the runner with the rest of its
 * `wf_*` suite; this family is its stand-in for the two kinds of run that
 * must have it whether or not that plugin is enabled:
 *
 * - a run with a graph-bodied skill (`kind: "workflow"`), whose body tells
 *   the model to call the runner;
 * - a run at the `ultracode` thinking tier, which promises the dynamic
 *   workflow suite (the send resolver re-attaches the plugin's own `wf_*`
 *   entries when it is enabled).
 *
 * The manifest declares it `precedence: "fallback"`, so the plugin's own
 * registration answers first when it exists, and the send resolver keeps the
 * plugin's entry over this one by name. An agent with plugin tools switched
 * off is not offered it, as before.
 */

import {
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "@cognia/plugin-contract/lib/workflow/publish/runner-tool"
import {
  isUltracodeLevel,
  resolveThinkingLevel,
} from "@cognia/plugin-contract/lib/ai/thinking-level"
import type {
  ModuleToolEntry,
  ModuleToolFamily,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"

export { WORKFLOW_RUNNER_TOOL_NAME }

/** The runner's manifest entry: the plugin's own contract, so the two never drift. */
export function buildWorkflowRunnerToolEntry(): ModuleToolEntry {
  return {
    name: WORKFLOW_RUNNER_TOOL_NAME,
    description: WORKFLOW_RUNNER_TOOL_DEFINITION.description,
    jsonSchema: WORKFLOW_RUNNER_TOOL_DEFINITION.parametersSchema,
  }
}

/** Whether a run is offered the runner. */
export function workflowRunnerOffered(ctx: ToolSurfaceContext): boolean {
  if (ctx.agent?.disablePluginTools) return false
  if (ctx.skills?.some((skill) => skill.kind === "workflow")) return true
  return isUltracodeLevel(resolveThinkingLevel(ctx.session))
}

export const toolFamily: ModuleToolFamily = {
  surface: (ctx) =>
    workflowRunnerOffered(ctx) ? { tools: [buildWorkflowRunnerToolEntry()] } : null,
  async run(name, args) {
    if (name !== WORKFLOW_RUNNER_TOOL_NAME)
      return {
        ok: false,
        error: { code: "unknown-tool", message: `unknown workflow tool: ${name}` },
      }
    const { executeRunWorkflowTyped } = await import("./publish/run-workflow-typed-tool")
    return executeRunWorkflowTyped(args)
  },
}
