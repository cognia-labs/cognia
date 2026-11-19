import { botInputStillMatches } from "@/lib/bot/events/input-binding"
/**
 * Drive one delivery to a settled Bot run.
 *
 * The run id is DERIVED from the delivery id. That single choice is what makes
 * a re-entry safe: the same delivery always reaches the same run, so its step
 * checkpoints, its pending approval and its journal are all still there when a
 * crashed or handed-over attempt comes back.
 *
 * Failure is split three ways, because only one of them is worth retrying:
 *
 *   - FAILED: the work ran and did not succeed. The delivery backs off.
 *   - UNAVAILABLE: nothing could run at all (a disabled plugin, a Bot with no
 *     working directory), or the run stopped where only a person can move it
 *     (a `blocked` result, a turn denied a tool for want of an approver).
 *     Retrying the same delivery changes nothing, so it is dismissed with a
 *     reason rather than burning the attempt budget.
 *   - CANCELLED: somebody stopped it. Not a failure and not retried.
 */

import {
  completeBotDelivery,
  dismissBotDelivery,
  failBotDelivery,
  markBotDeliveryRunning,
  parkBotDelivery,
} from "@/lib/db/bot-event-deliveries"
import type { BotEventDeliveryRow, BotRunPublication } from "@/lib/db/bot-types"
import {
  appendRunEventInsideTransaction,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { completeBotRunStep, getBotRunStep, putBotRunResult } from "@/lib/db/bot-run-steps"
import { BOT_RUN_POLICY_STEP } from "@/lib/bot/policy/run-authority"
import { NEEDS_APPROVAL_STATUS } from "@/lib/ai/agent/execution/permissions/unattended-responder"
import { expireRunInterruptFromSource } from "@/lib/execution/run-control"
import { writeBotTriggerState } from "@/lib/db/bot-installations"
import { resolveBotExecutionComposition, resolveBotPolicy } from "@/lib/bot/policy/ceilings"
import { projectBotComposition } from "@/lib/bot/composition/project-bot-composition"
import { defaultsFromConfigSchema, resolveBotConfig } from "@/lib/bot/config/resolve-effective"
import type { InstalledBot } from "@/lib/bot/installed-bot"
import type { BotHandlerResultV1, BotLogLevel, BotProgressUpdateV1 } from "@/types/bot/run"
import { isTerminalRunStatus, type ExecutionRunStatus } from "@/types/execution/run"
import type { PluginBotExecutor } from "@/types/plugin/plugin-bot"

import { BOT_EXECUTORS } from "./executors"
import {
  BotExecutorUnavailableError,
  type BotExecutorContext,
  type BotExecutorFn,
} from "./executors/types"
import { BotRunCancelledError, BotRunParkedError, createBotStepApi, type BotStepDeps } from "./step"
import { appendBotRunLog, appendBotRunProgress } from "./journal"
import { publishStagedBotRunEvent } from "./run-publication"
import { unlessAborted } from "@/lib/utils/abort"
import { clearPendingPark } from "./host-step"
import { bindImPresentationForBotDelivery } from "./im-presentation"
import { beginBotOutboundRun } from "@/lib/policy/action-review/configured-grants"
import { parseBotDefinitionId } from "@/lib/plugin/registries/bot-registry"
import { recordedRunMetadata, recordRunAuthority } from "@/lib/execution/acting-authority"
import { declareRootRunBudget } from "@/lib/execution/run-ledger"
import type { RunAuthorityV1 } from "@/types/execution/run"

export function recordedBotRunMetadata(delivery: BotEventDeliveryRow) {
  const { envelope } = delivery
  const actor = envelope.actor
  return recordedRunMetadata(envelope.source === "schedule" ? "schedule" : "external-event", {
    runId: botRunId(delivery.id),
    requesters: [],
    ...(actor
      ? {
          eventActors: [
            {
              kind: "event-actor" as const,
              source: envelope.source,
              ...(actor.id ? { externalId: actor.id } : {}),
              ...(actor.displayName ? { displayName: actor.displayName } : {}),
            },
          ],
        }
      : {}),
  })
}

/**
 * Run the executor with the installation's recipient list lent to its plugin
 * (ADR-0239): a handler Bot's own code delivers through `ctx.connectors`, as
 * its plugin, and may reach the recipients a person listed for this
 * installation while the run lasts, and no longer.
 */
async function runWithOutboundRecipients(
  runId: string,
  resolved: InstalledBot,
  signal: AbortSignal,
  execute: () => Promise<BotHandlerResultV1 | void> | BotHandlerResultV1 | void
): Promise<BotHandlerResultV1 | undefined> {
  const pluginId =
    resolved.definition.source === "plugin"
      ? parseBotDefinitionId(resolved.definition.id)?.pluginId
      : undefined
  const end = pluginId
    ? beginBotOutboundRun(runId, { pluginId, installation: resolved.installation })
    : () => undefined
  try {
    // Settled the moment the run's signal aborts, not when the handler
    // returns. An in-process handler cannot be killed, and one that ignored
    // its signal used to hold the attempt open past its time budget and past
    // a cancel: delivery still `running`, concurrency slot still taken.
    // Whatever the abandoned handler does next meets a cancelled run: every
    // step boundary checks the signal and the delivery is no longer this
    // attempt's to settle.
    return (
      (await unlessAborted(
        Promise.resolve().then(execute),
        signal,
        () => new BotRunCancelledError(runId)
      )) ?? undefined
    )
  } finally {
    // Also on abort: a handler still running after its run was cancelled keeps
    // none of the recipients this run lent it.
    end()
  }
}

/** The run a delivery maps to. Derived, so a re-entry finds its own state. */
export function botRunId(deliveryId: string): string {
  return `run_bot_${deliveryId}`
}

/** Live runs, so a control command can stop one. */
const liveRuns = new Map<string, AbortController>()
const liveInstallations = new Map<string, string>()

export function cancelLiveBotInstallation(installationId: string): void {
  for (const [runId, owner] of liveInstallations) {
    if (owner === installationId) cancelLiveBotRun(runId)
  }
}

export function getLiveBotRunSignal(runId: string): AbortSignal | undefined {
  return liveRuns.get(runId)?.signal
}

/** Abort a running Bot run. Returns false when it is not running here. */
export function cancelLiveBotRun(runId: string): boolean {
  const controller = liveRuns.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}

/** Cancel a fixed accepted set first; late engine writes cannot undo the durable fence. */
export async function cancelAcceptedBotDeliveries(
  installationId: string,
  deliveryId?: string,
  operationId?: string
): Promise<number> {
  const db = getDb()
  const rows = await db.transaction(
    "rw",
    [
      db.botEventDeliveries,
      db.botInstallations,
      db.executionRuns,
      db.executionRunEvents,
      db.executionRunInterrupts,
      db.notificationProjectionWork,
    ],
    async () => {
      const installation = await db.botInstallations.get(installationId)
      if (installation?.syncedFromHost || installation?.owner?.kind === "remote-host")
        throw new Error("Bot cancellation must execute on its owning host")
      const candidates = await db.botEventDeliveries
        .where("installationId")
        .equals(installationId)
        .toArray()
      const previous = operationId && installation?.automationCancellations?.[operationId]
      if (previous) return candidates.filter((row) => previous.includes(row.id))
      const accepted = candidates.filter(
        (row) =>
          !row.syncedFromHost &&
          (!deliveryId || row.id === deliveryId) &&
          !["succeeded", "dismissed"].includes(row.status)
      )
      const now = Date.now()
      for (const row of accepted) {
        const next = {
          ...row,
          status: "dismissed" as const,
          cancelledAt: now,
          settledAt: now,
          updatedAt: now,
          lastError: "cancelled",
        }
        delete next.leaseOwner
        delete next.leaseExpiresAt
        await db.botEventDeliveries.put(next)
        const run = await db.executionRuns.get(row.runId ?? botRunId(row.id))
        // A settled run keeps its history. Cancelling a dead letter abandons
        // redelivery; it does not rewrite a run that already failed into one
        // that was stopped, which is how its row and its journal used to tell
        // two different stories.
        if (run && !isTerminalRunStatus(run.status)) {
          const interrupts = await db.executionRunInterrupts.where("runId").equals(run.id).toArray()
          for (const interrupt of interrupts)
            if (interrupt.status === "pending") {
              await db.executionRunInterrupts.update(interrupt.id, {
                status: "expired",
                resolvedAt: now,
              })
              await appendRunEventInsideTransaction(
                db,
                run.id,
                semanticRunEvent(
                  "interrupt.expired",
                  { interruptId: interrupt.id },
                  { ts: now, sourceEventId: `interrupt:${interrupt.id}:expired` }
                )
              )
            }
          await appendRunEventInsideTransaction(
            db,
            run.id,
            semanticRunEvent("run.cancelled", {}, { ts: now, sourceEventId: `cancel:${run.id}` })
          )
        }
      }
      if (operationId && installation)
        await db.botInstallations.put({
          ...installation,
          automationCancellations: {
            ...installation.automationCancellations,
            [operationId]: accepted.map((row) => row.id),
          },
        })
      return accepted
    }
  )
  for (const delivery of rows) await stopBotExecution(delivery.runId ?? botRunId(delivery.id))
  return rows.length
}

async function stopBotExecution(runId: string): Promise<void> {
  const db = getDb()
  cancelLiveBotRun(runId)
  // Admission records survive a crashed/parked parent. Do not rely on a live controller.
  const workflows = await db.workflowInvocations
    .filter((row) => row.idempotencyKey === runId)
    .toArray()
  const legacy = await db.workflowRuns
    .filter((row) => row.executionBinding?.idempotencyKey === runId)
    .toArray()
  const workflowIds = new Set([
    ...workflows.flatMap((row) => (row.runId ? [row.runId] : [])),
    ...legacy.map((row) => row.id),
  ])
  if (workflowIds.size > 0) {
    const { cancelWorkflowRun } = await import("@/lib/workflow/runtime/cancel-run")
    for (const id of workflowIds) await cancelWorkflowRun(id, "Bot cancelled")
  }
  const squad = await getBotRunStep(runId, "squad-start")
  if (squad) {
    const { controlSquadRun } = await import("@/lib/squads/durable/durable-control")
    await controlSquadRun({ runId }, "stop")
  }
  const interrupts = await db.executionRunInterrupts.where("runId").equals(runId).toArray()
  for (const interrupt of interrupts) await expireRunInterruptFromSource(runId, interrupt.id)
  const run = await getExecutionRun(runId)
  if (run && !isTerminalRunStatus(run.status)) {
    await runEventJournal.append(
      runId,
      semanticRunEvent("run.cancelled", {}, { ts: Date.now(), sourceEventId: `cancel:${runId}` })
    )
    await settleRun(runId, "cancelled", Date.now())
  }
}

/** Cancel executing or parked work using the same delivery boundary as the console. */
export async function cancelBotRun(runId: string): Promise<boolean> {
  const run = await getExecutionRun(runId)
  if (!run || run.kind !== "bot" || isTerminalRunStatus(run.status)) return false
  const rows = await getDb().botEventDeliveries.where("runId").equals(runId).toArray()
  let cancelled = false
  for (const row of rows.filter((item) => !item.syncedFromHost))
    cancelled = (await cancelAcceptedBotDeliveries(row.installationId, row.id)) > 0 || cancelled
  return cancelled
}

/** Test-only: drop every live registration. */
export function __resetLiveBotRunsForTesting(): void {
  liveRuns.clear()
  liveInstallations.clear()
}

export type BotRunOutcome =
  | { status: "completed"; runId: string; result?: BotHandlerResultV1 }
  /** Waiting on a person or an event. Not settled, and not an attempt spent. */
  | { status: "parked"; runId: string; resumeAt: number; waitingFor?: string }
  | { status: "failed"; runId: string; error: string }
  | { status: "unavailable"; runId: string; error: string }
  | { status: "cancelled"; runId: string }

export interface RunBotDeliveryInput {
  delivery: BotEventDeliveryRow
  resolved: InstalledBot
  /** Directory the run works in, resolved by the caller from the workspace. */
  cwd?: string
  /** Override the executor table, for tests and for a headless host's subset. */
  executors?: Partial<Record<PluginBotExecutor, BotExecutorFn>>
  now?: () => number
  stepDeps?: BotStepDeps
  signal?: AbortSignal
}

async function settleRun(runId: string, status: ExecutionRunStatus, ts: number): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.executionRuns, async () => {
    const run = await db.executionRuns.get(runId)
    if (!run || isTerminalRunStatus(run.status)) return
    await db.executionRuns.put({ ...run, status, updatedAt: ts, endedAt: ts })
  })
}

/** The stores a run's terminal commit writes: run, journal, delivery, result, outbox. */
function terminalStores() {
  const db = getDb()
  return [
    db.botEventDeliveries,
    db.botInstallations,
    db.botRunSteps,
    db.executionRuns,
    db.executionRunEvents,
    db.notificationProjectionWork,
  ]
}

/** The `bot.run.*` event a settled run stages for the Bot plane. */
function stagedPublication(
  resolved: InstalledBot,
  status: BotRunPublication["status"],
  ts: number,
  summary?: string
): BotRunPublication {
  return {
    status,
    botId: resolved.definition.id,
    stagedAt: ts,
    ...(summary ? { summary } : {}),
  }
}

/** Stamp the delivery row with the event its settled run owes. Inside a transaction. */
async function stageRunPublication(
  deliveryId: string,
  publication: BotRunPublication
): Promise<void> {
  await getDb().botEventDeliveries.update(deliveryId, { runPublication: publication })
}

/** Dispatch a staged event after its commit. A failure stays staged for the runner's flush. */
function publishAfterCommit(deliveryId: string): void {
  void publishStagedBotRunEvent(deliveryId).catch(() => undefined)
}

/**
 * Mark a run as waiting WITHOUT ending it.
 *
 * A sibling of `settleRun` rather than a parameter on it: that one always
 * writes `endedAt`, and a run that has ended cannot accept the events its own
 * resumption will journal.
 */
async function markRunWaiting(runId: string, ts: number): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.executionRuns, async () => {
    const run = await db.executionRuns.get(runId)
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return
    await db.executionRuns.put({ ...run, status: "waiting", updatedAt: ts })
  })
}

/**
 * Carry a timed trigger's state forward from the handler's result.
 *
 * The host cannot compute a poll cursor or evaluate a derived-state predicate,
 * because neither belongs to it. What it CAN do is remember the last answer
 * across evaluations, which is the whole difference between a Bot that reports
 * a change and one that notifies on every tick.
 */
async function persistTimedTriggerState(
  resolved: InstalledBot,
  triggerId: string,
  result: BotHandlerResultV1 | undefined,
  ts: number
): Promise<void> {
  const trigger = resolved.definition.triggers.find((candidate) => candidate.id === triggerId)
  if (!trigger || (trigger.kind !== "poll" && trigger.kind !== "derivedState")) return

  const output = result?.output
  const patch: Parameters<typeof writeBotTriggerState>[2] = { lastFiredAt: ts }
  if (output && typeof output === "object") {
    const shaped = output as { cursor?: unknown; edgeValue?: unknown }
    if (typeof shaped.cursor === "string") patch.cursor = shaped.cursor
    if (typeof shaped.edgeValue === "boolean") patch.lastEdgeValue = shaped.edgeValue
  }

  await writeBotTriggerState(resolved.installation.id, triggerId, patch, ts).catch(() => undefined)
}

export async function runBotDelivery(input: RunBotDeliveryInput): Promise<BotRunOutcome> {
  const now = input.now ?? Date.now
  const { delivery } = input
  let resolved = input.resolved
  const runId = botRunId(delivery.id)
  const ts = now()

  const existing = await getExecutionRun(runId)
  if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) {
    const error = "The previous execution is terminal; use Retry to create a new run"
    await dismissBotDelivery(delivery.id, error, ts)
    return { status: "unavailable", runId, error }
  }
  const latest = await getDb().botInstallations.get(delivery.installationId)
  if (latest && !botInputStillMatches(latest, resolved.definition, delivery.envelope)) {
    await cancelAcceptedBotDeliveries(delivery.installationId, delivery.id)
    return { status: "unavailable", runId, error: "Input account binding changed" }
  }
  const admitted = await getDb().transaction(
    "rw",
    [
      getDb().botEventDeliveries,
      getDb().botInstallations,
      getDb().conversationOverrides,
      getDb().executionRuns,
    ],
    async () => {
      if (!(await markBotDeliveryRunning(delivery.id, runId, ts, delivery.leaseOwner))) {
        return false
      }
      const currentRun = await getDb().executionRuns.get(runId)
      if (currentRun && ["completed", "failed", "cancelled"].includes(currentRun.status))
        return false
      if (!currentRun) {
        await getDb().executionRuns.add({
          id: runId,
          ...recordedBotRunMetadata(delivery),
          kind: "bot",
          sourceId: resolved.installation.id,
          title: resolved.definition.name,
          status: "running",
          currentRevision: 0,
          startedAt: ts,
          updatedAt: ts,
          ...(resolved.installation.projectId
            ? { projectId: resolved.installation.projectId }
            : {}),
          ...(delivery.envelope.actor?.principalId || delivery.envelope.actor?.id
            ? {
                initiator: {
                  ...(delivery.envelope.actor.id
                    ? { platformIdentityId: delivery.envelope.actor.id }
                    : {}),
                  ...(delivery.envelope.actor.displayName
                    ? { displayName: delivery.envelope.actor.displayName }
                    : {}),
                  ...(delivery.envelope.actor.principalId
                    ? { principalId: delivery.envelope.actor.principalId }
                    : {}),
                  ...(delivery.envelope.actor.accountId
                    ? { accountId: delivery.envelope.actor.accountId }
                    : {}),
                },
              }
            : {}),
        })
      } else
        await getDb().executionRuns.update(runId, {
          status: "running",
          updatedAt: ts,
          endedAt: undefined,
        })
      return true
    }
  )
  if (!admitted) return { status: "parked", runId, resumeAt: ts }
  if (!existing) {
    // Preserve all original host ceilings across retries and future grant edits.
    // Legacy runs are not upgraded into unattended authority on re-entry.
    if (!(await getBotRunStep(runId, BOT_RUN_POLICY_STEP))) {
      await completeBotRunStep(runId, BOT_RUN_POLICY_STEP, structuredClone(resolved.policy), ts)
    }
  }

  const checkpoint = await getBotRunStep(runId, BOT_RUN_POLICY_STEP)
  if (
    checkpoint?.status === "completed" &&
    checkpoint.output &&
    typeof checkpoint.output === "object" &&
    !Array.isArray(checkpoint.output)
  ) {
    resolved = {
      ...resolved,
      policy: resolveBotPolicy([
        { name: "organization", policy: checkpoint.output },
        { name: "installation", policy: resolved.policy },
      ]).policy,
    }
  }

  // The cost ceiling is the run tree's ledger (ADR-0243 3B): every model call
  // under the run reserves there. A resumed run keeps the ledger it started.
  await declareRootRunBudget(runId, { costUsd: resolved.policy.maxRunCostUsd })

  // An IM-originated delivery carries its conversation's delivery target in
  // the envelope payload; binding it here hands the run the generic
  // presentation plane (progress card, COT, approval controls) with no
  // additional machinery. Idempotent — a re-entered delivery finds its row.
  await bindImPresentationForBotDelivery(delivery, runId).catch(() => undefined)
  await runEventJournal
    .append(
      runId,
      semanticRunEvent(
        existing ? "run.resumed" : "run.started",
        { botId: resolved.definition.id, eventType: delivery.type },
        {
          ts,
          sourceEventId: existing
            ? `run.resumed:${delivery.id}:${existing.currentRevision}`
            : `run.started:${delivery.id}`,
        }
      )
    )
    .catch(() => undefined)

  const controller = new AbortController()
  liveRuns.set(runId, controller)
  liveInstallations.set(runId, resolved.installation.id)
  const abort = () => controller.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) controller.abort()
  const executionTimer = resolved.policy.maxRunDurationMs
    ? setTimeout(abort, resolved.policy.maxRunDurationMs)
    : undefined

  const config = resolveBotConfig({
    installation: resolved.installation.config,
    definitionDefaults: defaultsFromConfigSchema(resolved.definition.configSchema),
  }).values

  const composition = projectBotComposition({
    executor: resolved.definition.executor,
    ...(resolved.definition.workflow ? { executorRef: resolved.definition.workflow } : {}),
    ...(resolved.definition.team ? { executorRef: resolved.definition.team } : {}),
    ...(resolved.definition.composition ? { definition: resolved.definition.composition } : {}),
    policy: resolved.policy,
  })

  const step = createBotStepApi({
    runId,
    signal: controller.signal,
    ...(resolved.installation.projectId ? { projectId: resolved.installation.projectId } : {}),
    ...(input.stepDeps ? { deps: input.stepDeps } : {}),
  })

  const ctx: BotExecutorContext = {
    runId,
    installationId: resolved.installation.id,
    botId: resolved.definition.id,
    event: delivery.envelope,
    config,
    signal: controller.signal,
    step,
    log: (level: BotLogLevel, message: string, data?: Record<string, unknown>) => {
      appendBotRunLog(runId, level, message, data, now)
    },
    progress: (update: BotProgressUpdateV1) => {
      appendBotRunProgress(runId, update, now)
    },
    installation: resolved.installation,
    definition: resolved.definition,
    composition,
    policy: resolved.policy,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  }

  const executor =
    input.executors?.[resolved.definition.executor] ?? BOT_EXECUTORS[resolved.definition.executor]

  async function stillOwnsDelivery(): Promise<boolean> {
    const current = await getDb().botEventDeliveries.get(delivery.id)
    return Boolean(
      current &&
      current.status === "running" &&
      current.leaseOwner === delivery.leaseOwner &&
      (current.leaseExpiresAt === undefined || current.leaseExpiresAt > now())
    )
  }

  try {
    if (controller.signal.aborted || !(await stillOwnsDelivery()))
      throw new BotRunCancelledError(runId)
    const executionComposition = resolveBotExecutionComposition(
      composition.selection,
      resolved.policy
    )
    // Freeze and await the policy ceiling before any executor can start children.
    const recordedAuthority: RunAuthorityV1 = {
      schemaVersion: 1,
      permissionMode: executionComposition.authority,
      ...(resolved.policy.permissionProfile
        ? { permissionProfile: resolved.policy.permissionProfile }
        : {}),
    }
    const effectiveAuthority = await recordRunAuthority("", recordedAuthority, runId)
    if (effectiveAuthority?.permissionMode)
      executionComposition.authority = effectiveAuthority.permissionMode
    if (effectiveAuthority?.permissionProfile)
      resolved.policy.permissionProfile = effectiveAuthority.permissionProfile

    if (
      executionComposition.autonomy === "observe" ||
      executionComposition.engagement === "human"
    ) {
      throw new BotExecutorUnavailableError(
        resolved.definition.executor,
        "Bot composition does not permit automated execution"
      )
    }
    const currentInstallation = await getDb().botInstallations.get(delivery.installationId)
    if (
      !currentInstallation ||
      currentInstallation.status !== "enabled" ||
      !botInputStillMatches(currentInstallation, resolved.definition, delivery.envelope) ||
      controller.signal.aborted
    )
      throw new BotRunCancelledError(runId)
    const result = await runWithOutboundRecipients(runId, resolved, controller.signal, () =>
      executor(ctx)
    )
    if (controller.signal.aborted || !(await stillOwnsDelivery()))
      throw new BotRunCancelledError(runId)
    const endedAt = now()
    // Not done, and not worth replaying: `blocked` waits on the author, and
    // `needs_approval` on a person to allow a tool the unattended turn was
    // denied. A re-run stops in the same place, so the delivery is dismissed
    // with the reason instead of completed or backed off.
    const resultStatus = (result?.output as { status?: string } | undefined)?.status
    if (resultStatus === "blocked" || resultStatus === NEEDS_APPROVAL_STATUS) {
      const error = result?.summary ?? "Bot result requires attention"
      const settled = await getDb().transaction("rw", terminalStores(), async () => {
        if (!(await stillOwnsDelivery())) return false
        if (result) await putBotRunResult(runId, result, endedAt)
        await appendRunEventInsideTransaction(
          getDb(),
          runId,
          semanticRunEvent(
            "run.failed",
            { error },
            { ts: endedAt, sourceEventId: `run.failed:${delivery.id}` }
          )
        )
        await dismissBotDelivery(delivery.id, error, endedAt, delivery.leaseOwner)
        await stageRunPublication(delivery.id, stagedPublication(resolved, "failed", endedAt))
        return true
      })
      if (!settled) return { status: "cancelled", runId }
      publishAfterCommit(delivery.id)
      return { status: "unavailable", runId, error }
    }
    const completed = await getDb().transaction("rw", terminalStores(), async () => {
      if (!(await stillOwnsDelivery())) return "lost" as const
      // Re-read inside the commit: an installation removed or switched off
      // while the handler ran must not end up with a run reporting success.
      // Its removal already cancelled the accepted work it could see, so this
      // is the attempt that slipped in before the fence.
      const installation = await getDb().botInstallations.get(delivery.installationId)
      if (!installation || installation.status !== "enabled") {
        await appendRunEventInsideTransaction(
          getDb(),
          runId,
          semanticRunEvent("run.cancelled", {}, { ts: endedAt, sourceEventId: `cancel:${runId}` })
        )
        await dismissBotDelivery(
          delivery.id,
          installation ? "installation is not enabled" : "installation was removed",
          endedAt,
          delivery.leaseOwner
        )
        return "cancelled" as const
      }
      await persistTimedTriggerState(resolved, delivery.triggerId, result, endedAt)
      // The output lands with the terminal state, overwriting what an earlier
      // attempt left: that attempt's commit failed, this one's is the run's.
      if (result) await putBotRunResult(runId, result, endedAt)
      await appendRunEventInsideTransaction(
        getDb(),
        runId,
        semanticRunEvent(
          "run.completed",
          { summary: result?.summary },
          { ts: endedAt, sourceEventId: `run.completed:${delivery.id}` }
        )
      )
      await completeBotDelivery(delivery.id, endedAt, delivery.leaseOwner)
      // A settled run is itself an event. Off by default at the router: the
      // loop guard refuses a self-produced envelope unless the receiving
      // installation's own ceiling says `allowSelfTriggering`, and refuses it
      // regardless past the depth cap. Staged unconditionally so that decision
      // stays in one place instead of being half-made here.
      await stageRunPublication(
        delivery.id,
        stagedPublication(resolved, "completed", endedAt, result?.summary)
      )
      return "completed" as const
    })
    if (completed !== "completed") return { status: "cancelled", runId }
    publishAfterCommit(delivery.id)

    return { status: "completed", runId, ...(result ? { result } : {}) }
  } catch (error) {
    const endedAt = now()
    // A stopped lease holder must not settle a delivery now owned by another
    // attempt, or undo a cancellation already committed by the control gate.
    if (!(await stillOwnsDelivery())) return { status: "cancelled", runId }
    if (
      error instanceof BotRunCancelledError ||
      controller.signal.aborted ||
      (error instanceof Error &&
        "terminalCancellation" in error &&
        error.terminalCancellation === true)
    ) {
      await runEventJournal
        .append(
          runId,
          semanticRunEvent("run.cancelled", {}, { ts: endedAt, sourceEventId: `cancel:${runId}` })
        )
        .catch(() => undefined)
      await settleRun(runId, "cancelled", endedAt)
      await dismissBotDelivery(delivery.id, "cancelled", endedAt, delivery.leaseOwner)
      return { status: "cancelled", runId }
    }

    if (error instanceof BotRunParkedError) {
      // Not a failure, so no attempt is charged: a person's thinking time must
      // not spend the retry budget an intermittent error will need. The run
      // stays open, and re-entry replays its completed steps.
      await markRunWaiting(runId, endedAt)
      await runEventJournal
        .append(
          runId,
          semanticRunEvent(
            "run.waiting",
            { stepId: error.stepName },
            {
              ts: endedAt,
              // Each resumed attempt must project back to waiting. A key
              // shared across attempts would deduplicate this transition
              // while retaining the newer run.resumed event.
              sourceEventId: `run.waiting:${error.stepName}:${existing?.currentRevision ?? 0}`,
            }
          )
        )
        .catch(() => undefined)
      await parkBotDelivery(
        delivery.id,
        error.resumeAt,
        error.waitingFor,
        endedAt,
        delivery.leaseOwner
      )
      return {
        status: "parked",
        runId,
        resumeAt: error.resumeAt,
        ...(error.waitingFor ? { waitingFor: error.waitingFor } : {}),
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    const unavailable = error instanceof BotExecutorUnavailableError
    // The attempt's outcome, its journal entries and the event a terminal
    // failure owes commit together: a dead letter whose run still reads
    // `running`, or a failed run nobody subscribed ever hears of, are both one
    // of these writes landing without the others.
    const outcome = await getDb().transaction("rw", terminalStores(), async () => {
      if (!(await stillOwnsDelivery())) return { status: "lost" as const }
      if (!unavailable) {
        const next = await failBotDelivery(
          delivery.id,
          error,
          endedAt,
          undefined,
          delivery.leaseOwner
        )
        if (next?.status === "pending") {
          // The attempt failed, but its durable task still owns a scheduled
          // retry. A terminal run event is immutable and cannot be resumed.
          await appendRunEventInsideTransaction(
            getDb(),
            runId,
            semanticRunEvent(
              "step.failed",
              { stepId: `delivery-attempt:${next.attempts}`, error: message },
              {
                ts: endedAt,
                sourceEventId: `step.failed:delivery-attempt:${delivery.id}:${next.attempts}`,
              }
            )
          )
          await appendRunEventInsideTransaction(
            getDb(),
            runId,
            semanticRunEvent(
              "run.waiting",
              { retryAt: next.nextAttemptAt, error: message },
              { ts: endedAt, sourceEventId: `run.waiting:retry:${delivery.id}:${next.attempts}` }
            )
          )
          return { status: "retrying" as const }
        }
      } else {
        // Nothing ran, and nothing will. Dismissing keeps the attempt budget
        // for failures a retry could actually fix.
        await dismissBotDelivery(delivery.id, message, endedAt, delivery.leaseOwner)
      }
      const run = await getDb().executionRuns.get(runId)
      if (run && !isTerminalRunStatus(run.status)) {
        await appendRunEventInsideTransaction(
          getDb(),
          runId,
          semanticRunEvent(
            "run.failed",
            { error: message },
            { ts: endedAt, sourceEventId: `run.failed:${delivery.id}` }
          )
        )
        await stageRunPublication(delivery.id, stagedPublication(resolved, "failed", endedAt))
      }
      return { status: "failed" as const }
    })
    if (outcome.status === "lost") return { status: "cancelled", runId }
    if (outcome.status === "retrying") return { status: "failed", runId, error: message }
    publishAfterCommit(delivery.id)
    return unavailable
      ? { status: "unavailable", runId, error: message }
      : { status: "failed", runId, error: message }
  } finally {
    if (liveRuns.get(runId) === controller) {
      liveRuns.delete(runId)
      liveInstallations.delete(runId)
    }
    // A parked intent recorded by a cross-process host call must not outlive
    // the attempt that recorded it: a stale entry would park the next entry.
    clearPendingPark(runId)
    if (executionTimer) clearTimeout(executionTimer)
    input.signal?.removeEventListener("abort", abort)
  }
}
