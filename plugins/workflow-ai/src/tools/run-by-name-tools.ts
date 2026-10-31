/** Workflow library tools ask the host to send approval cards directly. */

import { definePluginTool, type PluginToolRegistration } from "@cognia/plugin-sdk"
import type { WorkflowSummary } from "@cognia/plugin-sdk/api/workflow-run"
import { formatToolError, getWorkflowApi } from "../store-bridge"

function summariesToBullets(candidates: WorkflowSummary[]): string {
  return candidates
    .map((c, i) => `${i + 1}. ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n")
}

export function buildRunByNameTools(): PluginToolRegistration[] {
  return [
    definePluginTool({
      name: "wf_list_workflows",
      definition: {
        name: "wf_list_workflows",
        description:
          "List up to 50 workflows from the library by id + name + description. Use to disambiguate when a name the user provided is unclear, or to discover what's runnable in this workspace. Read-only.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Maximum number of summaries to return (default 50, max 200).",
              minimum: 1,
              maximum: 200,
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const limit = clampInt(args.limit, 50, 1, 200)
          const summaries = await getWorkflowApi().listWorkflowSummaries(limit)
          return { ok: true, count: summaries.length, workflows: summaries }
        } catch (err) {
          return formatToolError(err)
        }
      },
    }),
    definePluginTool({
      name: "wf_run_workflow_by_name",
      definition: {
        name: "wf_run_workflow_by_name",
        description:
          "Resolve a workflow by display name and prepare it for execution from an IM chat. The host sends the Approve/Cancel card directly; the agent MUST NOT re-emit it — the user's tap on Approve starts the actual run. When the name is ambiguous or unknown, returns a structured error with candidate names so the agent can re-prompt. Does NOT start the workflow itself; the in-chat A2UI gate is the approval step.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "Display name of the workflow to run. Case-insensitive.",
            },
            runParams: {
              type: "object",
              description:
                "Optional payload — surfaced to trigger-aware nodes as $trigger.payload.",
              additionalProperties: true,
            },
          },
        },
      },
      execute: async (args, context) => {
        try {
          const name = String(args.name ?? "").trim()
          if (name.length === 0) {
            return { ok: false, error: { code: "invalid-name", message: "name is required" } }
          }

          const triggeredFrom = await getWorkflowApi().resolveTriggerOrigin(context.sessionId)
          if (!triggeredFrom) {
            return {
              ok: false,
              error: {
                code: "not-an-im-session",
                message:
                  "This session has no IM platform binding. Use wf_run_workflow from the workflow editor instead.",
              },
            }
          }

          const lookup = await getWorkflowApi().findWorkflowByName(name)
          if (!lookup.ok && lookup.reason === "not-found") {
            return {
              ok: false,
              error: {
                code: "workflow-not-found",
                message: `No workflow named "${name}". Call wf_list_workflows to see what's available.`,
              },
            }
          }
          if (!lookup.ok && lookup.reason === "ambiguous") {
            return {
              ok: false,
              error: {
                code: "workflow-ambiguous",
                message: `"${name}" matches ${lookup.candidates.length} workflows. Ask the user to pick one:\n${summariesToBullets(lookup.candidates)}`,
                detail: { candidates: lookup.candidates },
              },
            }
          }

          // Type narrowing: `lookup.ok === true` past this point.
          if (!lookup.ok) throw new Error("unreachable")
          const { workflowId } = lookup
          const { workflowName: resolvedName, surfaceId } =
            await getWorkflowApi().prepareWorkflowApproval({
              workflowId,
              runParams: (args.runParams as Record<string, unknown>) ?? {},
              triggeredFrom,
            })

          return {
            ok: true,
            workflowId,
            workflowName: resolvedName,
            surfaceId,
            sent: true,
            instruction:
              "The host sent the Approve/Cancel card. Do not re-emit it. The user must tap Approve to start the workflow.",
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    }),
    definePluginTool({
      name: "wf_subscribe_workflow_fanout",
      definition: {
        name: "wf_subscribe_workflow_fanout",
        description:
          "Subscribe the CURRENT IM session to receive workflow run progress for a given workflow (by name). Every future run of that workflow will mirror its step events + terminal status into this conversation. The host sends the Approve/Cancel card directly; the agent MUST NOT re-emit it — the actual subscription row is written only after the user taps Approve. Permissioning: the target conversation is hard-bound to this session — the tool cannot subscribe other channels (operator must use the Settings UI for cross-channel mirroring).",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "Workflow display name to subscribe to. Case-insensitive.",
            },
          },
        },
      },
      execute: async (args, context) => {
        try {
          const name = String(args.name ?? "").trim()
          if (name.length === 0) {
            return { ok: false, error: { code: "invalid-name", message: "name is required" } }
          }
          const triggeredFrom = await getWorkflowApi().resolveTriggerOrigin(context.sessionId)
          if (!triggeredFrom) {
            return {
              ok: false,
              error: {
                code: "not-an-im-session",
                message:
                  "This session has no IM platform binding. Subscriptions are scoped to IM channels — open Settings → Workflow → Fan-out to add a mirror from desktop.",
              },
            }
          }

          const lookup = await getWorkflowApi().findWorkflowByName(name)
          if (!lookup.ok && lookup.reason === "not-found") {
            return {
              ok: false,
              error: {
                code: "workflow-not-found",
                message: `No workflow named "${name}". Call wf_list_workflows to see what's available.`,
              },
            }
          }
          if (!lookup.ok && lookup.reason === "ambiguous") {
            return {
              ok: false,
              error: {
                code: "workflow-ambiguous",
                message: `"${name}" matches ${lookup.candidates.length} workflows. Ask the user to pick one:\n${summariesToBullets(lookup.candidates)}`,
                detail: { candidates: lookup.candidates },
              },
            }
          }
          if (!lookup.ok) throw new Error("unreachable")
          const { workflowId, name: resolvedName } = lookup

          const { surfaceId } = await getWorkflowApi().prepareFanoutApproval({
            workflowId,
            workflowName: resolvedName,
            triggeredFrom,
          })

          return {
            ok: true,
            workflowId,
            workflowName: resolvedName,
            surfaceId,
            sent: true,
            instruction:
              "The host sent the Approve/Cancel card. Do not re-emit it. The user must tap Approve to subscribe.",
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    }),
  ]
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback
  const rounded = Math.floor(raw)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
