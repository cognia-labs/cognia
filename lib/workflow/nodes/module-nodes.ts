/**
 * The node executors feature modules contribute (ADR-0250 §14
 * `workflowNodes`). A module that owns a node family declares it in its
 * manifest; the generated registry (`lib/modules/generated/workflow-nodes.ts`)
 * lists one lazy import per module, and this loader runs them, so the
 * workflow engine never imports a feature module's code itself.
 *
 * Importing a contribution registers its executors, as every node family
 * does. The file also names the kinds it registers (`workflowNodeKinds`),
 * which are checked once the import has run: a declared kind that is still
 * missing is logged, and the run that needs it fails the way any
 * unregistered kind does ("no executor registered").
 *
 * The step executor awaits this before it looks an executor up; the
 * built-in family list starts it when the engine is imported, so module
 * executors register about as early as the built-ins did. Each module loads
 * once; one that fails is left out and tried again on the next call, and
 * never keeps the others from loading. An `experimental` module contributes
 * nothing, as with every other contribution.
 */

import { loggers } from "@cognia/logging"
import type { ModuleWorkflowNodesEntry } from "@/lib/modules/manifest-types"
import { MODULE_WORKFLOW_NODES } from "@/lib/modules/generated/workflow-nodes"
import { listRegisteredKinds } from "./registry"

const loaded = new Set<string>()
let pending: Promise<void> | null = null
let entries: readonly ModuleWorkflowNodesEntry[] = MODULE_WORKFLOW_NODES

async function loadEntry(entry: ModuleWorkflowNodesEntry): Promise<void> {
  try {
    const { workflowNodeKinds } = await entry.load()
    loaded.add(entry.module)
    const registered = new Set(listRegisteredKinds())
    const missing = workflowNodeKinds.filter((kind) => !registered.has(kind))
    if (missing.length > 0)
      loggers.app.error("workflow nodes a module declares were not registered", {
        module: entry.module,
        missing,
      })
  } catch (error) {
    loggers.app.error("workflow node contribution failed to load", {
      module: entry.module,
      error: String(error),
    })
  }
}

/** Load every contributing module's node executors that are not loaded yet. */
export function loadModuleWorkflowNodes(): Promise<void> {
  if (pending) return pending
  const due = entries.filter((entry) => entry.stage !== "experimental" && !loaded.has(entry.module))
  if (due.length === 0) return Promise.resolve()
  pending = Promise.all(due.map(loadEntry)).then(() => {
    pending = null
  })
  return pending
}

/** Replace the registry the loader reads, and forget what it loaded. */
export function __setModuleWorkflowNodesForTesting(
  next: readonly ModuleWorkflowNodesEntry[] | null
): void {
  entries = next ?? MODULE_WORKFLOW_NODES
  loaded.clear()
  pending = null
}
