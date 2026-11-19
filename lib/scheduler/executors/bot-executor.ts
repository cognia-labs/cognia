/**
 * `bot` scheduled-task executor.
 *
 * One task type covers all three timed trigger kinds, because they differ only
 * in what the handler does with the tick:
 *
 *   - `schedule`     fires on its cron.
 *   - `poll`         fires on its interval, carrying the stored cursor.
 *   - `derivedState` fires on its interval, carrying the last edge value.
 *
 * The executor does not evaluate anything. It enqueues a delivery for the named
 * installation and trigger, and the ordinary delivery runner takes it from
 * there, which is what keeps a timed run and an event-driven run identical in
 * every way that matters: same lease, same retry, same journal, same approval.
 *
 * Placement follows the scheduler's own rule (ADR-0128): every Host owns its
 * schedule, and this executor runs wherever the task does.
 */

import type { ScheduledTask, TaskExecution, TaskExecutorResult } from "@/types/scheduler"

import { scheduledBotTickRecordId } from "../occurrence"

export interface BotTaskPayload extends Record<string, unknown> {
  installationId: string
  triggerId: string
}

export async function executeBotTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<TaskExecutorResult> {
  const payload = (task.payload ?? {}) as Partial<BotTaskPayload>
  const installationId = payload.installationId?.trim()
  const triggerId = payload.triggerId?.trim()
  if (!installationId || !triggerId) {
    return {
      success: false,
      error: 'A "bot" task needs both an installationId and a triggerId in its payload',
      terminalReason: "executor-failure",
    }
  }
  if (signal.aborted) return { success: false, error: "Bot task aborted before start" }

  // Imported here rather than at module scope: `lib/scheduler/executors/index`
  // is loaded on every host at boot, and the Bot control plane is a graph a
  // schedule with no Bot tasks has no reason to pay for.
  const [
    { BotIntakePausedError, enqueueBotDelivery },
    { getBotInstallation },
    { buildBotEventEnvelope, oneOffSourceRecordId },
    { externalProvenance },
    { projectBotDeliveryPolicy },
    { isRunnableBot, resolveInstalledBot },
  ] = await Promise.all([
    import("@/lib/db/bot-event-deliveries"),
    import("@/lib/db/bot-installations"),
    import("@/lib/bot/events/envelope"),
    import("@/lib/bot/events/provenance"),
    import("@/lib/bot/events/router"),
    import("@/lib/bot/installed-bot"),
  ])

  const installation = await getBotInstallation(installationId)
  if (!installation) {
    // Terminal: the installation is gone, and every future tick would fail the
    // same way. Saying so lets the scheduler stop firing it.
    return {
      success: false,
      error: `Bot installation ${installationId} no longer exists`,
      terminalReason: "executor-failure",
    }
  }

  const resolved = await resolveInstalledBot(installation)
  if (!resolved || !isRunnableBot(resolved)) {
    return { success: false, error: `Bot installation ${installationId} is not runnable` }
  }

  const trigger = resolved.definition.triggers.find((candidate) => candidate.id === triggerId)
  if (!trigger) {
    return {
      success: false,
      error: `Bot ${resolved.definition.id} has no trigger "${triggerId}"`,
      terminalReason: "executor-failure",
    }
  }
  if (trigger.kind !== "schedule" && trigger.kind !== "poll" && trigger.kind !== "derivedState") {
    return {
      success: false,
      error: `Trigger "${triggerId}" is a ${trigger.kind} trigger, which the scheduler does not fire`,
      terminalReason: "executor-failure",
    }
  }

  const now = Date.now()
  const slot = execution.scheduledFor?.getTime()
  const envelope = buildBotEventEnvelope({
    source: "schedule",
    // Every slot is its own event, keyed on the slot and not on when this host
    // got to it: two slots are two deliveries, and the same slot fired twice
    // lands on one. A tick started by hand is always its own (ADR-0224 A9).
    sourceRecordId: scheduledBotTickRecordId({
      installationId,
      triggerId,
      triggerSource: execution.triggerSource ?? "schedule",
      ...(execution.scheduledFor ? { scheduledFor: execution.scheduledFor } : {}),
      oneOff: oneOffSourceRecordId,
    }),
    type: `bot.${trigger.kind}`,
    installationId,
    triggerId,
    occurredAt: slot !== undefined && Number.isFinite(slot) ? slot : now,
    receivedAt: now,
    // The cursor and the last edge value are NOT copied here. They are read
    // when the slot first runs (`runBotDelivery`): a second slot queued before
    // the first one committed would otherwise carry the same stale cursor.
    payload: {
      triggerKind: trigger.kind,
      ...(trigger.kind === "derivedState" ? { state: trigger.state, edge: trigger.edge } : {}),
    },
    provenance: externalProvenance(),
  })

  let delivery
  try {
    delivery = await enqueueBotDelivery({
      envelope,
      now,
      // Checked in the insert's transaction, not from the reads above: a tick
      // the scheduler handed over before a disarm returned must not enqueue
      // after it. Work accepted before the disarm keeps its own rules.
      armedTrigger: trigger,
      ...projectBotDeliveryPolicy(trigger, envelope, now),
    })
  } catch (error) {
    if (!(error instanceof BotIntakePausedError)) throw error
    // A disarmed trigger fires nothing, which is the outcome asked for. Its
    // schedule row is removed by the same disarm. Anything else is the
    // installation being off, reported like the runnable check above.
    if (error.reason === "disarmed") {
      return {
        success: true,
        output: {
          skipped: "trigger-disarmed",
          botId: resolved.definition.id,
          triggerKind: trigger.kind,
        },
      }
    }
    return { success: false, error: `Bot installation ${installationId} is not runnable` }
  }

  return {
    success: true,
    output: { deliveryId: delivery.id, botId: resolved.definition.id, triggerKind: trigger.kind },
  }
}
