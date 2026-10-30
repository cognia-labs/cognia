/** Independent observer controls; responder mute/manual mode never implicitly changes these. */
import { liveQuery } from "dexie"
import { getDb } from "@/lib/db/schema"

export async function conversationAutomationState(conversationKey: string, acceptedAt: number) {
  const row = await getDb()
    .conversationOverrides.where("conversationKey")
    .equals(conversationKey)
    .first()
  return {
    paused: row?.automationPaused === true,
    cancelled:
      row?.automationCancelledBefore !== undefined && acceptedAt <= row.automationCancelledBefore,
  }
}

/** Accepted work waits for resume; cancellation wakes the waiter without starting it. */
export async function waitForConversationAutomation(
  conversationKey: string,
  acceptedAt: number,
  options: { signal?: AbortSignal; runId?: string } = {}
): Promise<boolean> {
  const db = getDb()
  const { signal, runId } = options
  const abortReason = () =>
    signal?.reason ?? new DOMException("Automation wait aborted", "AbortError")
  if (signal?.aborted) throw abortReason()
  const readState = async () => {
    if (getDb() !== db) return { paused: false, cancelled: true }
    const state = await conversationAutomationState(conversationKey, acceptedAt)
    const run = runId ? await db.workflowRuns.get(runId) : undefined
    return {
      paused: state.paused,
      cancelled:
        state.cancelled ||
        getDb() !== db ||
        run?.status === "cancelled" ||
        run?.cancelRequestedAt !== undefined,
    }
  }
  return new Promise<boolean>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      unsubscribe()
      signal?.removeEventListener("abort", aborted)
      complete()
    }
    const aborted = () => finish(() => reject(abortReason()))
    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted) {
      aborted()
      return
    }
    // Dexie suppresses DatabaseClosedError/AbortError from a querier. Carry
    // read failures through next so the waiter always settles and cleans up.
    const subscription = liveQuery(async () => {
      try {
        return { ok: true as const, state: await readState() }
      } catch (error) {
        return { ok: false as const, error }
      }
    }).subscribe({
      next: (result) => {
        if (!result.ok) {
          finish(() => reject(result.error))
          return
        }
        const current = result.state
        if (!current.paused || current.cancelled) {
          finish(() => resolve(!current.cancelled))
        }
      },
      error: (error) => {
        finish(() => reject(error))
      },
    })
    unsubscribe = () => subscription.unsubscribe()
    if (settled) unsubscribe()
  })
}

/** The command commits its cutoff before this best-effort engine-control cascade. */
export async function cancelConversationAutomations(
  adapterId: string,
  conversationKey: string,
  cutoff: number
): Promise<void> {
  const db = getDb()
  const deliveries = await db.botEventDeliveries
    .filter(
      (row) =>
        !row.syncedFromHost &&
        (row.envelope.receivedAt ?? row.receivedAt) <= cutoff &&
        row.envelope.binding?.adapterId === adapterId &&
        row.envelope.binding.conversationKey === conversationKey
    )
    .toArray()
  const { cancelAcceptedBotDeliveries } = await import("@/lib/bot/runtime/run")
  for (const row of deliveries) await cancelAcceptedBotDeliveries(row.installationId, row.id)
  const workflows = await db.workflowRuns
    .filter(
      (row) =>
        row.triggerKind.startsWith("trigger.connector.") &&
        (row.triggerOriginAt ?? row.startedAt) <= cutoff &&
        row.triggerBinding?.adapterId === adapterId &&
        row.triggerBinding.conversationKey === conversationKey
    )
    .toArray()
  const { cancelWorkflowRun } = await import("@/lib/workflow/runtime/cancel-run")
  for (const row of workflows) await cancelWorkflowRun(row.id, "Conversation automation cancelled")
}

/** Refresh retained queue deadlines before the command clears the pause fence. */
export async function retainConversationAutomationsOnResume(
  conversationKey: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.botEventDeliveries, db.conversationOverrides, async () => {
    const control = await db.conversationOverrides
      .where("conversationKey")
      .equals(conversationKey)
      .first()
    if (!control?.automationPaused) return
    const rows = await db.botEventDeliveries
      .filter(
        (row) =>
          !row.syncedFromHost &&
          row.envelope.binding?.conversationKey === conversationKey &&
          ["pending", "parked", "leased", "running", "failed"].includes(row.status)
      )
      .toArray()
    for (const row of rows)
      await db.botEventDeliveries.update(row.id, { retentionExtendedAt: Date.now() })
  })
}
