/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const replaceWorkflow = jest.fn(async (workflow: VisualWorkflow) => ({
  workflow: { ...workflow, updatedAt: 99 },
  publicationInvalidated: false,
}))
jest.mock("@/lib/db/workflows", () => ({
  replaceWorkflow: (...a: unknown[]) => replaceWorkflow(a[0] as VisualWorkflow),
}))
let writeAuthority: "local" | "host" = "local"
jest.mock("@/lib/workflow/remote/write-authority", () => ({
  workflowWriteAuthority: () => writeAuthority,
}))
const queueWorkflowSaveOnHost = jest.fn(async (_workflow: VisualWorkflow, _label?: string) => ({}))
jest.mock("@/lib/workflow/remote/host-writes", () => ({
  queueWorkflowSaveOnHost: (...a: unknown[]) =>
    queueWorkflowSaveOnHost(a[0] as VisualWorkflow, a[1] as string | undefined),
}))

import { persistEditorWorkflow } from "./persist-workflow"
import { createEditorStore } from "./store"
import type { VisualWorkflow } from "@/types/workflow/visual"

function buildWorkflow(nodeType: string): VisualWorkflow {
  return {
    id: "wf_persist",
    schemaVersion: 2,
    name: "Persist",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n1",
        type: nodeType as VisualWorkflow["nodes"][number]["type"],
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "N1", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

beforeEach(() => {
  replaceWorkflow.mockClear()
  queueWorkflowSaveOnHost.mockClear()
  writeAuthority = "local"
})

describe("persistEditorWorkflow", () => {
  it("persists through the canonical database path, marks saved, and reports zero issues", async () => {
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    store.getState().setName("Edited") // mark dirty
    expect(store.getState().dirty).toBe(true)

    const result = await persistEditorWorkflow(store)

    expect(replaceWorkflow).toHaveBeenCalledTimes(1)
    expect(store.getState().dirty).toBe(false)
    expect(store.getState().baseWorkflow.updatedAt).toBe(99)
    expect(result).toEqual({
      issueCount: 0,
      publicationInvalidated: false,
      editedDuringSave: false,
      hostWrite: false,
    })
    // The desktop owns its workflows: nothing goes to a Host.
    expect(queueWorkflowSaveOnHost).not.toHaveBeenCalled()
  })

  it("queues the saved definition to the paired Host that owns the workflow", async () => {
    writeAuthority = "host"
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    store.getState().setName("Edited on the phone")

    const result = await persistEditorWorkflow(store)

    expect(result.hostWrite).toBe(true)
    expect(queueWorkflowSaveOnHost).toHaveBeenCalledTimes(1)
    // The Host gets what the mirror stored, not what the editor holds later.
    expect(queueWorkflowSaveOnHost.mock.calls[0][0]).toMatchObject({
      id: "wf_persist",
      name: "Edited on the phone",
      updatedAt: 99,
    })
    expect(store.getState().dirty).toBe(false)
  })

  it("leaves the editor dirty when the Host write cannot be queued", async () => {
    writeAuthority = "host"
    queueWorkflowSaveOnHost.mockRejectedValueOnce(new Error("queue unavailable"))
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    store.getState().setName("Edited on the phone")

    await expect(persistEditorWorkflow(store)).rejects.toThrow("queue unavailable")
    // Saved on the phone only is not saved: the user must be able to retry.
    expect(store.getState().dirty).toBe(true)
  })

  it("keeps the editor dirty when the graph changes while the write is in flight", async () => {
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    store.getState().setName("Snapshot captured")
    replaceWorkflow.mockImplementationOnce(async (workflow: VisualWorkflow) => {
      // The user keeps editing after the snapshot was taken.
      store.getState().setName("Edit during save")
      return { workflow: { ...workflow, updatedAt: 99 }, publicationInvalidated: false }
    })

    const result = await persistEditorWorkflow(store)

    // The row holds the snapshot; the editor holds the later edit.
    expect(replaceWorkflow.mock.calls[0][0].name).toBe("Snapshot captured")
    expect(store.getState().toWorkflow().name).toBe("Edit during save")
    expect(result.editedDuringSave).toBe(true)
    expect(store.getState().dirty).toBe(true)
    // Persisted metadata still syncs, so a later save is not refused as stale.
    expect(store.getState().baseWorkflow.updatedAt).toBe(99)

    // Saving again carries the later edit and clears the marker.
    const second = await persistEditorWorkflow(store)
    expect(replaceWorkflow.mock.calls[1][0].name).toBe("Edit during save")
    expect(second.editedDuringSave).toBe(false)
    expect(store.getState().dirty).toBe(false)
  })

  it("reports params errors from the persisted snapshot", async () => {
    const workflow = buildWorkflow("flow.branch")
    workflow.nodes[0].typeVersion = 2
    workflow.nodes[0].data.params = { condition: "true" }
    const result = await persistEditorWorkflow(createEditorStore(workflow))
    expect(result.issueCount).toBe(1)
  })

  it("reports the validation issue count for an invalid node", async () => {
    // ai.prompt with empty params is missing its required prompt → 1 issue.
    const store = createEditorStore(buildWorkflow("ai.prompt"))
    const result = await persistEditorWorkflow(store)
    expect(result.issueCount).toBeGreaterThan(0)
    expect(replaceWorkflow).toHaveBeenCalledTimes(1)
  })

  it("counts issues from the node data being saved, not a stale validation cache", async () => {
    const store = createEditorStore(buildWorkflow("ai.prompt"))
    // Cache the "userPrompt required" error, then fix the param without the
    // revalidation having run yet (still inside the inspector's debounce).
    store.getState().revalidateNode("n1")
    store.getState().updateNodeData("n1", { params: { userPrompt: "hello" } })
    store.getState().scheduleRevalidateNode("n1")
    expect(store.getState().validationByStepId.n1?.hasErrors).toBe(true)

    const result = await persistEditorWorkflow(store)

    expect(result.issueCount).toBe(0)
    expect(store.getState().validationByStepId).toEqual({})
    expect(store.getState().diagnostics.byNodeId.n1 ?? []).not.toContainEqual(
      expect.objectContaining({ code: "nodeParam" })
    )
  })

  it("counts an issue even when the validation cache was explicitly cleared", async () => {
    const store = createEditorStore(buildWorkflow("ai.prompt"))
    store.getState().clearValidation()
    expect(store.getState().validationByStepId).toEqual({})

    const result = await persistEditorWorkflow(store)

    expect(result.issueCount).toBe(1)
    expect(store.getState().validationByStepId.n1?.fields.userPrompt).toEqual({ key: "required" })
  })

  it("reports the issues of the snapshot it wrote even if params change during the write", async () => {
    const store = createEditorStore(buildWorkflow("ai.prompt"))
    replaceWorkflow.mockImplementationOnce(async (workflow: VisualWorkflow) => {
      // The user fills the field while the write is in flight.
      store.getState().updateNodeData("n1", { params: { userPrompt: "typed later" } })
      return { workflow: { ...workflow, updatedAt: 99 }, publicationInvalidated: false }
    })

    const result = await persistEditorWorkflow(store)

    // The toast describes what was written (still missing the prompt)…
    expect(result.issueCount).toBe(1)
    // …while the live cache reflects what is on screen now.
    expect(store.getState().validationByStepId).toEqual({})
  })

  it("syncs an invalidated publication without resetting graph or selection state", async () => {
    const workflow = {
      ...buildWorkflow("trigger.manual"),
      published: { at: 1, toolName: "wf_persist" },
      interface: { inputSchema: { type: "object" } },
    }
    const store = createEditorStore(workflow)
    store.getState().setSelectedNodes(["n1"])
    store.getState().setName("Edited")
    const historyLength = store.temporal.getState().pastStates.length
    replaceWorkflow.mockResolvedValueOnce({
      workflow: {
        ...store.getState().toWorkflow(),
        updatedAt: 100,
        published: undefined,
        interface: undefined,
      },
      publicationInvalidated: true,
    })

    const result = await persistEditorWorkflow(store)

    expect(result.publicationInvalidated).toBe(true)
    expect(store.getState().baseWorkflow.published).toBeUndefined()
    expect(store.getState().baseWorkflow.interface).toBeUndefined()
    expect(store.getState().selectedNodeIds).toEqual(["n1"])
    expect(store.getState().nodes).toHaveLength(1)
    expect(store.temporal.getState().pastStates).toHaveLength(historyLength)
  })
})

it("marks the persisted editor saved and forwards registration failure separately", async () => {
  const store = createEditorStore(buildWorkflow("trigger.manual"))
  store.getState().setName("Edited")
  replaceWorkflow.mockResolvedValueOnce({
    workflow: store.getState().toWorkflow(),
    publicationInvalidated: false,
    triggerRegistration: { ok: false, error: "offline" },
  } as never)
  const result = await persistEditorWorkflow(store)
  expect(store.getState().dirty).toBe(false)
  expect(result.triggerRegistration).toEqual({ ok: false, error: "offline" })
})
