import { createWorkflowAuthorAPI } from "./workflow-author-api"

// Exercise host copy without the global React next-intl mock.
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: jest.fn(async (namespace: string) => {
    if (namespace !== "workflows.approvals") throw new Error(`Unexpected namespace: ${namespace}`)
    const { getSettings } = await import("@/lib/db/settings")
    const locale = (await getSettings())?.language === "zh-CN" ? "zh-CN" : "en"
    const messages = jest.requireActual(`@/i18n/messages/${locale}/workflows/approvals.json`)
    return (key: string, values?: Record<string, unknown>) => {
      const template = key.split(".").reduce((value, part) => value[part], messages)
      return template.replace(/\{(\w+)\}/g, (_: string, name: string) =>
        String(values?.[name] ?? "")
      )
    }
  }),
}))

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
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { buildApprovalSurface } from "@/lib/connectors/a2ui-bridge/workflow-to-a2ui"
import { createWorkflowWaitEvent, emitWorkflowWaitEvent } from "@/lib/db/workflow-waitpoints"
import { holdWorkflowDispatchForApproval } from "@/lib/connectors/hitl/workflow-run-approval"

import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { getSettings } from "@/lib/db/settings"

jest.mock("@/lib/connectors/delivery-gateway", () => ({
  enqueueGoverned: jest.fn(async () => ({})),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => ({ language: "en" })) }))

jest.mock("@/lib/connectors/hitl/workflow-run-approval", () => ({
  holdWorkflowDispatchForApproval: jest.fn(),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(async () => ({ id: "ad" })),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({ readForResolution: jest.fn() }))
jest.mock("@/lib/connectors/im-permission-ceiling", () => ({
  buildImPermissionCeiling: jest.fn(async () => ({})),
}))

jest.mock("@/lib/workflow/editor/store-registry", () => ({
  getEditorStore: jest.fn(),
  listEditorStores: jest.fn(),
}))
jest.mock("@/lib/workflow/editor/proposal-store", () => ({
  useProposalStore: { getState: jest.fn() },
}))
jest.mock("@/lib/workflow/editor/auto-layout", () => ({
  autoLayout: jest.fn(),
  applyAutoLayoutPositions: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/error-explainer", () => ({
  explainLastRun: jest.fn(),
  explainValidation: jest.fn(),
}))
jest.mock("@/lib/workflow/copilot-templates", () => ({
  listCopilotTemplates: jest.fn(),
  materializeCopilotTemplate: jest.fn(),
}))
jest.mock("@/lib/workflow/nodes/catalog", () => ({
  NODE_CATALOG: [{ kind: "start" }],
  getPluginCatalogSnapshot: jest.fn(),
  nodeCatalogEntry: jest.fn(),
}))
jest.mock("@/lib/plugin/registries/workflow-template-registry", () => ({
  refreshAllWorkflowTemplateWarnings: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({ runWorkflow: jest.fn() }))
jest.mock("@/lib/workflow/publish/run-workflow-typed-tool", () => ({
  executeRunWorkflowTyped: jest.fn(),
}))
jest.mock("@/lib/workflow/library/lookup", () => ({
  findWorkflowById: jest.fn(),
  findWorkflowByName: jest.fn(),
  listWorkflowSummaries: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/trigger-origin", () => ({
  approvalActorScope: jest.fn(),
  resolveWorkflowTriggerOrigin: jest.fn(),
}))
jest.mock("@/lib/connectors/adapters/_shared/a2ui-mapper", () => ({
  recordCallbackBinding: jest.fn(),
}))
jest.mock("@/lib/connectors/a2ui-bridge/workflow-to-a2ui", () => ({
  buildApprovalSurface: jest.fn(),
}))
jest.mock("@/lib/db/workflow-waitpoints", () => ({
  createWorkflowWaitEvent: jest.fn(),
  emitWorkflowWaitEvent: jest.fn(),
}))

const mockPinPublication = jest.fn()
jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  createPublishedWorkflowDependencyBinding: (...args: unknown[]) => mockPinPublication(...args),
}))

const mockGetEditorStore = jest.mocked(getEditorStore)
const mockListEditorStores = jest.mocked(listEditorStores)

function createState() {
  const workflow = {
    id: "wf-1",
    schemaVersion: 1,
    name: "Workflow",
    nodes: [],
    edges: [],
    settings: {},
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  }
  return {
    workflowId: "wf-1",
    baseWorkflow: workflow,
    nodes: [{ id: "node-1", data: { kind: "start", label: "Start" }, position: { x: 0, y: 0 } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedNodeIds: ["node-1"],
    selectedEdgeIds: [],
    runStatusByStepId: { "node-1": "succeeded" },
    validationByStepId: {},
    lastRunByStepId: {},
    toWorkflow: jest.fn(() => workflow),
    addNode: jest.fn(() => "node-2"),
    removeNodes: jest.fn(),
    removeEdges: jest.fn(),
    connect: jest.fn(() => "edge-1"),
    updateEdgeData: jest.fn(() => true),
    updateNodeData: jest.fn(),
    revalidateNode: jest.fn(() => ({ valid: true, errors: [] })),
    applyProposalOps: jest.fn(() => ({ applied: 2 })),
    setNodes: jest.fn(),
    groupSelected: jest.fn(() => "group-1"),
    setSelectedNodes: jest.fn(),
    setViewport: jest.fn(),
    pulseNode: jest.fn(),
  }
}

function installEditor(state = createState()) {
  const store = { getState: jest.fn(() => state) }
  mockGetEditorStore.mockImplementation((id) => (id === "wf-1" ? (store as never) : null))
  mockListEditorStores.mockReturnValue([{ workflowId: "wf-1", store: store as never }])
  return { state, store }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetEditorStore.mockReturnValue(null)
  mockListEditorStores.mockReturnValue([])
  jest.mocked(resolveWorkflowTriggerOrigin).mockResolvedValue({
    source: "im",
    sessionId: "root",
    adapterId: "ad",
    conversationKey: "lark:ad:chat",
    initiator: { platformIdentityId: "requester", remoteUserId: "requester" },
  })
})

it("asks the host hold to deliver the card to its IM conversation and reports success only after delivery", async () => {
  jest.mocked(holdWorkflowDispatchForApproval).mockResolvedValue({
    held: true,
    surfaceId: "workflow:prepared",
    workflowName: "Daily",
    surface: {} as never,
  })
  const input = {
    workflowId: "wf",
    triggeredFrom: {
      source: "im" as const,
      sessionId: "root",
      adapterId: "ad",
      conversationKey: "lark:ad:chat",
    },
  }
  expect(await createWorkflowAuthorAPI().prepareWorkflowApproval(input)).toMatchObject({
    sent: true,
    surfaceId: "workflow:prepared",
  })
  expect(holdWorkflowDispatchForApproval).toHaveBeenCalledWith(
    expect.objectContaining({ deliverCard: true, adapterId: "ad", conversationKey: "lark:ad:chat" })
  )
  jest
    .mocked(holdWorkflowDispatchForApproval)
    .mockResolvedValue({ held: false, reason: "card_delivery_failed", message: "hold failed" })
  await expect(createWorkflowAuthorAPI().prepareWorkflowApproval(input)).rejects.toThrow(
    "hold failed"
  )
})

describe("host fan-out approval delivery", () => {
  const input = {
    workflowId: "wf",
    workflowName: "Daily",
    triggeredFrom: {
      source: "im" as const,
      sessionId: "root",
      adapterId: "ad",
      conversationKey: "lark:ad:chat",
      initiator: { platformIdentityId: "requester", remoteUserId: "requester" },
    },
  }

  it("records both bindings before sending a governed notice to the triggering conversation", async () => {
    const scope = { mode: "initiator" as const, allowedUserIds: ["requester"] }
    jest.mocked(approvalActorScope).mockReturnValue(scope)
    const result = await createWorkflowAuthorAPI().prepareFanoutApproval(input)
    expect(result.sent).toBe(true)
    const calls = jest.mocked(recordCallbackBinding).mock.calls.map(([binding]) => binding)
    expect(calls).toHaveLength(2)
    expect(calls.map((binding) => binding.kind)).toEqual(["wf_fanout_approve", "wf_fanout_cancel"])
    for (const binding of calls) {
      expect(binding).toMatchObject({
        adapterId: "ad",
        surfaceId: result.surfaceId,
        conversationKey: "lark:ad:chat",
        actorScope: scope,
        allowedActions: ["approve", "cancel"],
        payload: {
          workflowId: "wf",
          workflowName: "Daily",
          target: { adapterId: "ad", conversationKey: "lark:ad:chat" },
          createdBy: "claude-tool",
        },
      })
      expect(result.surface.components[binding.componentId!]).toHaveProperty(
        "value",
        binding.actionId
      )
    }
    expect(enqueueGoverned).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "ad",
        conversationKey: "lark:ad:chat",
        source: "ai-run",
        authorization: { kind: "system-notice", inboundConversationKey: "lark:ad:chat" },
        request: expect.objectContaining({
          segments: [
            expect.objectContaining({
              type: "a2ui",
              surfaceId: result.surfaceId,
              content: result.surface,
            }),
          ],
        }),
      })
    )
    expect(jest.mocked(recordCallbackBinding).mock.invocationCallOrder[1]).toBeLessThan(
      jest.mocked(enqueueGoverned).mock.invocationCallOrder[0]
    )
  })

  it.each(["prepareWorkflowApproval", "prepareFanoutApproval"] as const)(
    "%s refuses a copied origin after the session is rebound",
    async (method) => {
      jest.mocked(resolveWorkflowTriggerOrigin).mockResolvedValueOnce({
        source: "im",
        sessionId: "root",
        adapterId: "other",
        conversationKey: "lark:other:chat",
      })
      await expect(createWorkflowAuthorAPI()[method](input)).rejects.toThrow("no longer matches")
      expect(enqueueGoverned).not.toHaveBeenCalled()
      expect(holdWorkflowDispatchForApproval).not.toHaveBeenCalled()
      expect(recordCallbackBinding).not.toHaveBeenCalled()
    }
  )

  it("uses only the Host's live initiator for both card types", async () => {
    const forged = {
      ...input,
      triggeredFrom: {
        ...input.triggeredFrom,
        initiator: { platformIdentityId: "forged", remoteUserId: "forged" },
      },
    }
    await createWorkflowAuthorAPI().prepareFanoutApproval(forged)
    expect(approvalActorScope).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initiator: { platformIdentityId: "requester", remoteUserId: "requester" },
      })
    )
    jest.mocked(holdWorkflowDispatchForApproval).mockResolvedValueOnce({
      held: true,
      surfaceId: "sent",
      workflowName: "Daily",
      surface: {} as never,
    })
    await createWorkflowAuthorAPI().prepareWorkflowApproval(forged)
    expect(holdWorkflowDispatchForApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({ initiatorUserId: "requester" })
    )
  })

  it("does not claim success if governed delivery fails", async () => {
    jest.mocked(enqueueGoverned).mockRejectedValueOnce(new Error("delivery refused"))
    await expect(createWorkflowAuthorAPI().prepareFanoutApproval(input)).rejects.toThrow(
      "delivery refused"
    )
  })

  it.each([{ source: "ui" as const }, { source: "im" as const, adapterId: "ad" }])(
    "refuses an origin without an IM conversation: %j",
    async (triggeredFrom) => {
      await expect(
        createWorkflowAuthorAPI().prepareFanoutApproval({ ...input, triggeredFrom })
      ).rejects.toThrow("requires an IM origin")
      expect(enqueueGoverned).not.toHaveBeenCalled()
      expect(recordCallbackBinding).not.toHaveBeenCalled()
    }
  )

  it("uses Chinese host copy when selected", async () => {
    jest.mocked(getSettings).mockResolvedValueOnce({ language: "zh-CN" } as never)
    const result = await createWorkflowAuthorAPI().prepareFanoutApproval(input)
    expect(result.surface.title).toBe("订阅「Daily」")
    expect(result.surface.widget?.fallbackText).toContain("回复 1 同意 / 2 取消")
  })
})

describe("createWorkflowAuthorAPI", () => {
  it("exposes versioned builtin schemas without rewriting plugin contracts", () => {
    const branch = { kind: "flow.branch", category: "flow", label: "Branch" }
    jest.mocked(nodeCatalogEntry).mockReturnValue(branch as never)
    const api = createWorkflowAuthorAPI()
    expect(api.getNodeCatalogEntry("flow.branch")).toMatchObject({
      typeVersion: 2,
      paramsSchema: { required: ["conditions"] },
    })
  })

  it("resolves only an unambiguous editor and returns a detached snapshot", () => {
    const api = createWorkflowAuthorAPI()
    expect(api.resolveEditor("missing")).toEqual({
      ok: false,
      reason: "not-open",
      requestedId: "missing",
    })
    expect(api.resolveEditor()).toEqual({ ok: false, reason: "not-open" })

    const { state, store } = installEditor()
    const resolved = api.resolveEditor("wf-1")
    expect(resolved).toMatchObject({ ok: true, editor: { workflowId: "wf-1" } })
    if (resolved.ok) {
      resolved.editor.nodes[0].position.x = 99
      expect(state.nodes[0].position.x).toBe(0)
    }
    expect(api.resolveEditor()).toMatchObject({ ok: true, editor: { workflowId: "wf-1" } })

    mockListEditorStores.mockReturnValue([
      { workflowId: "wf-1", store: store as never },
      { workflowId: "wf-2", store: store as never },
    ])
    expect(api.resolveEditor()).toEqual({
      ok: false,
      reason: "ambiguous",
      openIds: ["wf-1", "wf-2"],
    })
  })

  it("executes every supported editor command without exposing the live store", () => {
    const { state } = installEditor()
    const api = createWorkflowAuthorAPI()

    expect(
      api.mutateEditor("wf-1", {
        kind: "add-node",
        nodeKind: "trigger.manual",
        position: { x: 1, y: 2 },
      })
    ).toEqual({
      kind: "add-node",
      nodeId: "node-2",
    })
    expect(api.mutateEditor("wf-1", { kind: "remove-nodes", ids: ["node-1"] })).toEqual({
      kind: "remove-nodes",
    })
    expect(api.mutateEditor("wf-1", { kind: "remove-edges", ids: ["edge-1"] })).toEqual({
      kind: "remove-edges",
    })
    expect(
      api.mutateEditor("wf-1", { kind: "connect", source: "node-1", target: "node-2" })
    ).toEqual({
      kind: "connect",
      edgeId: "edge-1",
    })
    expect(
      api.mutateEditor("wf-1", { kind: "update-edge", id: "edge-1", patch: { label: "next" } })
    ).toEqual({
      kind: "update-edge",
      updated: true,
    })
    expect(
      api.mutateEditor("wf-1", { kind: "update-node", id: "node-1", patch: { label: "Begin" } })
    ).toEqual({ kind: "update-node" })
    expect(api.mutateEditor("wf-1", { kind: "revalidate-node", id: "node-1" })).toEqual({
      kind: "revalidate-node",
      validation: { valid: true, errors: [] },
    })
    expect(api.mutateEditor("wf-1", { kind: "apply-proposal", ops: [] })).toEqual({
      kind: "apply-proposal",
      applied: 2,
    })
    expect(api.mutateEditor("wf-1", { kind: "set-nodes", nodes: [] })).toEqual({
      kind: "set-nodes",
    })
    expect(api.mutateEditor("wf-1", { kind: "group-nodes", ids: ["node-1"] })).toEqual({
      kind: "group-nodes",
      groupId: "group-1",
    })
    expect(api.mutateEditor("wf-1", { kind: "select-nodes", ids: ["node-1"] })).toEqual({
      kind: "select-nodes",
    })
    expect(
      api.mutateEditor("wf-1", { kind: "set-viewport", viewport: { x: 1, y: 2, zoom: 2 } })
    ).toEqual({
      kind: "set-viewport",
    })
    expect(api.mutateEditor("wf-1", { kind: "pulse-node", id: "node-1", durationMs: 100 })).toEqual(
      { kind: "pulse-node" }
    )
    expect(state.addNode).toHaveBeenCalled()
    expect(state.pulseNode).toHaveBeenCalledWith("node-1", 100)
    expect(() => api.mutateEditor("missing", { kind: "remove-nodes", ids: [] })).toThrow(
      'Workflow editor for "missing" is not open.'
    )
  })

  it("governs editor helpers and delegates non-editor workflow capabilities", async () => {
    const { state } = installEditor()
    const proposal = { proposalId: "proposal-1" }
    const openProposal = jest.fn(() => proposal)
    jest.mocked(useProposalStore.getState).mockReturnValue({ openProposal } as never)
    jest.mocked(autoLayout).mockResolvedValue({ "node-1": { x: 10, y: 20 } })
    jest.mocked(applyAutoLayoutPositions).mockReturnValue(state.nodes as never)
    jest.mocked(explainValidation).mockReturnValue([{ nodeId: "node-1" }] as never)
    jest.mocked(explainLastRun).mockReturnValue({ status: "succeeded" } as never)
    jest.mocked(listCopilotTemplates).mockReturnValue([{ id: "template-1" }] as never)
    jest.mocked(materializeCopilotTemplate).mockReturnValue({ workflow: { id: "wf-new" } } as never)
    jest.mocked(getPluginCatalogSnapshot).mockReturnValue([{ kind: "plugin-node" }] as never)
    jest.mocked(nodeCatalogEntry).mockReturnValue({ kind: "start" } as never)

    const api = createWorkflowAuthorAPI()
    expect(
      api.stageProposal({
        proposalId: "proposal-1",
        workflowId: "wf-1",
        summary: "Change",
        ops: [],
        baseRevision: "revision-1",
      })
    ).toBe(proposal)
    expect(await api.autoLayoutEditor("wf-1", "LR")).toBe(1)
    expect(state.setNodes).toHaveBeenCalledWith(state.nodes)
    expect(api.explainEditorValidation("wf-1")).toEqual([{ nodeId: "node-1" }])
    expect(api.explainEditorLastRun("wf-1")).toEqual({ status: "succeeded" })
    expect(api.listCopilotTemplates()).toEqual([{ id: "template-1" }])
    expect(api.materializeCopilotTemplate("template-1", {} as never)).toEqual({
      workflow: { id: "wf-new" },
    })
    expect(api.listNodeCatalog()).toEqual([...NODE_CATALOG, { kind: "plugin-node" }])
    expect(api.getNodeCatalogEntry("start")).toEqual({ kind: "start" })
    api.refreshTemplateWarnings()
    expect(refreshAllWorkflowTemplateWarnings).toHaveBeenCalledTimes(1)
  })

  it("delegates execution, discovery, connector, and wait-event operations", async () => {
    const runResult = { status: "completed" }
    const typedResult = { ok: true }
    const summaries = [{ id: "wf-1" }]
    const nameResult = { kind: "found", workflow: summaries[0] }
    const trigger = { type: "manual" }
    const actor = { kind: "user" }
    const surface = { type: "a2ui" }
    const waitEvent = { id: "event-1" }
    jest.mocked(runWorkflow).mockResolvedValue(runResult as never)
    jest.mocked(executeRunWorkflowTyped).mockResolvedValue(typedResult as never)
    jest.mocked(listWorkflowSummaries).mockResolvedValue(summaries as never)
    jest.mocked(findWorkflowByName).mockResolvedValue(nameResult as never)
    jest.mocked(findWorkflowById).mockResolvedValue(summaries[0] as never)
    jest.mocked(resolveWorkflowTriggerOrigin).mockResolvedValue(trigger as never)
    jest.mocked(approvalActorScope).mockReturnValue(actor as never)
    jest.mocked(recordCallbackBinding).mockResolvedValue(undefined)
    jest.mocked(buildApprovalSurface).mockReturnValue(surface as never)
    jest.mocked(createWorkflowWaitEvent).mockReturnValue(waitEvent as never)
    jest.mocked(emitWorkflowWaitEvent).mockResolvedValue(waitEvent as never)

    const api = createWorkflowAuthorAPI()
    expect(await api.runWorkflow({ workflowId: "wf-1" } as never)).toBe(runResult)
    expect(await api.executeRunWorkflowTyped({ name: "Workflow" })).toBe(typedResult)
    expect(api.getRunnerToolDefinition()).toEqual({
      name: WORKFLOW_RUNNER_TOOL_NAME,
      definition: WORKFLOW_RUNNER_TOOL_DEFINITION,
    })
    expect(await api.listWorkflowSummaries(5)).toBe(summaries)
    expect(await api.findWorkflowByName("Workflow")).toBe(nameResult)
    expect(await api.findWorkflowById("wf-1")).toBe(summaries[0])
    expect(await api.resolveTriggerOrigin("session-1")).toBe(trigger)
    expect(api.approvalActorScope(trigger as never)).toBe(actor)

    const binding = {
      adapterId: "adapter",
      actionId: "action",
      kind: "approval",
      surfaceId: "surface",
      componentId: "component",
      payload: {},
      actorScope: actor,
    }
    await api.recordCallbackBinding(binding as never)
    expect(recordCallbackBinding).toHaveBeenCalledWith(binding)
    expect(api.buildApprovalSurface({ bindingId: "binding", workflowName: "Workflow" })).toBe(
      surface
    )
    expect(await api.emitWaitEvent({ key: "ready", source: "plugin" })).toBe(waitEvent)
    expect(emitWorkflowWaitEvent).toHaveBeenCalledWith(waitEvent)
  })
})

it("pins host-resolved publications for plugin-created workflow approval bindings", async () => {
  const lock = {
    workflowId: "wf",
    versionId: "trusted-v1",
    deploymentId: "d1",
    deploymentRevision: 1,
  }
  mockPinPublication.mockResolvedValue(lock)
  const input = {
    adapterId: "ad",
    actionId: "wfapp:approve",
    surfaceId: "s",
    kind: "wf_approve" as const,
    actorScope: { mode: "operators" as const },
    payload: { workflowId: "wf", lockedDependency: { versionId: "untrusted" } },
  }
  await createWorkflowAuthorAPI().recordCallbackBinding(input)
  expect(mockPinPublication).toHaveBeenCalledWith("wf")
  expect(recordCallbackBinding).toHaveBeenLastCalledWith({
    ...input,
    payload: { ...input.payload, lockedDependency: lock },
  })
})

it("refuses plugin registration of dispatcher-only skill confirmations", async () => {
  await expect(
    createWorkflowAuthorAPI().recordCallbackBinding({
      adapterId: "ad",
      actionId: "skill_invoke:test.skill:0123456789abcdef0123456789abcdef",
      kind: "skill_invoke",
      surfaceId: "spoofed",
      conversationKey: "lark:ad:chat",
      payload: { skillId: "test.skill", sessionId: "root" },
      actorScope: { mode: "anyone" },
      skillConfirmationNonce: "0123456789abcdef0123456789abcdef",
    } as never)
  ).rejects.toThrow("Only the built-in skill dispatcher")
  expect(recordCallbackBinding).not.toHaveBeenCalled()
})
