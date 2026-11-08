/**
 * Host-governed workflow authoring and execution façade for plugins.
 *
 * The approval cards a plugin asks for go to the conversation its run was
 * triggered from, through that conversation's channel (the
 * `conversation-channel` port): the façade checks the origin against its
 * session and never draws or delivers a channel's card itself.
 */

import {
  conversationChannelFor,
  recordConversationCallbackBinding,
} from "@/lib/chat/conversation-channel"
import type { ConversationWorkflowOrigin } from "@/types/modules/ports/conversation-channel"
import type { WorkflowTriggeredFrom, WorkflowNodeKind } from "@/types/workflow/visual"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

import { getEditorStore, listEditorStores } from "@/lib/workflow/editor/store-registry"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import { autoLayout, applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { explainLastRun, explainValidation } from "@/lib/workflow/runtime/error-explainer"
import { listCopilotTemplates, materializeCopilotTemplate } from "@/lib/workflow/copilot-templates"
import {
  NODE_CATALOG,
  getPluginCatalogSnapshot,
  nodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import { defaultTypeVersionFor } from "@/lib/workflow/editor/node-handles"
import { KNOWN_KINDS, paramsJsonSchemaFor } from "@/lib/workflow/nodes/params-schemas"
import { refreshAllWorkflowTemplateWarnings } from "@/lib/plugin/registries/workflow-template-registry"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { executeRunWorkflowTyped } from "@/lib/workflow/publish/run-workflow-typed-tool"
import {
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "@/lib/workflow/publish/runner-tool"
import {
  findWorkflowById,
  findWorkflowByName,
  listWorkflowSummaries,
} from "@/lib/workflow/library/lookup"
import {
  approvalActorScope,
  resolveWorkflowTriggerOrigin,
} from "@/lib/workflow/runtime/trigger-origin"
import { buildApprovalSurface } from "@/lib/claude/hitl/workflow-approval-surface"
import { createWorkflowWaitEvent, emitWorkflowWaitEvent } from "@/lib/db/workflow-waitpoints"
import type {
  PluginWorkflowAuthorAPI,
  PluginWorkflowEditorSnapshot,
} from "@cognia/plugin-contract/lib/plugin/api/workflow-author-api"
export type {
  EmitPluginWorkflowWaitEventInput,
  PluginWorkflowAuthorAPI,
  PluginWorkflowEditorCommand,
  PluginWorkflowEditorMutationResult,
  PluginWorkflowEditorResolution,
  PluginWorkflowEditorSnapshot,
  RecordPluginWorkflowCallbackInput,
  StageWorkflowProposalInput,
} from "@cognia/plugin-contract/lib/plugin/api/workflow-author-api"

function snapshotEditor(workflowId: string): PluginWorkflowEditorSnapshot | undefined {
  const store = getEditorStore(workflowId)
  if (!store) return undefined
  const state = store.getState()
  return {
    workflowId,
    workflow: structuredClone(state.toWorkflow()),
    baseWorkflow: structuredClone(state.baseWorkflow),
    nodes: structuredClone(state.nodes),
    edges: structuredClone(state.edges),
    viewport: structuredClone(state.viewport),
    selectedNodeIds: [...state.selectedNodeIds],
    selectedEdgeIds: [...state.selectedEdgeIds],
    runStatusByStepId: structuredClone(state.runStatusByStepId),
    validationByStepId: structuredClone(state.validationByStepId),
    lastRunByStepId: structuredClone(state.lastRunByStepId),
  }
}

function requireEditor(workflowId: string) {
  const store = getEditorStore(workflowId)
  if (!store) throw new Error(`Workflow editor for "${workflowId}" is not open.`)
  return store
}

/**
 * The IM origin a plugin names, checked against the session it names: the
 * Host's record of that session's trigger is authoritative.
 */
async function resolveApprovalOrigin(
  requested: WorkflowTriggeredFrom
): Promise<ConversationWorkflowOrigin> {
  if (
    requested.source !== "im" ||
    !requested.sessionId ||
    !requested.adapterId ||
    !requested.conversationKey
  )
    throw new Error("Workflow approval requires an IM origin with a session")
  const resolved = await resolveWorkflowTriggerOrigin(requested.sessionId)
  if (
    !resolved ||
    resolved.source !== "im" ||
    resolved.adapterId !== requested.adapterId ||
    resolved.conversationKey !== requested.conversationKey
  )
    throw new Error("Workflow approval origin no longer matches its IM session")
  return {
    ...resolved,
    source: "im",
    sessionId: requested.sessionId,
    adapterId: requested.adapterId,
    conversationKey: requested.conversationKey,
  }
}

/** The channel the origin's conversation is bound to. Throws when none serves it. */
async function approvalChannel(origin: ConversationWorkflowOrigin) {
  const channel = await conversationChannelFor({
    conversationKey: origin.conversationKey,
    adapterId: origin.adapterId,
  })
  if (!channel) throw new Error("Workflow approval delivery target is unavailable or incomplete")
  return channel
}

export function createWorkflowAuthorAPI(): PluginWorkflowAuthorAPI {
  return {
    resolveEditor(workflowId) {
      if (workflowId) {
        const editor = snapshotEditor(workflowId)
        return editor
          ? { ok: true, editor }
          : { ok: false, reason: "not-open", requestedId: workflowId }
      }
      const open = listEditorStores()
      if (open.length === 0) return { ok: false, reason: "not-open" }
      if (open.length > 1) {
        return { ok: false, reason: "ambiguous", openIds: open.map((entry) => entry.workflowId) }
      }
      return { ok: true, editor: snapshotEditor(open[0].workflowId)! }
    },

    mutateEditor(workflowId, command) {
      const state = requireEditor(workflowId).getState()
      switch (command.kind) {
        case "add-node":
          return {
            kind: command.kind,
            nodeId: state.addNode(command.nodeKind, command.position, command.overrides),
          }
        case "remove-nodes":
          state.removeNodes(command.ids)
          return { kind: command.kind }
        case "remove-edges":
          state.removeEdges(command.ids)
          return { kind: command.kind }
        case "connect":
          return { kind: command.kind, edgeId: state.connect(command) }
        case "update-edge":
          return { kind: command.kind, updated: state.updateEdgeData(command.id, command.patch) }
        case "update-node":
          state.updateNodeData(command.id, command.patch)
          return { kind: command.kind }
        case "revalidate-node":
          return { kind: command.kind, validation: state.revalidateNode(command.id) }
        case "apply-proposal":
          return {
            kind: command.kind,
            ...state.applyProposalOps(command.ops, command.expectedRevision),
          }
        case "set-nodes":
          state.setNodes(command.nodes)
          return { kind: command.kind }
        case "group-nodes":
          return { kind: command.kind, groupId: state.groupSelected(command.ids) }
        case "select-nodes":
          state.setSelectedNodes(command.ids)
          return { kind: command.kind }
        case "set-viewport":
          state.setViewport(command.viewport)
          return { kind: command.kind }
        case "pulse-node":
          state.pulseNode(command.id, command.durationMs)
          return { kind: command.kind }
      }
    },

    stageProposal(input) {
      return useProposalStore.getState().openProposal(input.workflowId, input)
    },

    async autoLayoutEditor(workflowId, direction) {
      const state = requireEditor(workflowId).getState()
      const positions = await autoLayout(state.nodes, state.edges, { direction })
      const next = applyAutoLayoutPositions(state.nodes, positions)
      state.setNodes(next)
      return next.length
    },

    explainEditorValidation(workflowId) {
      const state = requireEditor(workflowId).getState()
      return explainValidation(
        state.validationByStepId,
        state.nodes.map((node) => ({
          id: node.id,
          label: node.data.label ?? node.id,
          kind: node.data.kind,
        }))
      )
    },

    explainEditorLastRun(workflowId) {
      const state = requireEditor(workflowId).getState()
      return explainLastRun(
        state.lastRunByStepId,
        state.nodes.map((node) => ({
          id: node.id,
          label: node.data.label ?? node.id,
          kind: node.data.kind,
        }))
      )
    },

    listCopilotTemplates,
    materializeCopilotTemplate,
    listNodeCatalog: () => [
      ...NODE_CATALOG.map(authoringCatalogEntry),
      ...getPluginCatalogSnapshot(),
    ],
    getNodeCatalogEntry: (kind) =>
      authoringCatalogEntry(nodeCatalogEntry(kind as WorkflowNodeKind)),
    refreshTemplateWarnings: refreshAllWorkflowTemplateWarnings,
    runWorkflow,
    executeRunWorkflowTyped,
    getRunnerToolDefinition: () => ({
      name: WORKFLOW_RUNNER_TOOL_NAME,
      definition: WORKFLOW_RUNNER_TOOL_DEFINITION,
    }),
    listWorkflowSummaries,
    findWorkflowByName,
    findWorkflowById,
    resolveTriggerOrigin: resolveWorkflowTriggerOrigin,
    approvalActorScope,
    prepareWorkflowApproval: async ({ workflowId, runParams, triggeredFrom: requestedOrigin }) => {
      const triggeredFrom = await resolveApprovalOrigin(requestedOrigin)
      const card = await (
        await approvalChannel(triggeredFrom)
      ).approveWorkflowRun({ workflowId, ...(runParams ? { runParams } : {}), triggeredFrom })
      return { sent: true, ...card }
    },
    prepareFanoutApproval: async ({ workflowId, workflowName, triggeredFrom: requestedOrigin }) => {
      const triggeredFrom = await resolveApprovalOrigin(requestedOrigin)
      const card = await (
        await approvalChannel(triggeredFrom)
      ).approveWorkflowFanout({
        workflowId,
        workflowName,
        triggeredFrom,
        actorScope: approvalActorScope(triggeredFrom),
      })
      return { sent: true, ...card }
    },
    recordCallbackBinding: async (input) => {
      if (input.kind === "skill_invoke")
        throw new Error("Only the built-in skill dispatcher can issue skill confirmations")
      if (
        (input.kind === "wf_approve" || input.kind === "wf_cancel") &&
        typeof input.payload?.workflowId === "string"
      ) {
        const { createPublishedWorkflowDependencyBinding } =
          await import("@/lib/workflow/runtime/execution-authority")
        const lockedDependency = await createPublishedWorkflowDependencyBinding(
          input.payload.workflowId
        )
        await recordInChannel({ ...input, payload: { ...input.payload, lockedDependency } })
        return
      }
      await recordInChannel(input)
    },
    buildApprovalSurface,
    emitWaitEvent: (input) => emitWorkflowWaitEvent(createWorkflowWaitEvent(input)),
  }
}

/** Record a plugin's card choice with the channel that serves it. Throws when none does. */
async function recordInChannel(
  input: Parameters<typeof recordConversationCallbackBinding>[0]
): Promise<void> {
  if (!(await recordConversationCallbackBinding(input)))
    throw new Error("No conversation channel serves this callback binding")
}

/** Keep inspector presentation schemas separate from the versioned authoring contract. */
function authoringCatalogEntry(entry: NodeCatalogEntry): NodeCatalogEntry {
  if (entry.pluginId || !KNOWN_KINDS.includes(entry.kind)) return entry
  const typeVersion = defaultTypeVersionFor(entry.kind)
  return { ...entry, typeVersion, paramsSchema: paramsJsonSchemaFor(entry.kind, typeVersion) }
}
