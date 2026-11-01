/**
 * Webhook trigger bridge — extracts the `trigger.webhook` and `trigger.cron`
 * nodes from a workflow snapshot and registers / unregisters them with the
 * Rust side via `registerTrigger` / `unregisterTrigger`.
 *
 * Called from the canvas save path so the local webhook router knows about
 * every workflow as soon as the user saves. In web mode the underlying
 * `safeInvoke` calls all no-op gracefully.
 */

import { recordTriggerRegistration } from "./trigger-registration-health"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { validateWorkflowCronExpression } from "@/lib/scheduler/cron-parser"
import {
  syncPluginTriggerInstances,
  unsyncPluginTriggerInstances,
} from "@/lib/workflow/triggers/lifecycle"
import { registerTrigger, unregisterTrigger, getWebhookUrl } from "./tauri-bridge"

interface FileWatchParams {
  root?: string
  globs?: string[]
  ignoreGlobs?: string[]
  respectGitignore?: boolean
  events?: string[]
  recursive?: boolean
  debounceMs?: number
  settleMs?: number
  catchUpOnStart?: boolean
  maxFiresPerMinute?: number
}

interface WebhookParams {
  path?: string
  method?: string
  hmacSecret?: string
  deliveryIdHeader?: string
  responseStatus?: number
  responseTemplate?: string
  responseTimeoutMs?: number
}

interface CronParams {
  cron?: string
  timezone?: string
}

const SYNCED_TRIGGER_KINDS = new Set<WorkflowNode["type"]>([
  "trigger.manual",
  "trigger.cron",
  "trigger.connector.inbound",
  "trigger.connector.system",
  "trigger.chat.message",
  "trigger.goal.completed",
  "trigger.webhook",
  "trigger.team",
  "trigger.desktop.event",
  "trigger.terminal.command",
  "trigger.pet.event",
  "trigger.workflow.completed",
  "trigger.plan.event",
  "trigger.scheduler.taskCompleted",
  "trigger.capture.item",
  "trigger.memory.written",
  "trigger.file.watch",
])

const syncedTriggersByWorkflow = new Map<string, Map<string, WorkflowNode["type"]>>()

/**
 * One sync or unsync per workflow at a time. Registrations await the native
 * plane; an unsync that ran meanwhile would drop the projection map, and the
 * late registration would then land in a map nothing tracks, leaving a live
 * cron / webhook / file watch no later sync can find to remove.
 */
const triggerOperationQueues = new Map<string, Promise<void>>()

function serializeTriggerOperation(workflowId: string, run: () => Promise<void>): Promise<void> {
  const previous = triggerOperationQueues.get(workflowId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(run)
  const tail = next.catch(() => undefined)
  triggerOperationQueues.set(workflowId, tail)
  void tail.then(() => {
    if (triggerOperationQueues.get(workflowId) === tail) triggerOperationQueues.delete(workflowId)
  })
  return next
}

interface TriggerSyncOptions {
  signal?: AbortSignal
}

/**
 * Push every trigger node in `workflow` to Rust. Uses the node id as the
 * trigger id so the registry stays stable across saves.
 *
 * The module retains the last successful projection so removed, disabled, or
 * kind-changed nodes are unregistered before the current projection is
 * upserted. Rust restarts with the desktop process, so rebuilding this map on
 * renderer boot is sufficient; every active workflow is synced at startup.
 */
export function syncWorkflowTriggers(
  workflow: VisualWorkflow,
  options: TriggerSyncOptions = {}
): Promise<void> {
  return serializeTriggerOperation(workflow.id, () => syncWorkflowTriggersNow(workflow, options))
}

async function syncWorkflowTriggersNow(
  workflow: VisualWorkflow,
  options: TriggerSyncOptions
): Promise<void> {
  if (options.signal?.aborted) return
  const triggers =
    workflow.isTemplate || workflow.isBuiltIn
      ? []
      : workflow.nodes.filter((node) => !node.data.disabled && SYNCED_TRIGGER_KINDS.has(node.type))
  const invalid: Array<{ node: WorkflowNode; error: unknown }> = []
  for (const node of triggers) {
    try {
      validateTriggerForSync(node)
    } catch (error) {
      invalid.push({ node, error })
    }
  }
  if (invalid.length) {
    // Do not leave an older valid schedule active after an invalid save.
    try {
      await unsyncWorkflowTriggersNow(workflow)
    } finally {
      for (const { node, error } of invalid) {
        recordTriggerRegistration({
          workflowId: workflow.id,
          triggerId: node.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    throw invalid[0].error
  }

  const previous = syncedTriggersByWorkflow.get(workflow.id) ?? new Map()
  syncedTriggersByWorkflow.set(workflow.id, previous)
  const desired = new Map(triggers.map((node) => [node.id, node.type]))
  const staleIds = [...previous].flatMap(([triggerId, kind]) =>
    desired.get(triggerId) === kind ? [] : [triggerId]
  )
  await settleTriggerOperations(
    staleIds.map((triggerId) => unregisterWithHealth(workflow.id, triggerId))
  )
  if (options.signal?.aborted) return

  // A workflow with an `io.webhook.respond` node wants the receiver to hold
  // the inbound request open for a dynamic reply. Computed once and threaded
  // into every webhook trigger so the opt-in is implicit (no extra config).
  const awaitResponse = workflow.nodes.some((n) => n.type === "io.webhook.respond")
  await settleTriggerOperations(
    triggers.map(async (node) => {
      try {
        const registered = await syncOneTrigger(workflow.id, node, awaitResponse, workflow)
        if (registered) previous.set(node.id, node.type)
        recordTriggerRegistration({
          workflowId: workflow.id,
          triggerId: node.id,
          status: registered ? "registered" : "skipped",
        })
      } catch (error) {
        recordTriggerRegistration({
          workflowId: workflow.id,
          triggerId: node.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })
  )
  if (options.signal?.aborted) return
  await syncPluginTriggerInstances(workflow)
}

function validateTriggerForSync(node: WorkflowNode): void {
  if (node.type === "trigger.file.watch") {
    // Checked here as well as in Rust, for the same reason the cron
    // expression is: a registration that will be refused should fail where the
    // author is standing, not later in a daemon nobody is looking at. Rust
    // remains the authority, and refuses the overbroad roots this cannot see.
    const root = ((node.data.params ?? {}) as FileWatchParams).root?.trim() ?? ""
    if (!root) {
      throw new Error("Cannot register a file watch with no root directory")
    }
    if (!root.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(root)) {
      throw new Error(
        `Cannot register a file watch on '${root}': the root has to be an absolute path`
      )
    }
    return
  }
  if (node.type !== "trigger.cron") return
  const expression = ((node.data.params ?? {}) as CronParams).cron ?? ""
  const validation = validateWorkflowCronExpression(expression)
  if (!validation.valid) {
    throw new Error(
      "Cannot register workflow cron '" +
        expression +
        "': " +
        (validation.error ?? "invalid expression")
    )
  }
}

/**
 * A file watch registers on the machine whose daemon answers, which is this
 * one. A workflow pinned to a different Host would therefore watch the WRONG
 * disk and fire on churn that has nothing to do with its own run.
 *
 * Only `pinned` is refused. `colocate` and `auto` both mean "wherever this
 * runs", and this is where it is running.
 */
function watchesTheWrongDisk(workflow: VisualWorkflow): boolean {
  const runOn = workflow.settings?.runOn
  return runOn?.mode === "pinned"
}

async function syncOneTrigger(
  workflowId: string,
  node: WorkflowNode,
  awaitResponse: boolean,
  workflow: VisualWorkflow
): Promise<boolean> {
  const baseInput = {
    workflowId,
    triggerId: node.id,
    kind: node.type,
    enabled: true,
  }
  const params = (node.data.params ?? {}) as Record<string, unknown>
  switch (node.type) {
    case "trigger.cron": {
      const cronParams = params as CronParams
      const expression = cronParams.cron ?? ""
      await registerTrigger({
        ...baseInput,
        cron: expression,
        timezone: cronParams.timezone,
      })
      return true
    }
    case "trigger.webhook": {
      const webhookParams = params as WebhookParams
      await registerTrigger({
        ...baseInput,
        webhookPath: webhookParams.path,
        webhookMethod: webhookParams.method,
        webhookHmacSecret: webhookParams.hmacSecret,
        webhookResponseStatus: webhookParams.responseStatus,
        webhookResponseBody: webhookParams.responseTemplate,
        webhookAwaitResponse: awaitResponse,
        webhookResponseTimeoutMs:
          typeof webhookParams.responseTimeoutMs === "number"
            ? webhookParams.responseTimeoutMs
            : undefined,
        webhookDeliveryIdHeader: webhookParams.deliveryIdHeader?.trim() || undefined,
      })
      return true
    }
    case "trigger.file.watch": {
      if (watchesTheWrongDisk(workflow)) {
        // The Host the run is pinned to installs its own watch from its own
        // boot sync. Registering here would watch this machine's disk for a
        // run that happens somewhere else.
        return false
      }
      const watchParams = params as FileWatchParams
      await registerTrigger({
        ...baseInput,
        fileWatchRoot: watchParams.root,
        fileWatchGlobs: watchParams.globs,
        fileWatchIgnoreGlobs: watchParams.ignoreGlobs,
        fileWatchRespectGitignore: watchParams.respectGitignore,
        fileWatchEvents: watchParams.events,
        fileWatchRecursive: watchParams.recursive,
        fileWatchDebounceMs: watchParams.debounceMs,
        fileWatchSettleMs: watchParams.settleMs,
        fileWatchCatchUpOnStart: watchParams.catchUpOnStart,
        fileWatchMaxFiresPerMinute: watchParams.maxFiresPerMinute,
      })
      return true
    }
    case "trigger.connector.inbound":
    case "trigger.connector.system":
    case "trigger.chat.message":
    case "trigger.goal.completed":
    case "trigger.workflow.completed":
    case "trigger.terminal.command":
    case "trigger.desktop.event":
    case "trigger.pet.event":
    case "trigger.team":
    case "trigger.manual":
      // No Rust state for these — they ride existing TS hooks or synthesized runs.
      await registerTrigger(baseInput)
      return true
    default:
      return false
  }
}

/**
 * Unregister every trigger node in `workflow`. Called when a workflow is
 * deleted; idempotent for nodes not previously registered.
 */
export function unsyncWorkflowTriggers(workflow: VisualWorkflow): Promise<void> {
  return serializeTriggerOperation(workflow.id, () => unsyncWorkflowTriggersNow(workflow))
}

async function unsyncWorkflowTriggersNow(workflow: VisualWorkflow): Promise<void> {
  const triggerIds = new Set(
    workflow.nodes.filter((node) => node.type.startsWith("trigger.")).map((node) => node.id)
  )
  for (const triggerId of syncedTriggersByWorkflow.get(workflow.id)?.keys() ?? []) {
    triggerIds.add(triggerId)
  }
  await settleTriggerOperations(
    [...triggerIds].map((triggerId) => unregisterWithHealth(workflow.id, triggerId))
  )
  syncedTriggersByWorkflow.delete(workflow.id)
  await unsyncPluginTriggerInstances(workflow)
}

async function settleTriggerOperations(operations: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations)
  const failed = results.find((result) => result.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason
}

async function unregisterWithHealth(workflowId: string, triggerId: string): Promise<void> {
  try {
    await unregisterTrigger(workflowId, triggerId)
    syncedTriggersByWorkflow.get(workflowId)?.delete(triggerId)
    recordTriggerRegistration({ workflowId, triggerId, status: "unregistered" })
  } catch (error) {
    recordTriggerRegistration({
      workflowId,
      triggerId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** Test-only reset for the renderer-local registration projection. */
export function _resetSyncedTriggerStateForTest(): void {
  syncedTriggersByWorkflow.clear()
  triggerOperationQueues.clear()
}

/** Re-export so the inspector form can show the URL without a second hop. */
export { getWebhookUrl }
