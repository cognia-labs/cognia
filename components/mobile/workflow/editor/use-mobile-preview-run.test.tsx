/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"

import { createEditorStore } from "@/lib/workflow/editor/store"
import type { EditorPreviewOutcome } from "@/lib/workflow/remote/editor-preview-run"
import type { VisualWorkflow } from "@/types/workflow/visual"

const startEditorPreviewRun = jest.fn<Promise<EditorPreviewOutcome>, unknown[]>()
jest.mock("@/lib/workflow/remote/editor-preview-run", () => ({
  startEditorPreviewRun: (...a: unknown[]) => startEditorPreviewRun(...a),
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

const toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), message: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toast.success(...a),
    error: (...a: unknown[]) => toast.error(...a),
    warning: (...a: unknown[]) => toast.warning(...a),
    message: (...a: unknown[]) => toast.message(...a),
  },
}))
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => ({ kind: "ok" })) }))
jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${ns}.${key}:${JSON.stringify(vars)}` : `${ns}.${key}`,
}))

import { useMobilePreviewRun } from "./use-mobile-preview-run"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_phone",
    schemaVersion: 2,
    name: "Phone",
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
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

const started: EditorPreviewOutcome = {
  status: "started",
  workflowId: "wf_phone",
  runId: "run_1",
  where: "host",
  warningCount: 0,
}

beforeEach(() => {
  startEditorPreviewRun.mockReset()
  push.mockReset()
  for (const fn of Object.values(toast)) fn.mockReset()
})

describe("useMobilePreviewRun", () => {
  it("opens the run a full preview started", async () => {
    startEditorPreviewRun.mockResolvedValue(started)
    const store = createEditorStore(buildWorkflow())
    const { result } = renderHook(() => useMobilePreviewRun(store))

    await act(() => result.current.run({ mode: "full" }))

    expect(startEditorPreviewRun).toHaveBeenCalledWith(store, { mode: "full" })
    expect(toast.success).toHaveBeenCalledWith("mobile.workflow.editor.previewStarted")
    expect(push).toHaveBeenCalledWith("/workflows/run?id=wf_phone&runId=run_1")
    expect(result.current.running).toBe(false)
  })

  // These requests come from the long-press sheet and the Inspector's Run
  // step; on a phone nothing consumed them before.
  it("consumes the editor's run-from-here and run-only-this-node requests", async () => {
    startEditorPreviewRun.mockResolvedValue(started)
    const store = createEditorStore(buildWorkflow())
    renderHook(() => useMobilePreviewRun(store))

    act(() => store.getState().requestRunFromStep("n_start"))
    await waitFor(() =>
      expect(startEditorPreviewRun).toHaveBeenCalledWith(store, {
        mode: "from-step",
        stepId: "n_start",
      })
    )
    expect(store.getState().requestedRunFromStepId).toBeNull()

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    act(() => store.getState().requestRunSingleStep("n_start"))
    await waitFor(() =>
      expect(startEditorPreviewRun).toHaveBeenCalledWith(store, {
        mode: "single-step",
        stepId: "n_start",
      })
    )
    expect(store.getState().requestedRunSingleStepId).toBeNull()
  })

  it("does not start a second run while one is starting", async () => {
    let finish: (outcome: EditorPreviewOutcome) => void = () => {}
    startEditorPreviewRun.mockImplementation(
      () => new Promise<EditorPreviewOutcome>((resolve) => (finish = resolve))
    )
    const store = createEditorStore(buildWorkflow())
    const { result } = renderHook(() => useMobilePreviewRun(store))

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = result.current.run({ mode: "full" })
      void result.current.run({ mode: "full" })
    })
    expect(startEditorPreviewRun).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.running).toBe(true))
    await act(async () => {
      finish(started)
      await first
    })
    expect(result.current.running).toBe(false)
  })

  it("points at the problems instead of running when diagnostics block it", async () => {
    startEditorPreviewRun.mockResolvedValue({ status: "blocked", errorCount: 2, warningCount: 0 })
    const store = createEditorStore(buildWorkflow())
    const onBlocked = jest.fn()
    const { result } = renderHook(() => useMobilePreviewRun(store, { onBlocked }))

    await act(() => result.current.run({ mode: "full" }))

    expect(toast.error).toHaveBeenCalledWith("workflows.diagnostics.blockedRunTitle", {
      description: 'workflows.diagnostics.blockedRunSummary:{"count":2}',
    })
    expect(store.getState().requestedProblemsPanel).toBe(true)
    expect(onBlocked).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: "host-pending" } as const, "message", "mobile.workflow.editor.previewHostPending"],
    [
      { status: "refused", reason: "host_write_refused", detail: "not found" } as const,
      "error",
      'mobile.workflow.editor.previewSaveRefused:{"detail":"not found"}',
    ],
    [
      { status: "refused", reason: "step_not_found", detail: "Step n_x" } as const,
      "error",
      'mobile.workflow.editor.previewRefused:{"detail":"Step n_x"}',
    ],
  ])("says why nothing ran (%o)", async (outcome, channel, text) => {
    startEditorPreviewRun.mockResolvedValue(outcome)
    const store = createEditorStore(buildWorkflow())
    const { result } = renderHook(() => useMobilePreviewRun(store))

    await act(() => result.current.run({ mode: "full" }))

    expect(toast[channel as keyof typeof toast]).toHaveBeenCalledWith(text)
    expect(push).not.toHaveBeenCalled()
  })

  it("warns about non-blocking diagnostics and reports a failure to start", async () => {
    startEditorPreviewRun.mockResolvedValueOnce({ ...started, warningCount: 3 })
    const store = createEditorStore(buildWorkflow())
    const { result } = renderHook(() => useMobilePreviewRun(store))
    await act(() => result.current.run({ mode: "full" }))
    expect(toast.warning).toHaveBeenCalledWith('workflows.diagnostics.runWithWarnings:{"count":3}')

    startEditorPreviewRun.mockRejectedValueOnce(new Error("offline"))
    await act(() => result.current.run({ mode: "full" }))
    expect(toast.error).toHaveBeenCalledWith(
      'mobile.workflow.editor.previewFailed:{"message":"offline"}'
    )
    expect(result.current.running).toBe(false)
  })
})
