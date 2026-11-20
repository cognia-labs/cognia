/**
 * The relayed half of the Bot control writes.
 *
 * A phone, a browser companion, or a desktop driving a remote Host does not
 * run a delivery runner. Each of the three controls is shipped to the paired
 * Host through the durable `mobileOutboundQueue` and dispatched as an RPC with
 * the row's idempotency key as the `Idempotency-Key` header, exactly as the
 * Inbox relay does.
 *
 * ## The keys are the design
 *
 * Each command's key is chosen for what a REPLAY after a reconnect must do,
 * which is the one thing nobody exercises by hand:
 *
 *  * Arming uses a fresh UUID per explicit command. Queue retries preserve it,
 *    while arm/disarm/arm cannot reuse a cached response from the first arm.
 *    The keys tell two gestures apart; their ORDER is the trigger's channel
 *    (`botTriggerChannel`), so a switch retried after a later one cannot
 *    overtake it and turn the trigger back.
 *  * Manual runs use a fresh UUID per press and carry it in their event payload.
 *  * Retry presses also use fresh UUIDs so a completed transient failure is
 *    not replayed forever. The Host deduplicates the successor by delivery.
 *
 * ## What is optimistic and what is not
 *
 * Arming writes the local mirror straight away and holds a pending marker, so
 * the switch does not flip back while the write is in flight
 * (`pending-installations.ts`, read by the sync handler). Running and replaying
 * do NOT: both create or move a delivery row the Host owns, and a mirror
 * inventing one would put a delivery on screen that no queue anywhere holds.
 */

import { enqueue, enqueueOnChannel } from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { setMirroredBotTriggerOverride } from "@/lib/db/bot-installations"

import { markPendingBotInstallationMutation } from "./pending-installations"
import { BOT_WRITE_COMMANDS, type BotWriteCommand } from "./route"

export interface RemoteBotWriteOptions {
  /** Human label rendered in the offline-queue UI. */
  label?: string
}

/**
 * The idempotency key one relayed command travels under.
 *
 * Kept as a pure function taking its id source, so the replay semantics can be
 * tested without a queue and without a clock.
 */
export async function botWriteIdempotencyKey(
  command: BotWriteCommand,
  _payload: Record<string, unknown>,
  freshId: () => string
): Promise<string> {
  switch (command) {
    case BOT_WRITE_COMMANDS.replayDelivery:
    case BOT_WRITE_COMMANDS.setTriggerArmed:
    case BOT_WRITE_COMMANDS.mutateInstallation:
    case BOT_WRITE_COMMANDS.runManual:
      // Minted once, here, not derived. Two manual runs ARE two runs, and a
      // derived key would fold the second press onto the first.
      return freshId()
  }
}

/**
 * The queue channel one trigger's switch commands share.
 *
 * Per trigger, not per installation: two triggers' switches are independent,
 * and ordering them against each other would only make one wait for nothing.
 */
export function botTriggerChannel(installationId: string, triggerId: string): string {
  return `bot-trigger:${installationId}:${triggerId}`
}

export interface SetTriggerArmedRemotelyInput {
  installationId: string
  triggerId: string
  armed: boolean
}

/**
 * Relay an arm, then flip the local mirror so the switch settles immediately.
 *
 * The pending marker is taken BEFORE the enqueue and released after the local
 * write, which is the window a `sync_pull` landing in between would otherwise
 * use to hand back the pre-mutation row.
 */
export async function setBotTriggerArmedRemotely(
  input: SetTriggerArmedRemotelyInput,
  options: RemoteBotWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const release = markPendingBotInstallationMutation(input.installationId)
  try {
    const payload = {
      installationId: input.installationId,
      triggerId: input.triggerId,
      armed: input.armed,
    }
    const queueRow = await enqueueOnChannel({
      command: BOT_WRITE_COMMANDS.setTriggerArmed,
      channel: botTriggerChannel(input.installationId, input.triggerId),
      idempotencyKey: await botWriteIdempotencyKey(
        BOT_WRITE_COMMANDS.setTriggerArmed,
        payload,
        () => crypto.randomUUID()
      ),
      ...(options.label ? { label: options.label } : {}),
      payload,
    })
    // The override only, and on the mirror only. Status is re-derived from the
    // credential slots, and this client has none of them: `credentialBindings`
    // is emptied by the projection, so deriving here would answer `enabled`
    // for a Bot the Host knows is `needs_setup`. Cancelling accepted work and
    // reconciling schedules are the Host's to do when the command lands.
    await setMirroredBotTriggerOverride(input.installationId, input.triggerId, input.armed)
    return queueRow
  } finally {
    release()
  }
}

export interface RunBotManuallyRemotelyInput {
  installationId: string
  triggerId?: string
  /**
   * Typed as it is on the local leg and on the wire (`bot_run_manual.input`
   * is an object), so the two legs take the same input for the same button.
   */
  input?: Record<string, unknown>
  /** Minted once by the caller and reused on every retry of this press. */
  idempotencyKey: string
}

/** Relay a manual run. No optimistic row: the delivery is the Host's to mint. */
export async function runBotManuallyRemotely(
  input: RunBotManuallyRemotelyInput,
  options: RemoteBotWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  return enqueue({
    command: BOT_WRITE_COMMANDS.runManual,
    idempotencyKey: input.idempotencyKey,
    ...(options.label ? { label: options.label } : {}),
    payload: {
      installationId: input.installationId,
      ...(input.triggerId ? { triggerId: input.triggerId } : {}),
      ...(input.input !== undefined ? { input: input.input } : {}),
      idempotencyKey: input.idempotencyKey,
    },
  })
}

/** Relay a dead-letter replay. The Host arm refuses a row that is not one. */
export async function replayBotDeliveryRemotely(
  deliveryId: string,
  options: RemoteBotWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const payload = { deliveryId }
  return enqueue({
    command: BOT_WRITE_COMMANDS.replayDelivery,
    idempotencyKey: await botWriteIdempotencyKey(BOT_WRITE_COMMANDS.replayDelivery, payload, () =>
      crypto.randomUUID()
    ),
    ...(options.label ? { label: options.label } : {}),
    payload,
  })
}
