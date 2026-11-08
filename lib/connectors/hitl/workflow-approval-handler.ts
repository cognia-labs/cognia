/**
 * Bus-side dispatcher for `wf_approve` / `wf_cancel` callback bindings.
 *
 * Companion to the `defaultConnectorCallbackHandler` (which drives a model
 * digest turn). The workflow approval kind is special-cased upstream in
 * `lib/connectors/bus.ts:dispatchConnectorCallback` so the assistant turn
 * isn't synthesised — we want the user to see a tight "✅ Started" / "⊘
 * Cancelled" reply, then progress cards driven by the execution bridge +
 * run-presentation runner, NOT a long model recap.
 *
 * Accepted decisions survive a restart until admission and confirmation have
 * succeeded. Consumed bindings remain until TTL so redraws cannot resurrect
 * an already answered card.
 */

import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getDb } from "@/lib/db/schema"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { type ConversationDeliveryTarget, parseConversationKey } from "@/types/connectors/event"
import { startWorkflowFromIM } from "@/lib/workflow/runtime/start-from-im"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { WorkflowDependencyBinding } from "@/types/workflow/deployment"
import { consumeCallbackBindingAtomically } from "@/lib/connectors/callback-authorization"
import type { CallbackAuthorizationMode } from "@/lib/connectors/callback-authorization"

export interface HandleWorkflowApprovalInput {
  binding: ConnectorCallbackBindingRow
  cancelled: boolean
  adapterId: string
  platform: PlatformKind
  conversationKey?: string
  deliveryTarget?: ConversationDeliveryTarget
  signal?: AbortSignal
  authorizationMode?: CallbackAuthorizationMode
}

interface ApprovalPayload {
  workflowId: string
  workflowName?: string
  runParams?: Record<string, unknown>
  triggeredFrom: WorkflowTriggeredFrom
  /**
   * IM ceiling frozen by the caller that recorded the binding.
   *
   * Carried on the payload rather than re-resolved here because the card can
   * sit unanswered for hours: re-deriving would let a policy change between the
   * ask and the press silently widen what the approved run may do. Absent on
   * bindings written before the acceptance path existed, and on the
   * `wf_run_workflow_by_name` plugin path, which never had one.
   */
  permissionCeiling?: AgentPermissionCeiling
  lockedDependency?: WorkflowDependencyBinding
}

function readPayload(binding: ConnectorCallbackBindingRow): ApprovalPayload | null {
  const payload = binding.payload as Partial<ApprovalPayload> | undefined
  if (!payload || typeof payload.workflowId !== "string") return null
  const tf = payload.triggeredFrom
  if (!tf || tf.source !== "im") return null
  return {
    workflowId: payload.workflowId,
    workflowName: payload.workflowName,
    runParams: payload.runParams,
    triggeredFrom: tf,
    ...(payload.lockedDependency ? { lockedDependency: payload.lockedDependency } : {}),
    ...(payload.permissionCeiling ? { permissionCeiling: payload.permissionCeiling } : {}),
  }
}

async function pushOutboundText(args: {
  adapterId: string
  platform: PlatformKind
  conversationKey: string
  text: string
  deliveryTarget?: ConversationDeliveryTarget
  idempotencyKey: string
}): Promise<void> {
  await enqueueOutbound({
    adapterId: args.adapterId,
    conversationKey: args.conversationKey,
    request: {
      ...(args.deliveryTarget ? { deliveryTarget: args.deliveryTarget } : {}),
      conversationRef: args.deliveryTarget?.conversationRef ?? {
        platform: args.platform,
        adapterId: args.adapterId,
      },
      segments: [{ type: "text", text: args.text }],
      metadata: { idempotencyKey: args.idempotencyKey },
    },
    source: "workflow",
    // A confirmation of the click, in the conversation it came from.
    authorization: { kind: "system-notice", inboundConversationKey: args.conversationKey },
  })
}

export async function handleWorkflowApprovalCallback(
  input: HandleWorkflowApprovalInput
): Promise<void> {
  const key = `${input.adapterId}:${input.binding.surfaceId}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const work = dispatchAcceptedApproval(input).finally(() => inFlight.delete(key))
  inFlight.set(key, work)
  return work
}

const inFlight = new Map<string, Promise<void>>()

async function dispatchAcceptedApproval(input: HandleWorkflowApprovalInput): Promise<void> {
  const db = getDb()
  let binding = await db.connectorCallbackBindings.get(input.binding.id)
  if (!binding || input.signal?.aborted) return
  if (!binding.workflowDispatch) {
    // In enforce mode the guard has already recorded this. Audit/off callers
    // still need a durable receipt before executing their accepted decision.
    if (binding.consumedAt !== undefined) return
    if (input.authorizationMode && input.authorizationMode !== "enforce") {
      // Shadow/off mode retains its no-consumption contract; the accepted
      // dispatch still needs durable recovery and the same admission identity.
      const id = binding.id
      await db.transaction("rw", db.connectorCallbackBindings, async () => {
        const current = await db.connectorCallbackBindings.get(id)
        if (!current || current.workflowDispatch) return
        await db.connectorCallbackBindings.update(id, {
          workflowDispatch: {
            status: "pending",
            decision: input.cancelled ? "cancel" : "approve",
            acceptedAt: Date.now(),
            ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
          },
        })
      })
    } else {
      await consumeCallbackBindingAtomically(binding, Date.now(), {
        decision: input.cancelled ? "cancel" : "approve",
        ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
      })
    }
    binding = await db.connectorCallbackBindings.get(binding.id)
  }
  const receipt = binding?.workflowDispatch
  if (!binding || !receipt || receipt.status === "settled" || input.signal?.aborted) return
  input = {
    ...input,
    binding,
    cancelled: receipt.decision === "cancel",
    deliveryTarget: receipt.deliveryTarget ?? input.deliveryTarget,
  }
  const settle = () =>
    db.connectorCallbackBindings.update(binding!.id, {
      workflowDispatch: { ...receipt, status: "settled" },
    })
  const payload = readPayload(input.binding)
  if (!payload) {
    // Malformed binding — clean it up and abort. Already-audited as
    // `workflow_approval_failed` by the bus dispatcher if this throws.
    await settle()
    return
  }

  const conversationKey = input.conversationKey ?? payload.triggeredFrom.conversationKey
  if (!conversationKey) {
    await settle()
    return
  }

  // Derive platform from the conversation key when the bus didn't pass
  // a stronger signal — parseConversationKey gives us a typed PlatformKind.
  let platform = input.platform
  try {
    platform = parseConversationKey(conversationKey).platform
  } catch {
    // Fall back to the bus-provided platform.
  }

  if (input.cancelled) {
    await pushOutboundText({
      adapterId: input.adapterId,
      platform,
      conversationKey,
      ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
      text: `⊘ ${payload.workflowName ?? "Workflow"} 已取消`,
      idempotencyKey: `wfcan:${input.binding.surfaceId}`,
    })
    await settle()
    return
  }

  if (!payload.lockedDependency) {
    await pushOutboundText({
      adapterId: input.adapterId,
      platform,
      conversationKey,
      ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
      text: "✗ 无法启动：此审批未固定发布版本，请重新请求审批 / Approval has no pinned publication; request a new approval.",
      idempotencyKey: `wferr:${input.binding.surfaceId}`,
    })
    await settle()
    return
  }
  const admitted = receipt.runId ? await db.workflowRuns.get(receipt.runId) : undefined
  const result =
    receipt.runId && admitted && admitted.status !== "pending"
      ? { ok: true as const, runId: receipt.runId }
      : await startWorkflowFromIM({
          workflowId: payload.workflowId,
          runParams: payload.runParams,
          triggeredFrom: payload.triggeredFrom,
          lockedDependency: payload.lockedDependency,
          idempotencyKey: `im-workflow-approval:${input.adapterId}:${input.binding.surfaceId}`,
          signal: input.signal,
          ...(payload.permissionCeiling ? { permissionCeiling: payload.permissionCeiling } : {}),
        })

  if (!result.ok) {
    await pushOutboundText({
      adapterId: input.adapterId,
      platform,
      conversationKey,
      ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
      text: `✗ 无法启动「${payload.workflowName ?? payload.workflowId}」：${
        result.reason === "workflow-not-found" ? "workflow not found" : "unknown error"
      }`,
      idempotencyKey: `wferr:${input.binding.surfaceId}`,
    })
    await settle()
    return
  }

  receipt.runId = result.runId
  receipt.status = "started"
  await db.connectorCallbackBindings.update(binding.id, { workflowDispatch: receipt })

  await pushOutboundText({
    adapterId: input.adapterId,
    platform,
    conversationKey,
    ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
    text: `✅ ${payload.workflowName ?? "Workflow"} 已启动 (runId=${result.runId})`,
    idempotencyKey: `wfok:${input.binding.surfaceId}`,
  })
  // Admission is durable before the driver starts. Keep this receipt until
  // the driver has left pending; recovery reenters the same invocation.
  const startedRun = await db.workflowRuns.get(result.runId)
  if (!startedRun || startedRun.status === "pending") return
  await settle()
}

export interface WorkflowApprovalRecoveryOptions {
  ownsAdapter: (adapterId: string) => boolean | Promise<boolean>
  signal?: AbortSignal
  onError?: (error: unknown) => void
  /** Independent durable observer transfer, using the same host-owned clock. */
  recoverObservers?: () => Promise<void>
}

/** Resume accepted decisions only on the host currently running that adapter. */
export async function recoverPendingWorkflowApprovals(
  options: WorkflowApprovalRecoveryOptions
): Promise<void> {
  const rows = await getDb()
    .connectorCallbackBindings.where("kind")
    .anyOf("wf_approve", "wf_cancel")
    .toArray()
  for (const binding of rows) {
    if (options.signal?.aborted) return
    if (!binding.workflowDispatch || binding.workflowDispatch.status === "settled") continue
    if (!(await options.ownsAdapter(binding.adapterId)) || options.signal?.aborted) continue
    try {
      const conversationKey = binding.conversationKey
      if (!conversationKey) continue
      const platform = parseConversationKey(conversationKey).platform
      await handleWorkflowApprovalCallback({
        binding,
        adapterId: binding.adapterId,
        platform,
        conversationKey,
        cancelled: binding.workflowDispatch.decision === "cancel",
        signal: options.signal,
      })
    } catch (error) {
      options.onError?.(error)
    }
  }
}

/** The shared desktop/headless runtime owns and aborts this recovery clock. */
export function startWorkflowApprovalRecovery(
  options: WorkflowApprovalRecoveryOptions
): () => void {
  let stopped = false
  let busy = false
  const tick = async () => {
    if (busy || stopped || options.signal?.aborted) return
    busy = true
    try {
      await recoverPendingWorkflowApprovals(options)
    } catch (error) {
      options.onError?.(error)
    } finally {
      busy = false
    }
  }
  let observersBusy = false
  const observers = async () => {
    if (observersBusy || stopped || options.signal?.aborted || !options.recoverObservers) return
    observersBusy = true
    try {
      await options.recoverObservers()
    } catch (error) {
      options.onError?.(error)
    } finally {
      observersBusy = false
    }
  }
  const timer = setInterval(() => {
    void tick()
    void observers()
  }, 5_000)
  const stop = () => {
    stopped = true
    clearInterval(timer)
    options.signal?.removeEventListener("abort", stop)
  }
  if (options.signal?.aborted) stop()
  else {
    options.signal?.addEventListener("abort", stop, { once: true })
    void tick()
    void observers()
  }
  return stop
}
