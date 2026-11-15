/**
 * Read-funnel normalization for the visual workflow JSON shape. Pure and
 * idempotent: resolves plugin-declared node kind aliases and returns the
 * workflow by reference when nothing changed. Only the current
 * `schemaVersion` is accepted — `validateWorkflow` refuses any other.
 *
 * Applied on the DB read funnel (`lib/db/workflows.ts`) and on editor load.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { resolveWorkflowKindAlias } from "./kind-aliases"

export function migrateWorkflow(wf: VisualWorkflow): VisualWorkflow {
  const nodes = wf.nodes.map((node) => {
    const type = resolveWorkflowKindAlias(node.type)
    return type === node.type ? node : { ...node, type }
  })
  const aliasesChanged = nodes.some((node, index) => node !== wf.nodes[index])
  return aliasesChanged ? { ...wf, nodes } : wf
}
