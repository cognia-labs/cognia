/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))

import { CompanionError } from "@/lib/tauri/transport-companion"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

import {
  HOST_WRITE_SETTLE_TIMEOUT_MS,
  startEditorPreviewRun,
  type EditorPreviewDeps,
} from "./editor-preview-run"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_mobile",
    schemaVersion: 2,
    name: "Mobile",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Start", params: {} },
      },
      {
        id: "n_end",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "End", params: { variable: "done", value: "yes" } },
      },
    ],
    edges: [{ id: "e1", source: "n_start", target: "n_end" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

/** The fixture's non-blocking diagnostics, which a started run reports. */
function fixtureWarnings(): number {
  return createEditorStore(buildWorkflow()).getState().recomputeDiagnostics().warningCount
}

function deps(overrides: Partial<EditorPreviewDeps> = {}) {
  const persist = jest.fn(async (store: ReturnType<typeof createEditorStore>) => {
    store.getState().markSaved(store.getState().toWorkflow(), {
      revision: store.getState().editRevision,
    })
    return {
      issueCount: 0,
      publicationInvalidated: false,
      editedDuringSave: false,
      hostWrite: true,
    }
  })
  const base = {
    authority: jest.fn((): "local" | "host" => "host"),
    persist,
    awaitHostWrites: jest.fn(
      async (_workflowId: string, _options: { timeoutMs: number; pollMs?: number }) => ({
        outcome: "settled" as const,
      })
    ),
    callHost: jest.fn(
      async (_command: "workflow_preview_run", _payload: Record<string, unknown>) => ({
        runId: "run_host",
      })
    ),
    startLocal: jest.fn(async (_input: unknown, _overrides?: unknown) => ({ runId: "run_local" })),
  } satisfies EditorPreviewDeps
  // An override replaces its mock; the tests only inspect the ones they keep.
  return { ...base, ...overrides } as typeof base
}

describe("startEditorPreviewRun", () => {
  it("saves a dirty editor, waits for the Host to apply it, then previews the Host's copy", async () => {
    const store = createEditorStore(buildWorkflow())
    store.getState().setName("Edited on the phone")
    const d = deps()

    const outcome = await startEditorPreviewRun(store, { mode: "full" }, d)

    expect(d.persist).toHaveBeenCalledTimes(1)
    expect(d.awaitHostWrites).toHaveBeenCalledWith("wf_mobile", {
      timeoutMs: HOST_WRITE_SETTLE_TIMEOUT_MS,
    })
    // The save is settled before the run is asked for.
    expect(d.awaitHostWrites.mock.invocationCallOrder[0]).toBeLessThan(
      d.callHost.mock.invocationCallOrder[0]
    )
    expect(d.callHost).toHaveBeenCalledWith("workflow_preview_run", {
      workflowId: "wf_mobile",
      mode: "full",
    })
    expect(outcome).toEqual({
      status: "started",
      workflowId: "wf_mobile",
      runId: "run_host",
      where: "host",
      warningCount: fixtureWarnings(),
    })
  })

  it("sends the step for run-from-here and run-only-this-node", async () => {
    const d = deps()
    await startEditorPreviewRun(
      createEditorStore(buildWorkflow()),
      { mode: "from-step", stepId: "n_end" },
      d
    )
    await startEditorPreviewRun(
      createEditorStore(buildWorkflow()),
      { mode: "single-step", stepId: "n_end" },
      d
    )
    expect(d.callHost.mock.calls.map((call) => call[1])).toEqual([
      { workflowId: "wf_mobile", mode: "from-step", stepId: "n_end" },
      { workflowId: "wf_mobile", mode: "single-step", stepId: "n_end" },
    ])
    // Nothing was dirty, so nothing was saved.
    expect(d.persist).not.toHaveBeenCalled()
  })

  it("saves again when the editor changed during the first save", async () => {
    const store = createEditorStore(buildWorkflow())
    store.getState().setName("one")
    const d = deps()
    d.persist.mockImplementationOnce(async (s) => {
      const revision = s.getState().editRevision
      s.getState().setName("two")
      s.getState().markSaved(s.getState().toWorkflow(), { revision })
      return {
        issueCount: 0,
        publicationInvalidated: false,
        editedDuringSave: true,
        hostWrite: true,
      }
    })
    await startEditorPreviewRun(store, { mode: "full" }, d)
    expect(d.persist).toHaveBeenCalledTimes(2)
  })

  it("runs locally on the copy just saved where this process owns its workflows", async () => {
    const store = createEditorStore(buildWorkflow())
    const d = deps({ authority: () => "local" })

    const outcome = await startEditorPreviewRun(store, { mode: "single-step", stepId: "n_end" }, d)

    expect(outcome).toEqual({
      status: "started",
      workflowId: "wf_mobile",
      runId: "run_local",
      where: "local",
      warningCount: fixtureWarnings(),
    })
    expect(d.callHost).not.toHaveBeenCalled()
    expect(d.awaitHostWrites).not.toHaveBeenCalled()
    const [input, overrides] = d.startLocal.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { getWorkflow: (id: string) => Promise<VisualWorkflow | undefined> },
    ]
    expect(input).toEqual({
      workflowId: "wf_mobile",
      mode: "single-step",
      stepId: "n_end",
      triggeredBy: { source: "ui" },
    })
    // The editor's copy, not some other row.
    await expect(overrides.getWorkflow("wf_mobile")).resolves.toMatchObject({ id: "wf_mobile" })
    await expect(overrides.getWorkflow("wf_other")).resolves.toBeUndefined()
  })

  it("does not start a run that blocking diagnostics would fail", async () => {
    const workflow = buildWorkflow()
    // A dangling edge is an error-severity structural diagnostic.
    workflow.edges.push({ id: "e_bad", source: "n_end", target: "n_missing" })
    const store = createEditorStore(workflow)
    const d = deps()
    const outcome = await startEditorPreviewRun(store, { mode: "full" }, d)
    expect(outcome.status).toBe("blocked")
    expect(d.persist).not.toHaveBeenCalled()
    expect(d.callHost).not.toHaveBeenCalled()
  })

  it("reports a save the Host has not applied yet instead of running an older copy", async () => {
    const d = deps({ awaitHostWrites: jest.fn(async () => ({ outcome: "pending" as const })) })
    await expect(
      startEditorPreviewRun(createEditorStore(buildWorkflow()), { mode: "full" }, d)
    ).resolves.toEqual({ status: "host-pending" })
    expect(d.callHost).not.toHaveBeenCalled()
  })

  it("reports a save the queue gave up on", async () => {
    const d = deps({
      awaitHostWrites: jest.fn(async () => ({
        outcome: "refused" as const,
        command: "workflow_update",
        error: "workflow_update: workflow wf_mobile not found",
      })),
    })
    await expect(
      startEditorPreviewRun(createEditorStore(buildWorkflow()), { mode: "full" }, d)
    ).resolves.toEqual({
      status: "refused",
      reason: "host_write_refused",
      detail: "workflow_update: workflow wf_mobile not found",
    })
    expect(d.callHost).not.toHaveBeenCalled()
  })

  it("returns the Host's refusal with its reason and rethrows transport failures", async () => {
    const refused = deps({
      callHost: jest.fn(async () => {
        throw new CompanionError({
          code: "workflow_run_rejected",
          message: "step_not_found: Step n_x is not in workflow wf_mobile",
          retryable: false,
        })
      }),
    })
    await expect(
      startEditorPreviewRun(createEditorStore(buildWorkflow()), { mode: "full" }, refused)
    ).resolves.toEqual({
      status: "refused",
      reason: "step_not_found",
      detail: "Step n_x is not in workflow wf_mobile",
    })

    const offline = deps({
      callHost: jest.fn(async () => {
        throw new CompanionError({ code: "network", message: "offline: no route", retryable: true })
      }),
    })
    await expect(
      startEditorPreviewRun(createEditorStore(buildWorkflow()), { mode: "full" }, offline)
    ).rejects.toThrow("offline: no route")
  })
})
