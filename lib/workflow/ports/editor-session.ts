// The workflow module's implementation of the `workflow-editor-session` port
// (`types/modules/ports/workflow-editor-session.ts`, ADR-0250 §14): the
// Workflow Copilot a conversation in the visual workflow editor runs as.

import type {
  WorkflowEditorSessionPort,
  WorkflowEditorSessionSetup,
} from "@/types/modules/ports/workflow-editor-session"
import {
  buildWorkflowCopilotPrompt,
  WORKFLOW_COPILOT_ALLOWED_TOOLS,
  WORKFLOW_COPILOT_DISALLOWED_TOOLS,
} from "../editor/copilot-prompts"
import { getEditorStore } from "../editor/store-registry"

/** Editor conversations are minted with id `workflow:<workflowId>`. */
const EDITOR_SESSION_PREFIX = "workflow:"

/**
 * The directory the Copilot's Read tool may reach, relative to the sidecar's
 * working directory (the repo root in dev and packaged Tauri). The prompt's
 * identity section promises Read is limited to it; replacing the list keeps
 * the additive stack's referenced paths (any user-@-referenced folder) out.
 */
const COPILOT_TEMPLATES_DIRECTORY = "lib/workflow/copilot-templates"

/**
 * Build the workflow-editor system-prompt snapshot block.
 *
 * Trimmed to <3KB so we don't blow the system-prompt budget on a
 * 200-node graph: only the envelope, node count, selection, and (for
 * up to 12 selected nodes) per-node detail. The agent gets the full
 * picture via wf_read_graph when it needs it.
 */
export function buildWorkflowSnapshotBlock(
  workflowId: string,
  s: {
    baseWorkflow: { id: string; name?: string; description?: string }
    nodes: ReadonlyArray<{ id: string; data: { kind: string; label: string } }>
    edges: ReadonlyArray<unknown>
    selectedNodeIds: string[]
    runStatusByStepId: Record<string, string>
    validationByStepId: Record<string, unknown>
  }
): string {
  const lines: string[] = []
  lines.push("# Currently-open workflow")
  lines.push(`- workflowId: ${workflowId}`)
  lines.push(`- name: ${s.baseWorkflow.name ?? "(untitled)"}`)
  if (s.baseWorkflow.description) {
    lines.push(`- description: ${s.baseWorkflow.description}`)
  }
  lines.push(`- nodes: ${s.nodes.length}; edges: ${s.edges.length}`)
  const failingCount = Object.keys(s.validationByStepId).length
  if (failingCount > 0) lines.push(`- nodes failing validation: ${failingCount}`)
  const runningCount = Object.values(s.runStatusByStepId).filter((v) => v === "running").length
  if (runningCount > 0) lines.push(`- nodes currently running: ${runningCount}`)
  if (s.selectedNodeIds.length > 0) {
    lines.push(`- selection: ${s.selectedNodeIds.length} node(s)`)
    const detailLimit = 12
    const detailIds = s.selectedNodeIds.slice(0, detailLimit)
    for (const id of detailIds) {
      const node = s.nodes.find((n) => n.id === id)
      if (node) lines.push(`  - ${id} :: ${node.data.kind} :: ${node.data.label}`)
    }
    if (s.selectedNodeIds.length > detailLimit) {
      lines.push(`  - …and ${s.selectedNodeIds.length - detailLimit} more`)
    }
  }
  lines.push("")
  lines.push(
    "Use the wf_* MCP tools to read, propose reviewed graph changes, validate, and run this workflow. Route every graph mutation or layout change through wf_propose_batch; ALWAYS call wf_read_graph before referencing any node id you did not just propose."
  )
  return lines.join("\n")
}

function snapshotFor(sessionId: string): string | null {
  if (!sessionId.startsWith(EDITOR_SESSION_PREFIX)) return null
  const workflowId = sessionId.slice(EDITOR_SESSION_PREFIX.length)
  if (!workflowId) return null
  // No editor open for it (a rare race during navigation): the Copilot
  // discovers the graph with its first `wf_read_graph` call.
  const store = getEditorStore(workflowId)
  return store ? buildWorkflowSnapshotBlock(workflowId, store.getState()) : null
}

export const port: WorkflowEditorSessionPort = {
  async prepare(sessionId): Promise<WorkflowEditorSessionSetup> {
    let snapshot: string | null = null
    try {
      snapshot = snapshotFor(sessionId)
    } catch (err) {
      console.warn("workflow-editor snapshot block failed:", err)
    }
    return {
      systemPrompt: buildWorkflowCopilotPrompt(null),
      ...(snapshot ? { appendSystemPrompt: snapshot } : {}),
      allowedTools: WORKFLOW_COPILOT_ALLOWED_TOOLS,
      disallowedTools: WORKFLOW_COPILOT_DISALLOWED_TOOLS,
      additionalDirectories: [COPILOT_TEMPLATES_DIRECTORY],
    }
  },
}
