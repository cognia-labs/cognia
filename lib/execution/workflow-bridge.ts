import Dexie, { type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  putExecutionRunBinding,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { listForWorkflow } from "@/lib/db/workflow-fanout-subscriptions"
import { topoSort } from "@/lib/workflow/runtime/topo-sort"
import { mapWorkflowRunEvent } from "@/lib/execution/sources/workflow"
import type { WorkflowFanoutSubscriptionRow } from "@/lib/db/connector-types"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import { getConnectorConversationState } from "@/lib/db/connector-conversation-state"
import type { ExecutionRunKind, PrincipalRefV1, RunTriggerV1 } from "@/types/execution/run"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { startAgentStateExecutionBridge } from "./agent-state-bridge"
import {
  authorityFromPermissionCeiling,
  recordedRunMetadata,
  requestersFromRunOrigin,
  runTriggerFromOrigin,
  connectorRequester,
} from "./acting-authority"

function recordedWorkflowTrigger(row: WorkflowRunRow): RunTriggerV1 {
  if (row.lineage?.retryOfRunId || row.lineage?.parentRunId) return "child"
  if (row.triggerKind === "trigger.cron") return "schedule"
  if (row.triggerKind === "trigger.connector.inbound") return "requester"
  if (["trigger.manual", "trigger.team", "trigger.chat.message"].includes(row.triggerKind)) {
    // triggeredBySource defaults to "ui" even for automatic events; it is an
    // index value, not evidence that a person started this run.
    const origin = row.triggeredBy
    if (!origin && row.triggerKind === "trigger.manual") return "local"
    return runTriggerFromOrigin(origin)
  }
  // Webhooks, integration/system events and unknown automatic trigger kinds.
  return "external-event"
}

function workflowEventActors(row: WorkflowRunRow): PrincipalRefV1[] {
  const payload = row.triggerPayload as {
    actor?: { id?: unknown; label?: unknown; displayName?: unknown }
    event?: { actor?: { id?: unknown; label?: unknown; displayName?: unknown } }
    sender?: { remoteUserId?: unknown; displayName?: unknown }
  } | null
  const actor =
    row.triggerKind === "trigger.integration.event"
      ? (payload?.actor ?? payload?.event?.actor)
      : undefined
  const sender = row.triggerKind === "trigger.connector.system" ? payload?.sender : undefined
  const initiator = row.triggeredBy?.initiator
  const id =
    actor?.id ?? sender?.remoteUserId ?? initiator?.remoteUserId ?? initiator?.platformIdentityId
  const name = actor?.label ?? actor?.displayName ?? sender?.displayName ?? initiator?.displayName
  if (typeof id !== "string" && typeof name !== "string") return []
  return [
    {
      kind: "event-actor",
      source: row.triggerKind,
      ...(typeof id === "string" ? { externalId: id } : {}),
      ...(typeof name === "string" ? { displayName: name } : {}),
    },
  ]
}

function workflowRequesters(row: WorkflowRunRow): PrincipalRefV1[] {
  const known = requestersFromRunOrigin(row.triggeredBy)
  if (known.length || row.triggerKind !== "trigger.connector.inbound") return known
  const event = row.triggerPayload as NormalizedInboundEvent | null
  return event &&
    typeof event.platform === "string" &&
    typeof event.adapterId === "string" &&
    typeof event.sender?.remoteUserId === "string"
    ? [connectorRequester(event)]
    : []
}

export function workflowExecutionRunId(sourceRunId: string): string {
  return `execution:workflow:${sourceRunId}`
}

function bindingId(runId: string, adapterId: string, conversationKey: string): string {
  return `execution-binding:${runId}:${adapterId}:${conversationKey}`
}

export function executionKindForWorkflowRun(sourceRun: WorkflowRunRow): ExecutionRunKind {
  if (sourceRun.triggerKind === "trigger.team") return "team"
  if (sourceRun.triggerKind === "trigger.cron") return "scheduled"
  return "workflow"
}

function stepPlan(row: WorkflowRunRow): Array<{ id: string; title: string }> {
  const labels = new Map(row.workflowSnapshot.nodes.map((node) => [node.id, node.data.label]))
  return topoSort(row.workflowSnapshot)
    .order.filter((id) => {
      const node = row.workflowSnapshot.nodes.find((candidate) => candidate.id === id)
      return node && !node.type.startsWith("trigger.")
    })
    .map((id) => ({ id, title: labels.get(id) ?? id }))
}

export async function syncWorkflowExecutionRun(
  sourceRun: WorkflowRunRow,
  sourceEvents: readonly WorkflowRunEventRow[],
  subscriptions: readonly WorkflowFanoutSubscriptionRow[]
): Promise<void> {
  const runId = workflowExecutionRunId(sourceRun.id)
  let run = await getExecutionRun(runId)
  if (!run) {
    const trigger = recordedWorkflowTrigger(sourceRun)
    try {
      await createExecutionRun({
        id: runId,
        ...recordedRunMetadata(trigger, {
          runId,
          authority: authorityFromPermissionCeiling(sourceRun.securityContext?.permissionCeiling),
          requesters: trigger === "requester" ? workflowRequesters(sourceRun) : [],
          ...(trigger === "external-event" ? { eventActors: workflowEventActors(sourceRun) } : {}),
          parent: sourceRun.lineage?.parentRunId
            ? await getExecutionRun(workflowExecutionRunId(sourceRun.lineage.parentRunId)).catch(
                () => undefined
              )
            : undefined,
        }),
        kind: executionKindForWorkflowRun(sourceRun),
        // A retry is a REPLACEMENT, not a stranger: `lineage.retryOfRunId` is
        // already persisted on the new workflow row, so the parent link is
        // derived here rather than coordinated with whoever pressed the button.
        // That also makes a retry started from the desktop history view join
        // the same chain as one driven through the run-control gate.
        ...(sourceRun.lineage?.retryOfRunId
          ? { parentRunId: workflowExecutionRunId(sourceRun.lineage.retryOfRunId) }
          : {}),
        sourceId: sourceRun.id,
        sessionId: sourceRun.triggeredBy?.sessionId,
        projectId: sourceRun.projectId,
        title: sourceRun.title ?? sourceRun.workflowSnapshot.name,
        initiator: sourceRun.triggeredBy?.initiator,
        status: "running",
        currentRevision: 0,
        startedAt: sourceRun.startedAt,
        updatedAt: sourceRun.startedAt,
      })
      await runEventJournal.appendBatch(runId, [
        semanticRunEvent(
          "plan.created",
          {
            version: 1,
            steps: stepPlan(sourceRun),
            workflowGraph: {
              workflowId: sourceRun.workflowId,
              sourceRunId: sourceRun.id,
              edges: sourceRun.workflowSnapshot.edges.map(({ source, target }) => ({
                source,
                target,
              })),
            },
          },
          { ts: sourceRun.startedAt, sourceEventId: `workflow:${sourceRun.id}:plan` }
        ),
        semanticRunEvent(
          "run.started",
          {},
          { ts: sourceRun.startedAt, sourceEventId: `workflow:${sourceRun.id}:started` }
        ),
      ])
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConstraintError")) throw error
    }
    run = await getExecutionRun(runId)
  }
  if (!run) throw new Error(`Failed to create execution run ${runId}`)

  const origin = sourceRun.triggeredBy
  const destinations = [
    ...(origin?.adapterId && origin.conversationKey
      ? [
          {
            adapterId: origin.adapterId,
            conversationKey: origin.conversationKey,
            sourceMessageId: origin.sourceMessageId,
            deliveryTarget: origin.deliveryTarget,
          },
        ]
      : []),
    ...subscriptions
      .filter((subscription) => subscription.enabled)
      .map((subscription) => ({
        adapterId: subscription.adapterId,
        conversationKey: subscription.conversationKey,
      })),
  ]
  const unique = new Map(
    destinations.map((target) => [`${target.adapterId}:${target.conversationKey}`, target])
  )
  for (const target of unique.values()) {
    const id = bindingId(runId, target.adapterId, target.conversationKey)
    const existing = await getDb().executionRunBindings.get(id)
    if (existing) continue
    const deliveryTarget =
      ("deliveryTarget" in target ? target.deliveryTarget : undefined) ??
      (await getConnectorConversationState(target.conversationKey))?.deliveryTarget
    await putExecutionRunBinding({
      id,
      runId,
      projectId: sourceRun.projectId,
      adapterId: target.adapterId,
      conversationKey: target.conversationKey,
      status: "active",
      deliveryMode: "native",
      ...("sourceMessageId" in target && target.sourceMessageId
        ? { sourceMessageId: target.sourceMessageId }
        : {}),
      ...(deliveryTarget ? { deliveryTarget } : {}),
      lastProjectedRevision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  // The `runId` index groups rows but does not preserve their append order;
  // IndexedDB breaks equal index keys by primary key, and workflow event ids
  // are random. Always replay the durable cursor (or the legacy timestamp
  // order) so a terminal event cannot close the shared journal before its
  // preceding step events are projected.
  const orderedSourceEvents = [...sourceEvents]
  const hasCompleteSequence = orderedSourceEvents.every(
    (event) => typeof event.sequence === "number"
  )
  orderedSourceEvents.sort((left, right) =>
    hasCompleteSequence
      ? left.sequence! - right.sequence!
      : left.ts - right.ts || left.id.localeCompare(right.id)
  )

  // A terminal shared journal is immutable. Normal redelivery is already
  // idempotent, but no newly discovered source event may be appended after the
  // terminal boundary. Bindings above still reconcile for late subscriptions.
  if (["completed", "failed", "cancelled"].includes(run.status)) return

  const labels = new Map(sourceRun.workflowSnapshot.nodes.map((node) => [node.id, node.data.label]))
  const mapped = orderedSourceEvents
    .map((event) =>
      mapWorkflowRunEvent(event, { stepTitle: event.stepId ? labels.get(event.stepId) : undefined })
    )
    .filter((event): event is NonNullable<typeof event> => event !== null)
  if (mapped.length > 0) await runEventJournal.appendBatch(runId, mapped)
}

let subscription: Subscription | null = null
let stopAgentStateBridge: (() => void) | null = null

export function startWorkflowExecutionBridge(): () => void {
  if (subscription) return stopWorkflowExecutionBridge
  stopAgentStateBridge = startAgentStateExecutionBridge()
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  subscription = Dexie.liveQuery(async () => {
    const runs = await getDb().workflowRuns.toArray()
    const rows = await Promise.all(
      runs.map(async (run) => ({
        run,
        events: await getDb().workflowRunEvents.where("runId").equals(run.id).toArray(),
        subscriptions: await listForWorkflow(run.workflowId),
      }))
    )
    return rows
  }).subscribe({
    next(rows) {
      for (const row of rows) {
        void syncWorkflowExecutionRun(row.run, row.events, row.subscriptions).catch((error) => {
          console.error(`[workflow-execution-bridge] sync failed for run=${row.run.id}`, error)
        })
      }
    },
    error(error) {
      console.error("[workflow-execution-bridge] subscription failed", error)
    },
  })
  return stopWorkflowExecutionBridge
}

function stopWorkflowExecutionBridge(): void {
  subscription?.unsubscribe()
  subscription = null
  stopAgentStateBridge?.()
  stopAgentStateBridge = null
}

export function __resetWorkflowExecutionBridgeForTesting(): void {
  stopWorkflowExecutionBridge()
}
