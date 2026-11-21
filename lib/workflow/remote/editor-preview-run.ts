/**
 * The mobile editor's Run, "Run from here" and "Run only this node" (WF-10,
 * WF-15): a draft PREVIEW of what the user saved, with the desktop canvas's
 * semantics, started wherever the workflow lives and answered with a run id
 * the client can open.
 *
 * The steps, in the order the desktop canvas takes them:
 *
 *  1. Blocking diagnostics stop the run before anything is saved or sent.
 *  2. A dirty editor is saved first, so the run executes what is on screen.
 *     An edit made while that save was in flight is saved once more.
 *  3. Where this process owns its workflows (a standalone phone), the preview
 *     runs here, on the copy just saved.
 *  4. On a paired client the save went to the Host through the outbound
 *     queue. The preview waits for the Host to have applied every queued
 *     write for this workflow, then asks the Host to run ITS saved copy
 *     (`workflow_preview_run`). A write the queue gave up on, or one that has
 *     not landed in time, is reported instead of running an older copy.
 *
 * A Host refusal (not found, invalid graph, unknown step) comes back as
 * `refused` with the Host's reason; anything else is thrown, the way the
 * desktop canvas surfaces an unexpected failure.
 */

import { persistEditorWorkflow } from "@/lib/workflow/editor/persist-workflow"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { transport } from "@/lib/tauri/transport-instance"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

import type { startWorkflowPreviewRun, WorkflowPreviewMode } from "./host-commands"
import { awaitWorkflowHostWritesSettled } from "./host-writes"
import { workflowRunRefusalOf } from "./run-rejection"
import { workflowWriteAuthority } from "./write-authority"

export type EditorPreviewRequest =
  { mode: "full" } | { mode: "from-step"; stepId: string } | { mode: "single-step"; stepId: string }

export type EditorPreviewOutcome =
  /** The run exists; open it at `/workflows/run?id=…&runId=…`. */
  | {
      status: "started"
      workflowId: string
      runId: string
      where: "host" | "local"
      /** Non-blocking diagnostics the run started with. */
      warningCount: number
    }
  /** Error-severity diagnostics; nothing was saved or started. */
  | { status: "blocked"; errorCount: number; warningCount: number }
  /** The Host (or its queue) refused; `reason` is a stable code, `detail` its words. */
  | { status: "refused"; reason: string; detail: string }
  /** The Host has not applied the save yet; it stays queued. */
  | { status: "host-pending" }

/** How long a paired preview waits for the Host to apply the save it runs. */
export const HOST_WRITE_SETTLE_TIMEOUT_MS = 15_000

export interface EditorPreviewDeps {
  authority: () => "local" | "host"
  persist: typeof persistEditorWorkflow
  awaitHostWrites: typeof awaitWorkflowHostWritesSettled
  callHost: (command: "workflow_preview_run", payload: Record<string, unknown>) => Promise<unknown>
  startLocal: typeof startWorkflowPreviewRun
}

const defaultDeps: EditorPreviewDeps = {
  authority: workflowWriteAuthority,
  persist: persistEditorWorkflow,
  awaitHostWrites: awaitWorkflowHostWritesSettled,
  callHost: (command, payload) => transport.call(command, payload),
  // The orchestrator loads only when this process runs the preview itself.
  startLocal: async (input, overrides) =>
    (await import("./host-commands")).startWorkflowPreviewRun(input, overrides),
}

/** Runs started from an editor have a person watching them (risk gates ask). */
const EDITOR_ORIGIN: WorkflowTriggeredFrom = { source: "ui" }

/** Save attempts for an editor that keeps changing while it saves. */
const MAX_SAVE_ATTEMPTS = 2

export async function startEditorPreviewRun(
  store: EditorStore,
  request: EditorPreviewRequest,
  overrides: Partial<EditorPreviewDeps> = {}
): Promise<EditorPreviewOutcome> {
  const deps: EditorPreviewDeps = { ...defaultDeps, ...overrides }
  const diagnostics = store.getState().recomputeDiagnostics()
  if (diagnostics.errorCount > 0) {
    return {
      status: "blocked",
      errorCount: diagnostics.errorCount,
      warningCount: diagnostics.warningCount,
    }
  }

  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS && store.getState().dirty; attempt++) {
    const saved = await deps.persist(store)
    if (!saved.editedDuringSave) break
  }

  const workflow = store.getState().toWorkflow()
  const mode: WorkflowPreviewMode = request.mode
  const stepId = request.mode === "full" ? undefined : request.stepId

  if (deps.authority() === "local") {
    const { runId } = await deps.startLocal(
      { workflowId: workflow.id, mode, ...(stepId ? { stepId } : {}), triggeredBy: EDITOR_ORIGIN },
      { getWorkflow: async (id) => (id === workflow.id ? workflow : undefined) }
    )
    return {
      status: "started",
      workflowId: workflow.id,
      runId,
      where: "local",
      warningCount: diagnostics.warningCount,
    }
  }

  const settlement = await deps.awaitHostWrites(workflow.id, {
    timeoutMs: HOST_WRITE_SETTLE_TIMEOUT_MS,
  })
  if (settlement.outcome === "pending") return { status: "host-pending" }
  if (settlement.outcome === "refused") {
    return { status: "refused", reason: "host_write_refused", detail: settlement.error }
  }

  try {
    const answer = await deps.callHost("workflow_preview_run", {
      workflowId: workflow.id,
      mode,
      ...(stepId ? { stepId } : {}),
    })
    const runId = (answer as { runId?: unknown } | null)?.runId
    if (typeof runId !== "string" || !runId) {
      throw new Error("workflow_preview_run answered without a run id")
    }
    return {
      status: "started",
      workflowId: workflow.id,
      runId,
      where: "host",
      warningCount: diagnostics.warningCount,
    }
  } catch (error) {
    const refusal = workflowRunRefusalOf(error)
    if (refusal) return { status: "refused", ...refusal }
    throw error
  }
}
