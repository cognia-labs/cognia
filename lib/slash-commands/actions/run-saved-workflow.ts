/**
 * `/workflow <name | id>` — run a saved workflow from the MAIN chat.
 *
 * Unlike the editor-only Workflow Copilot commands (`actions/workflow.ts`),
 * this one is available everywhere. It resolves the workspace's workflows,
 * refreshes a playbook-derived match from its playbook (the `fresh-workflows`
 * port), fires `runWorkflow` (a `trigger.manual` event, `triggeredBy.source: "chat"`)
 * fire-and-forget, and drops a result chip into the transcript. Live progress
 * is reported by the global `WorkflowRunToaster`.
 *
 * Output strings are plain English by repo convention (slash-command system
 * messages aren't next-intl-localized — see `actions/workflow.ts`).
 */

import type { SlashContext } from "../builtin"
import type { TriggerEvent, WorkflowRow } from "@/types/workflow/visual"

/** Pure matcher: exact id, exact name (case-insensitive), then name substring. */
export function matchWorkflows(workflows: WorkflowRow[], query: string): WorkflowRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const byId = workflows.find((w) => w.id.toLowerCase() === q)
  if (byId) return [byId]
  const exactName = workflows.filter((w) => w.name.toLowerCase() === q)
  if (exactName.length > 0) return exactName
  return workflows.filter((w) => w.name.toLowerCase().includes(q))
}

function listMatches(workflows: WorkflowRow[]): string {
  if (workflows.length === 0) {
    return "No saved workflows yet. Create one in the Workflows section first."
  }
  const lines = workflows
    .slice(0, 25)
    .map((w) => `- \`${w.name}\` — ${w.nodes.length} nodes (id: \`${w.id}\`)`)
  return [
    "Usage: `/workflow <name | id>` — run a saved workflow from chat.",
    "",
    "Available workflows:",
    ...lines,
  ].join("\n")
}

export async function handleRunWorkflow(ctx: SlashContext): Promise<void> {
  if (ctx.chatStatus === "streaming" || ctx.chatStatus === "awaiting_approval") {
    ctx.pushSystemMessage(
      "Can't start a workflow while a turn is in progress. Try again once it settles."
    )
    return
  }

  const { listWorkflows } = await import("@/lib/db/workflows")
  const workflows = await listWorkflows()

  const query = ctx.args.trim()
  if (!query) {
    ctx.pushSystemMessage(listMatches(workflows))
    return
  }

  const matches = matchWorkflows(workflows, query)
  if (matches.length === 0) {
    ctx.pushSystemMessage(`No workflow matches \`${query}\`.\n\n${listMatches(workflows)}`)
    return
  }
  if (matches.length > 1) {
    ctx.pushSystemMessage(
      [
        `\`${query}\` is ambiguous — it matches ${matches.length} workflows:`,
        "",
        ...matches.slice(0, 25).map((w) => `- \`${w.name}\` (id: \`${w.id}\`)`),
        "",
        "Re-run `/workflow` with a more specific name or the id.",
      ].join("\n")
    )
    return
  }

  // A playbook-derived row runs what its playbook compiles to now, never the
  // copy stored when it was last opened (ADR-0254 §2).
  const { readFreshWorkflow } = await import("@/lib/workflow/library/fresh-workflow")
  const fresh = await readFreshWorkflow(matches[0].id)
  if (fresh.status === "not-found") {
    ctx.pushSystemMessage(`Workflow \`${matches[0].name}\` no longer exists.`)
    return
  }
  if (fresh.status === "source-unavailable") {
    ctx.pushSystemMessage(
      `Workflow \`${matches[0].name}\` can't run: the playbook it follows (\`${fresh.workflow.derivedFrom?.skillId ?? matches[0].id}\`) no longer compiles. Fix the playbook, or detach a copy in the editor.`
    )
    return
  }
  if (fresh.dormantSteps > 0) {
    ctx.pushSystemMessage(
      `Workflow \`${matches[0].name}\` can't run yet: ${fresh.dormantSteps} of its playbook's steps are not runnable in this version.`
    )
    return
  }
  const workflow = fresh.workflow
  const { runWorkflow } = await import("@/lib/workflow/runtime/orchestrator")
  const trigger: TriggerEvent = {
    workflowId: workflow.id,
    kind: "trigger.manual",
    payload: {},
    originAt: Date.now(),
  }
  // Fire-and-forget — the global toaster reports progress; swallow rejections so
  // an orchestrator failure doesn't surface as an unhandled rejection.
  void runWorkflow({ workflow, trigger, triggeredBy: { source: "chat" } }).catch(() => undefined)

  ctx.pushSystemMessage({
    kind: "slash-result",
    commandId: "workflow",
    args: workflow.name,
    summary: `Started workflow “${workflow.name}”. Watch the toast for progress.`,
  })
}
