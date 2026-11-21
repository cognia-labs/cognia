// The playbooks module's implementation of the `fresh-workflows` port
// (`types/modules/ports/fresh-workflows.ts`, ADR-0250 §14): `loadFreshWorkflow`
// behind the narrow contract runners outside the UI read through.

import type { FreshWorkflowsPort } from "@/types/modules/ports/fresh-workflows"
import { defaultPlaybookWorkflowDeps, loadFreshWorkflow } from "./derived-workflow"

export const port: FreshWorkflowsPort = {
  async read(workflowId, options = {}) {
    const { readWorkflow, beforeWrite } = options
    const fresh = await loadFreshWorkflow(workflowId, {
      ...defaultPlaybookWorkflowDeps,
      ...(readWorkflow ? { getWorkflow: readWorkflow } : {}),
      putDerivedWorkflow: async (derived) => {
        beforeWrite?.()
        return defaultPlaybookWorkflowDeps.putDerivedWorkflow(derived)
      },
    })
    if (fresh.status === "ready") {
      return { status: "ready", workflow: fresh.workflow, dormantSteps: fresh.dormant.length }
    }
    if (fresh.status === "source-unavailable") {
      return { status: "source-unavailable", workflow: fresh.workflow }
    }
    return { status: "not-found" }
  },
}
