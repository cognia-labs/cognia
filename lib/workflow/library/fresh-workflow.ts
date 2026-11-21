/**
 * Read a workflow for a run outside the editor UI (ADR-0254 §2): the
 * `/workflow` command, the eval target, anything that resolves a draft by id
 * and runs it.
 *
 * A playbook-derived row must run what its playbook compiles to now, so the
 * read goes through the `fresh-workflows` port the playbooks module provides.
 * When no provider is active, an ordinary row is returned as stored and a
 * derived row is reported `source-unavailable`: nothing can confirm it still
 * matches its source, and running it anyway is exactly the stale read this
 * exists to prevent.
 */

import { getWorkflow } from "@/lib/db/workflows"
import { loadPort } from "@/lib/modules/ports"
import type {
  FreshWorkflowRead,
  FreshWorkflowReadOptions,
} from "@/types/modules/ports/fresh-workflows"

export type { FreshWorkflowRead, FreshWorkflowReadOptions }

export async function readFreshWorkflow(
  workflowId: string,
  options: FreshWorkflowReadOptions = {}
): Promise<FreshWorkflowRead> {
  const provider = await loadPort("fresh-workflows")
  if (provider) return provider.read(workflowId, options)
  const stored = await (options.readWorkflow ?? getWorkflow)(workflowId)
  if (!stored) return { status: "not-found" }
  if (stored.derivedFrom?.kind === "playbook") {
    return { status: "source-unavailable", workflow: stored }
  }
  return { status: "ready", workflow: stored, dormantSteps: 0 }
}
