/**
 * A workflow library's Run on a phone (WF-10): a formal run of the PUBLISHED
 * workflow, where it lives.
 *
 * On a paired phone the run is queued to the Host (`workflow_trigger_manual`),
 * which admits the published deployment and answers with the run, or refuses
 * with a reason the queue keeps (`lib/workflow/remote/host-commands.ts`). A
 * workflow the synced row says is not published is not queued at all: it
 * could only be refused, and "queued" was the one thing the phone used to say
 * while the Host quietly ran nothing. Its editor's Run previews the draft.
 *
 * A standalone phone owns its workflows, and no queue runner serves it, so
 * the run happens here, the way the desktop library runs one: the published
 * deployment when there is one, otherwise a preview of the saved draft.
 */

import { enqueueUnlessQueued } from "@/lib/db/mobile-outbound-queue"
import type { VisualWorkflow, WorkflowTriggeredFrom } from "@/types/workflow/visual"

import type { startWorkflowPreviewRun, triggerPublishedWorkflowRun } from "./host-commands"
import { workflowRunRefusalOf } from "./run-rejection"
import { workflowWriteAuthority } from "./write-authority"

export type LibraryRunOutcome =
  /** Paired: waiting in the queue for the Host. */
  | { status: "queued" }
  /** Paired: a run of this workflow is already waiting; no second one. */
  | { status: "already-queued" }
  /** Paired: only a published workflow runs from the library. */
  | { status: "not-published" }
  /** Standalone: the run exists here. */
  | { status: "started"; workflowId: string; runId: string }
  /** Standalone: placement chose another Host for the published run. */
  | { status: "handed-off"; targetRef: string }
  /** Standalone: admission refused it. */
  | { status: "refused"; reason: string; detail: string }

export interface LibraryRunDeps {
  authority: () => "local" | "host"
  enqueueUnlessQueued: typeof enqueueUnlessQueued
  triggerPublished: typeof triggerPublishedWorkflowRun
  startPreview: typeof startWorkflowPreviewRun
}

const defaultDeps: LibraryRunDeps = {
  authority: workflowWriteAuthority,
  enqueueUnlessQueued,
  // The orchestrator loads only on a phone that runs the workflow itself; a
  // paired phone's library never needs it.
  triggerPublished: async (input) =>
    (await import("./host-commands")).triggerPublishedWorkflowRun(input),
  startPreview: async (input) => (await import("./host-commands")).startWorkflowPreviewRun(input),
}

/** A library Run has a person in front of it (risk gates ask them). */
const LIBRARY_ORIGIN: WorkflowTriggeredFrom = { source: "ui" }

export async function runWorkflowFromLibrary(
  workflow: Pick<VisualWorkflow, "id" | "name" | "published">,
  overrides: Partial<LibraryRunDeps> = {}
): Promise<LibraryRunOutcome> {
  const deps: LibraryRunDeps = { ...defaultDeps, ...overrides }

  if (deps.authority() === "host") {
    if (!workflow.published) return { status: "not-published" }
    const { alreadyQueued } = await deps.enqueueUnlessQueued({
      command: "workflow_trigger_manual",
      payload: { workflowId: workflow.id },
      label: workflow.name,
    })
    return alreadyQueued ? { status: "already-queued" } : { status: "queued" }
  }

  try {
    if (!workflow.published) {
      const { runId } = await deps.startPreview({
        workflowId: workflow.id,
        mode: "full",
        triggeredBy: LIBRARY_ORIGIN,
      })
      return { status: "started", workflowId: workflow.id, runId }
    }
    const accepted = await deps.triggerPublished({
      workflowId: workflow.id,
      triggeredBy: LIBRARY_ORIGIN,
    })
    return accepted.status === "admitted"
      ? { status: "started", workflowId: workflow.id, runId: accepted.runId }
      : { status: "handed-off", targetRef: accepted.targetRef }
  } catch (error) {
    const refusal = workflowRunRefusalOf(error)
    if (refusal) return { status: "refused", ...refusal }
    throw error
  }
}
