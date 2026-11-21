// The `fresh-workflows` capability port (ADR-0254 §2, ADR-0250 §14): read a
// workflow the way every runner must. An ordinary row comes back as stored; a
// row derived from a playbook is first re-synced from its source skill, so no
// entry point runs a graph compiled from an older playbook.
//
// The playbooks module (`lib/playbooks/module.ts`) provides it. Runners outside
// the UI (the `/workflow` command, the eval target) ask through the workflow
// module's `lib/workflow/library/fresh-workflow.ts` instead of importing
// `lib/playbooks/`, which reads the skills and data layers those runners sit
// above. With no provider a derived row cannot be checked against its source,
// so it is reported unavailable rather than run stale.

import type { VisualWorkflow } from "@/types/workflow/visual"

export type FreshWorkflowRead =
  | {
      status: "ready"
      workflow: VisualWorkflow
      /** Playbook steps shown but not runnable in this version; a runner refuses while > 0. */
      dormantSteps: number
    }
  /**
   * Derived from a playbook that no longer compiles (gone, no longer a
   * playbook, invalid, too large), or no provider could check it. The stored
   * copy is returned so a caller can name it; it must not be run.
   */
  | { status: "source-unavailable"; workflow: VisualWorkflow }
  | { status: "not-found" }

export interface FreshWorkflowReadOptions {
  /** Read the stored row from a scoped database; defaults to the active one. */
  readWorkflow?: (workflowId: string) => Promise<VisualWorkflow | undefined>
  /** Runs right before a refreshed derived row is written; throw to stop the write. */
  beforeWrite?: () => void
}

export interface FreshWorkflowsPort {
  read(workflowId: string, options?: FreshWorkflowReadOptions): Promise<FreshWorkflowRead>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "fresh-workflows": FreshWorkflowsPort
  }
}
