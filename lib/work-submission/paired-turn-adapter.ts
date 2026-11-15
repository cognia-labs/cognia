/**
 * Paired direct-turn ⇄ WorkSubmission adapter (ADR-0123).
 *
 * A paired client sends its turns straight to this Host over Agent RPC
 * (`agent_send`), because only that path carries the turn's own options — the
 * provider and model it picked and a device-local key for this turn alone.
 * Nothing on the Host saw those turns arrive: the companion server wrote the
 * prompt to the sidecar and the brain only ever heard the frames that came
 * back. With no open submission for the session, the terminal-event persister
 * (`terminal-events.ts`) dropped every frame, and the reply was never kept on
 * the machine that produced it.
 *
 * The companion server now asks this module to admit each device-originated
 * turn before it hands the prompt over (`send_arm` in
 * `crates/cognia-companion-rpc/src/rpc/chat.rs`). Admission writes the user's
 * message under the client's own id, accepts and claims a submission, and keeps
 * its lease alive until the persister settles it on `session_ended`.
 *
 * ## What is deliberately not stored
 *
 * The turn's `SendOptions` travel transiently for Host history preparation and are never frozen into an execution-context bundle
 * (`bindWorkExecutionContext`): they may carry `providerCredentials`, and a
 * credential must not land in the Host's durable store. The cost is honest — a
 * Host that dies mid-turn cannot re-dispatch it, and recovery settles it as
 * `recovery_required` (`stored-chat-dispatch.ts`) rather than guessing options.
 *
 * Brain-originated sends (the HostState dispatcher) are already admitted by
 * `host-adapter.ts` and never reach here: the server skips the service scope.
 */

import type { UIMessage } from "ai"
import type { ChatSession, SendContent, SendOptions } from "@cognia/agent-config-types"

import { claimWorkSubmission } from "@/lib/db/work-submissions"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

import { chatSubmissionId } from "./chat-adapter"
import { startWorkSubmissionLeaseHeartbeat } from "./lease-heartbeat"
import {
  acceptWorkSubmission,
  markWorkSubmissionStarted,
  settleWorkSubmission,
  WorkSubmissionRejectedError,
  type WorkSubmissionServiceDeps,
} from "./service"

/** The internal bridge commands the companion server routes here. */
export const PAIRED_TURN_COMMANDS = ["paired_turn_admit", "paired_turn_abandon"] as const
export type PairedTurnCommand = (typeof PAIRED_TURN_COMMANDS)[number]

export function isPairedTurnCommand(command: string): command is PairedTurnCommand {
  return (PAIRED_TURN_COMMANDS as readonly string[]).includes(command)
}

/** Lease owner for the admitted row; distinct so a takeover names its origin. */
export const PAIRED_TURN_LEASE_OWNER = "paired-turn"

export type PairedTurnAdmission =
  | { admitted: true; submissionId: string; options: SendOptions }
  /** No runtime target on this Host: work submissions are off, as for local chat. */
  | { admitted: false; untracked: true }
  /** The Host will not run this turn; the server answers the client with `code`. */
  | { admitted: false; refusal: { code: string; message: string } }

export interface PairedTurnAdapterDeps extends WorkSubmissionServiceDeps {
  getSession?: (
    sessionId: string
  ) => Promise<
    | Pick<
        ChatSession,
        | "id"
        | "handoffLock"
        | "sdkSessionId"
        | "externalAgentSession"
        | "externalAgentGatewaySessions"
        | "activeBranchByGroup"
        | "projectThread"
      >
    | undefined
  >
  getMessage?: (messageId: string) => Promise<{ sessionId: string } | undefined>
  commitUserMessage?: (sessionId: string, message: UIMessage) => Promise<void>
  startHeartbeat?: (submissionId: string) => () => void
}

function refusal(code: string, message: string): PairedTurnAdmission {
  return { admitted: false, refusal: { code, message } }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isSendContent(value: unknown): value is SendContent {
  return typeof value === "string" || Array.isArray(value)
}

/** The run id the server minted from this turn's remote execution context. */
export function pairedTurnSubmissionId(runId: string): string {
  return chatSubmissionId(runId)
}

export async function admitPairedChatTurn(
  payload: Record<string, unknown>,
  deps: PairedTurnAdapterDeps = {}
): Promise<PairedTurnAdmission> {
  const sessionId = stringField(payload, "sessionId")
  const runId = stringField(payload, "runId")
  const prompt = payload.prompt
  if (!sessionId || !runId || !isSendContent(prompt)) {
    throw new Error("paired_turn_invalid_request")
  }
  const messageId = stringField(payload, "messageId") ?? `${runId}:user`

  const active = getActiveRuntimeTargetContext()
  if (!active)
    return payload.pairedReader === "owner"
      ? { admitted: false, untracked: true }
      : refusal("personal_visibility_changed", "A member turn requires Host admission.")
  // The server binds the caller's account from its own session, overwriting
  // anything the client sent; a mismatch is a pairing for another account.
  if (stringField(payload, "callerAccountId") !== active.accountId) {
    return refusal("host_state_scope_mismatch", "The caller is not paired to this Host's account.")
  }

  const [{ getSession: defaultGetSession }, { getDb }] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/schema"),
  ])
  const session = await (deps.getSession ?? defaultGetSession)(sessionId)
  if (!session) return refusal("session_not_found", "The session does not exist on this Host.")
  const { assertSessionWritable, SessionHandoffLockedError } =
    await import("@/lib/chat/session-write-guard")
  try {
    assertSessionWritable(session as Parameters<typeof assertSessionWritable>[0], "send-message")
  } catch (error) {
    if (error instanceof SessionHandoffLockedError) {
      return refusal(error.code, "The session is read-only during a handoff.")
    }
    throw error
  }

  // A retry re-sends the turn the session already holds; only a new message is
  // written. A message id that belongs to another session is refused outright.
  const existing = await (deps.getMessage ?? ((id: string) => getDb().messages.get(id)))(messageId)
  if (existing && existing.sessionId !== sessionId) {
    return refusal("host_state_message_id_exists", "The message id already exists.")
  }
  if (existing) {
    const canonical = await getDb().messages.get(messageId)
    if (canonical) {
      const { assertPairedMessageMutation, PairedMessageConflictError } =
        await import("@/lib/companion/desktop-message-source")
      try {
        await assertPairedMessageMutation(canonical, payload.pairedReader, prompt)
      } catch (error) {
        if (error instanceof PairedMessageConflictError)
          return refusal(error.code, "The referenced message is not writable by this reader.")
        throw error
      }
    }
  }
  const commit =
    deps.commitUserMessage ??
    (async (id: string, message: UIMessage) => {
      const { commitMessageDelta } = await import("@/lib/db/messages")
      await commitMessageDelta(id, { upserts: [message] })
    })
  const { makeUserMessage } = await import("@/lib/claude/adapter")
  const userMessage = makeUserMessage(prompt, messageId)

  const submissionId = pairedTurnSubmissionId(runId)
  const now = deps.now?.() ?? Date.now()
  try {
    const authorityModule = await import("@/lib/execution/acting-authority")
    await acceptWorkSubmission(
      {
        parentRunId: session.projectThread?.parentExecutionRunId,
        ...(payload.pairedReader === "owner"
          ? { localAuthorization: authorityModule.LOCAL_PERSON_RUN }
          : {}),
        intent: {
          contractVersion: 1,
          idempotencyKey: `paired:${sessionId}:${runId}`,
          source: { kind: "chat", sourceId: sessionId },
          scope: { accountId: active.accountId, runtimeTargetId: active.targetId, sessionId },
          // The device is waiting on this RPC; the turn runs now or not at all.
          availabilityPolicy: "fail",
        },
        runId,
        turnId: runId,
        submissionId,
        inputBatchId: `input:${runId}`,
        input: { content: prompt, visibleMessageIds: [messageId], attachments: [] },
        ...(existing ? {} : { writeTranscript: () => commit(sessionId, userMessage) }),
        now,
      },
      deps
    )
  } catch (error) {
    if (error instanceof WorkSubmissionRejectedError) {
      return refusal(`work_submission_${error.code}`, error.message)
    }
    throw error
  }

  if (!(await claimWorkSubmission(submissionId, PAIRED_TURN_LEASE_OWNER, now))) {
    return refusal("paired_turn_owned_elsewhere", "The turn is already being dispatched.")
  }
  // Runs until the persister settles the row; `lease-heartbeat` stops itself
  // once it finds the row settled, so there is nothing to tear down on success.
  ;(
    deps.startHeartbeat ??
    ((id: string) =>
      startWorkSubmissionLeaseHeartbeat(id, PAIRED_TURN_LEASE_OWNER, {
        onError: (error) => console.error("paired turn lease renewal failed", error),
      }))
  )(submissionId)
  try {
    const options = { ...((payload.options ?? {}) as SendOptions) }
    // Client history and visibility assertions are never Host authority.
    for (const key of [
      "personalVisibilityDigest",
      "personalContextReadersDigest",
      "personalVisibilityHasWithheld",
      "initialConversation",
      "priorMessages",
      "history",
      "runtimeHistory",
      "pairedReader",
      "runAuthorityMcpServerIds",
    ]) {
      delete (options as Record<string, unknown>)[key]
    }
    const externalRoute = [
      session.externalAgentSession,
      ...(session.externalAgentGatewaySessions ?? []),
    ].find(
      (link) => options.resumeSessionId !== undefined && link?.sessionId === options.resumeSessionId
    )
    if (payload.pairedReader !== "owner") {
      // A client cannot borrow an unrelated opaque engine's retained memory.
      if (options.resumeSessionId !== session.sdkSessionId && !externalRoute)
        options.resumeSessionId = undefined
      options.forkFromSessionId = undefined
    }
    options.turnId = runId
    const { bindToolCallRun } = await import("@/lib/execution/acting-authority")
    bindToolCallRun(sessionId, runId, runId, options.execution?.identity?.attemptId, {
      builtinRuntime: true,
    })
    const { prepareTranscriptRuntimeSend } = await import("@/hooks/chat/claude-chat-send-options")
    const { withTranscriptRuntimeLock } = await import("@/lib/chat/transcript/revision-events")
    const prepared = await withTranscriptRuntimeLock(sessionId, async () => {
      if (externalRoute) {
        const { listMessages } = await import("@/lib/db/messages")
        const { selectVisibleMessages } = await import("@/stores/chat")
        const { preparePersonalHistory } = await import("@/lib/execution/personal-visibility")
        const history = await preparePersonalHistory(
          sessionId,
          selectVisibleMessages(await listMessages(sessionId), session.activeBranchByGroup ?? {}),
          { executionRunId: runId }
        )
        if (
          history.withheldMessageIds.length &&
          externalRoute.personalVisibilityDigest !== history.visibilityDigest
        ) {
          // agent_send owns the builtin sidecar, not the external manager's
          // route reconstruction. It cannot safely rebuild this opaque engine.
          throw new Error("personal_visibility_changed")
        }
        const current = await getDb().sessions.get(sessionId)
        if (!current) throw new Error("session_not_found")
        const stamp = <T extends { sessionId: string; personalVisibilityDigest?: string }>(
          link: T
        ): T =>
          link.sessionId === externalRoute.sessionId
            ? { ...link, personalVisibilityDigest: history.visibilityDigest }
            : link
        await getDb().sessions.update(sessionId, {
          ...(current.externalAgentSession
            ? { externalAgentSession: stamp(current.externalAgentSession) }
            : {}),
          ...(current.externalAgentGatewaySessions
            ? { externalAgentGatewaySessions: current.externalAgentGatewaySessions.map(stamp) }
            : {}),
        })
        return {
          ...options,
          personalVisibilityDigest: history.visibilityDigest,
          personalVisibilityHasWithheld: history.withheldMessageIds.length > 0,
        }
      }
      return prepareTranscriptRuntimeSend(sessionId, options, {
        executionRunId: runId,
        currentMessageId: messageId,
      })
    })
    const { enforceRunAuthorityOnSendOptions } = await import("@/lib/execution/run-authority")
    await enforceRunAuthorityOnSendOptions(runId, prepared)
    await markWorkSubmissionStarted(submissionId, now)
    return { admitted: true, submissionId, options: prepared }
  } catch (error) {
    await settleWorkSubmission(
      { submissionId, outcome: "failed", errorCode: "personal_visibility_changed" },
      deps
    )
    return refusal(
      "personal_visibility_changed",
      error instanceof Error ? error.message : "Host history preparation failed."
    )
  }
}

/**
 * The server could not hand an admitted turn to the runtime. Seal it as failed
 * so the session is not left with an open submission that nothing will end.
 */
export async function abandonPairedChatTurn(
  payload: Record<string, unknown>,
  deps: WorkSubmissionServiceDeps = {}
): Promise<{ settled: boolean }> {
  const submissionId = stringField(payload, "submissionId")
  if (!submissionId) throw new Error("paired_turn_invalid_request")
  const settled = await settleWorkSubmission(
    {
      submissionId,
      outcome: "failed",
      errorCode: stringField(payload, "errorCode") ?? "dispatch_failed",
    },
    deps
  )
  return { settled }
}

export async function dispatchPairedTurnCommand(
  command: PairedTurnCommand,
  payload: Record<string, unknown>
): Promise<unknown> {
  return command === "paired_turn_admit"
    ? admitPairedChatTurn(payload)
    : abandonPairedChatTurn(payload)
}
