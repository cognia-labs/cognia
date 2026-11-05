/**
 * HostState ⇄ WorkSubmission adapter (ADR-0123).
 *
 * An attached client (mobile, web, CLI) does not run the chat controller, so
 * the renderer's acceptance never happens for its turns. The Host is where
 * those turns become real, and this is where they become durable.
 *
 * **The wire protocol is untouched.** `AllowedHostStateIntent` gains nothing:
 * every guard in `host-state.ts` is a closed shape that rejects any field it
 * does not know, so smuggling a submission field through an action would fail
 * the guard outright. Instead the Host wraps the `message.enqueue` it already
 * receives.
 *
 * ## Why the idempotency key matches the renderer's
 *
 * Both paths key on `chat:{sessionId}:{messageId}`. A turn that somehow reaches
 * the Host twice — once through the client outbox and once locally — is the
 * same work and must collapse onto one submission, one run, and one reply.
 * Deriving the key from the transport's `actionId` instead would make those two
 * arrivals look like different turns.
 *
 * The run id *does* come from `actionId`, because the Host has no chat run
 * counter and the action id is already the dedup key the runtime command uses.
 */

import type { HostStateAction, HostStateAttachmentRef } from "@cognia/agent-config-types/host-state"
import type { WorkAttachmentRefV1, WorkReceiptV1 } from "@cognia/agent-config-types/work-submission"
import type { SendOptions } from "@cognia/agent-config-types"

import { parseUploadRef, resolveAttachmentRef } from "@/lib/db/session-attachment-uploads"

import {
  claimWorkSubmission,
  getWorkSubmission,
  getWorkSubmissionBundle,
  listWorkSubmissions,
  type WorkSubmissionRow,
} from "@/lib/db/work-submissions"

import { chatIdempotencyKey } from "./chat-adapter"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { openWorkSubmissionPayload, type WorkSubmissionCryptoDeps } from "./crypto"
import { planWorkSubmissionRecovery, type WorkRecoveryDeps } from "./recovery"
import {
  acceptWorkSubmission,
  bindWorkExecutionContext,
  markWorkSubmissionStarted,
  settleWorkSubmissionWithoutTranscript,
  WorkSubmissionRejectedError,
  type WorkSubmissionServiceDeps,
} from "./service"

export interface HostAdapterDeps extends WorkSubmissionServiceDeps, WorkRecoveryDeps {
  onError?: (error: unknown) => void
  /**
   * Stop the runtime a previous owner handed this turn to, before a takeover
   * dispatches it again. Defaults to interrupting the submission's session.
   */
  abortPrevious?: (submission: WorkSubmissionRow) => Promise<void>
}

/**
 * The staged uploads a HostState turn's frozen input names (ADR-0253 §9 G25).
 *
 * A `message.enqueue` ref is frozen as an attachment whose `assetId` is the
 * ref itself and whose `digest` is the hash the Host verified at commit: a
 * content address over bytes the Host stages, not a claim of the client's.
 * The bytes live in the upload store, not the ledger, so only the Host that
 * staged them can send the turn again, and only while they are held.
 */
export function hostStateUploadRefs(attachments: readonly WorkAttachmentRefV1[]): string[] {
  return attachments
    .map((attachment) => attachment.assetId)
    .filter((ref) => parseUploadRef(ref) !== null)
}

/** A display name the work-input guard accepts: never a path. */
function frozenFileName(name: string): string {
  const flat = name.replace(/[/\\\0]/g, "_").trim()
  return flat === "" || flat === "." || flat === ".." ? "attachment" : flat
}

/**
 * The turn's refs as content-addressed attachments, read from the upload
 * store. A ref that no longer resolves is left out: the dispatch refuses the
 * turn for it (`host_state_attachment_unavailable`), and nothing frozen here
 * could stand in for the missing bytes.
 */
async function frozenHostStateAttachments(
  sessionId: string,
  attachments: readonly HostStateAttachmentRef[]
): Promise<WorkAttachmentRefV1[]> {
  const frozen: WorkAttachmentRefV1[] = []
  for (const attachment of attachments) {
    if (!attachment.ref || !parseUploadRef(attachment.ref)) continue
    const row = await resolveAttachmentRef(attachment.ref, { sessionId })
    if (!row) continue
    frozen.push({
      assetId: attachment.ref,
      digest: row.hash,
      mediaType: row.mediaType,
      size: row.size,
      fileName: frozenFileName(row.name),
    })
  }
  return frozen
}

/** Deterministic per action, so a redelivered action maps to the same run. */
export function hostStateRunId(actionId: string): string {
  return `hoststate:${actionId}`
}

export function hostStateSubmissionId(actionId: string): string {
  return `work:${hostStateRunId(actionId)}`
}

/**
 * Durably accept a `message.enqueue` before the Host dispatches it.
 *
 * Returns `null` when the feature is off, the action is not a message enqueue,
 * or it carries no session — in every case the Host proceeds exactly as it does
 * today. A rejection is reported and also yields `null`: an attached client's
 * message must not be dropped because a ledger insert failed.
 */
export async function acceptHostStateChatTurn(
  action: HostStateAction,
  deps: HostAdapterDeps = {}
): Promise<WorkReceiptV1 | null> {
  if (action.action.kind !== "message.enqueue") return null
  const sessionId = action.sessionId
  if (!sessionId) return null

  try {
    const attachments = await frozenHostStateAttachments(sessionId, action.action.attachments)
    return await acceptWorkSubmission(
      {
        localAuthorization: LOCAL_PERSON_RUN,
        intent: {
          contractVersion: 1,
          // Same shape the renderer uses, so the two arrival paths collapse.
          idempotencyKey: chatIdempotencyKey(sessionId, action.action.messageId),
          source: { kind: "chat", sourceId: sessionId, triggerId: action.actionId },
          scope: {
            accountId: action.accountId,
            runtimeTargetId: action.runtimeTargetId,
            sessionId,
          },
          availabilityPolicy: "wait",
        },
        runId: hostStateRunId(action.actionId),
        turnId: hostStateRunId(action.actionId),
        submissionId: hostStateSubmissionId(action.actionId),
        inputBatchId: `input:${hostStateRunId(action.actionId)}`,
        input: {
          content: action.action.text,
          visibleMessageIds: [action.action.messageId],
          // The staged uploads the turn names, by ref and verified hash. The
          // text alone is not the turn: a retry after a Host restart resends
          // these refs, and settling the turn releases their bytes.
          attachments,
        },
      },
      deps
    )
  } catch (error) {
    deps.onError?.(error)
    if (error instanceof WorkSubmissionRejectedError) return null
    throw error
  }
}

/** Freeze the exact options the HostState production path is about to send. */
export async function bindHostStateChatTurnContext(
  action: HostStateAction,
  sendOptions: SendOptions,
  deps: HostAdapterDeps = {}
): Promise<boolean> {
  if (action.action.kind !== "message.enqueue" || !action.sessionId) return false
  try {
    const runId = hostStateRunId(action.actionId)
    const result = await bindWorkExecutionContext(
      {
        submissionId: hostStateSubmissionId(action.actionId),
        accountId: action.accountId,
        contextBundleId: `context:${runId}`,
        context: {
          ...(sendOptions.cwd ? { cwd: sendOptions.cwd } : {}),
          sendOptions,
        },
      },
      deps
    )
    return result.bound
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/** Record that the live HostState path successfully handed the turn off. */
export async function markHostStateChatTurnStarted(
  actionId: string,
  now = Date.now(),
  deps: HostAdapterDeps = {}
): Promise<boolean> {
  try {
    await markWorkSubmissionStarted(hostStateSubmissionId(actionId), now)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  }
}

/**
 * `legacy` — no submission exists, so the Host dispatches as it always has.
 * `claimed` — this Host owns the attempt and may send.
 * `owned_elsewhere` — another owner holds it, or it already settled.
 * `recovery_required` — an earlier attempt may have had effects; the
 * submission was settled for an explicit resume and must not be re-sent.
 */
export type HostStateTurnDispatchClaim =
  "legacy" | "claimed" | "owned_elsewhere" | "recovery_required"

/**
 * Fence HostState assembly before resolving provider options or transport.
 *
 * A HostState redrive (startup recovery, a periodic retry) reaches this with a
 * submission an earlier attempt may already have handed to the runtime. That
 * attempt is ambiguous in exactly the way the work outbox's is, so it gets the
 * same decision: the replay-safety plan runs before the claim, and a takeover
 * of a dispatched turn stops the previous runtime before anything is re-sent.
 * Two recovery paths with two policies is how a turn that already ran a tool
 * ends up running it again.
 */
export async function claimHostStateChatTurnForDispatch(
  actionId: string,
  now = Date.now(),
  deps: HostAdapterDeps = {}
): Promise<HostStateTurnDispatchClaim> {
  const submissionId = hostStateSubmissionId(actionId)
  // Consumed here whatever the row says, so a permit never outlives its claim.
  const afterRestart = restartRedispatchPermits.delete(actionId)
  let row: WorkSubmissionRow | undefined
  try {
    row = await getWorkSubmission(submissionId)
  } catch (error) {
    deps.onError?.(error)
    return "legacy"
  }
  if (!row) return "legacy"
  // From here the submission is known to exist, so a failure must not fall
  // back to an unfenced send: the work outbox owns the row and will decide.
  try {
    if (row.dispatchState === "settled") return "owned_elsewhere"
    if (!afterRestart) {
      // A live lease is a live owner. Planning against its row could settle a
      // turn that owner is handing off right now.
      if (
        (row.dispatchState === "claimed" || row.dispatchState === "dispatched") &&
        (row.leaseExpiresAt ?? 0) > now
      ) {
        return "owned_elsewhere"
      }
      const plan = await planWorkSubmissionRecovery(row, deps)
      if (plan.action === "recovery_required") {
        await settleWorkSubmissionWithoutTranscript(
          submissionId,
          "recovery_required",
          now,
          plan.reason
        )
        return "recovery_required"
      }
    }
    // After a Host restart the organization chose at-least-once: the turn is
    // sent again whatever its first attempt did, and the lease it held died
    // with the Host. Its runtime went too, so there is nothing to stop first.
    const claimed = await claimWorkSubmission(submissionId, "host-state", now, undefined, {
      previousOwnerGone: afterRestart,
    })
    if (!claimed) return "owned_elsewhere"
    if (claimed.takeoverRequired && !afterRestart) {
      try {
        await (deps.abortPrevious ?? abortSubmissionSession)(claimed)
      } catch (error) {
        deps.onError?.(error)
        await settleWorkSubmissionWithoutTranscript(
          submissionId,
          "recovery_required",
          now,
          "takeover_abort_failed"
        )
        return "recovery_required"
      }
    }
    return "claimed"
  } catch (error) {
    deps.onError?.(error)
    return "owned_elsewhere"
  }
}

async function abortSubmissionSession(submission: WorkSubmissionRow): Promise<void> {
  if (!submission.sessionId) return
  const { interruptSession } = await import("@/lib/claude/ipc")
  await interruptSession(submission.sessionId)
}

// ── ADR-0253 §7: member turns a Host restart interrupted ────────────────────

/** Why a member turn the Host's restart interrupted ended. */
export const HOST_RESTARTED = "host_restarted"

/** Action ids whose next claim may pass the replay-safety plan, once. */
const restartRedispatchPermits = new Set<string>()

/**
 * Let the next {@link claimHostStateChatTurnForDispatch} of `actionId` claim
 * its submission again although an earlier attempt may have had effects.
 *
 * Only the restart recovery calls this, and only for an organization that
 * asked for interrupted turns to be retried (`resumeAfterRestart`): that is an
 * explicit choice of at-least-once over the parked resume this module would
 * otherwise require. The transcript says so before the turn is sent again.
 */
export function permitHostStateRedispatchAfterRestart(actionId: string): void {
  restartRedispatchPermits.add(actionId)
}

/** Drop a permit whose dispatch never reached its claim. */
export function revokeHostStateRedispatchPermit(actionId: string): void {
  restartRedispatchPermits.delete(actionId)
}

/** One HostState chat turn accepted before the Host restarted, still open. */
export interface InterruptedHostStateTurn {
  submissionId: string
  actionId: string
  sessionId: string
  /** The member's message; `null` when the frozen input cannot be read. */
  messageId: string | null
  text: string | null
  /**
   * The staged uploads the turn carried, to send again with its words. They
   * are held until the turn settles (`holdAttachmentRefs`), so a retry reads
   * the same bytes.
   */
  attachments: HostStateAttachmentRef[]
  /** A file of the turn is no longer staged here; it cannot be sent again. */
  attachmentsLost: boolean
  createdAt: number
}

/**
 * The HostState chat turns of `sessionId` accepted before `bootedAt` that
 * never settled, oldest first.
 *
 * A Host restart is the only thing that leaves one: the brain that held it
 * went with the Host, and a member's brain runs no outbox that would settle it
 * later. The text comes from the frozen input, which is what the turn sent.
 */
export async function listHostStateTurnsInterruptedBefore(
  sessionId: string,
  bootedAt: number,
  deps: WorkSubmissionCryptoDeps & { list?: typeof listWorkSubmissions } = {}
): Promise<InterruptedHostStateTurn[]> {
  const rows = await (deps.list ?? listWorkSubmissions)({
    sessionId,
    dispatchStates: ["pending", "blocked", "claimed", "dispatched"],
    limit: 1000,
  })
  const open = rows
    .filter(
      (row) =>
        row.sourceKind === "chat" &&
        row.runId.startsWith("hoststate:") &&
        typeof row.triggerId === "string" &&
        row.createdAt < bootedAt
    )
    .sort((a, b) => a.createdAt - b.createdAt)
  return Promise.all(open.map((row) => readInterruptedTurn(row, sessionId, deps)))
}

async function readInterruptedTurn(
  row: WorkSubmissionRow,
  sessionId: string,
  deps: WorkSubmissionCryptoDeps
): Promise<InterruptedHostStateTurn> {
  const turn: InterruptedHostStateTurn = {
    submissionId: row.id,
    actionId: row.triggerId!,
    sessionId,
    messageId: null,
    text: null,
    attachments: [],
    attachmentsLost: false,
    createdAt: row.createdAt,
  }
  try {
    const bundle = await getWorkSubmissionBundle(row.id)
    if (!bundle?.inputBatch) return turn
    const input = JSON.parse(
      await openWorkSubmissionPayload(
        bundle.inputBatch.envelope,
        { accountId: row.accountId, submissionId: row.id, kind: "input-batch" },
        deps
      )
    ) as { content?: unknown; visibleMessageIds?: unknown }
    const messageId = Array.isArray(input.visibleMessageIds) ? input.visibleMessageIds[0] : null
    if (typeof input.content !== "string" || typeof messageId !== "string") return turn
    const attachments: HostStateAttachmentRef[] = []
    let attachmentsLost = false
    for (const frozen of bundle.inputBatch.attachments) {
      if (!parseUploadRef(frozen.assetId)) {
        // Not a staged upload: nothing here can put it back into a prompt.
        attachmentsLost = true
        continue
      }
      const staged = await resolveAttachmentRef(frozen.assetId, { sessionId })
      // Staged again under the same ref is the same bytes only if the hash agrees.
      if (!staged || staged.hash !== frozen.digest) attachmentsLost = true
      attachments.push({
        name: frozen.fileName,
        mediaType: frozen.mediaType,
        size: frozen.size,
        hash: frozen.digest,
        ref: frozen.assetId,
      })
    }
    return { ...turn, messageId, text: input.content, attachments, attachmentsLost }
  } catch {
    return turn
  }
}

/** End an interrupted turn the Host will not retry, as `host_restarted`. */
export async function failHostStateTurnAfterRestart(
  submissionId: string,
  now = Date.now()
): Promise<boolean> {
  return settleWorkSubmissionWithoutTranscript(submissionId, "failed", now, HOST_RESTARTED)
}
