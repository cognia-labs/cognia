/**
 * The Host brain's lane for background results (ADR-0249 §6).
 *
 * A Host keeps conversations nobody has open: a paired phone's, an IM-bound
 * one's, the owner's while the desktop is closed. An agent there that left a
 * shell job or a monitor running still owes the conversation its end, and no
 * chat controller is mounted to take the turn. This lane takes it as the
 * Host's own automated turn:
 *
 *   - The framed results become a user row stamped `background-result`
 *     (`automatedTurnMetadata`), keyed by the delivery id, so a retry of the
 *     same batch, or a window that delivers it too, lands on one row and one
 *     work submission.
 *   - The turn is accepted into the work ledger before anything is sent
 *     (ADR-0123), with no person's authorization: automation never inherits
 *     a gesture. That receipt is the delivery's acknowledgement.
 *   - It is dispatched like a HostState turn: the built-in runtime only, the
 *     transcript lock, the frozen context bound, the tool-call run bound.
 *     The Host's work-submission listener (`terminal-events.ts`) writes the
 *     reply into the transcript, books its usage and settles it; a paired
 *     client sees it through the ordinary projection, and an IM-bound
 *     conversation's push goes out through its own delivery.
 *
 * A conversation is idle when no turn of it is open in the work ledger,
 * which covers a person's queued message too (it is accepted when it is
 * queued), so a person still goes first. After a turn ends the listener
 * settles its submission asynchronously, so the drain waits for that.
 */

import type { ChatSession, ClaudeEvent, SendOptions } from "@cognia/agent-config-types"
import type { WorkReceiptV1 } from "@cognia/agent-config-types/work-submission"
import type { BackgroundDeliveryLane, BackgroundReplaySend } from "./result-delivery"

/** How long a drain after a turn waits for the turn's submission to settle. */
export const HOST_IDLE_WAIT_MS = 15_000
const HOST_IDLE_POLL_MS = 250

export interface HostAutomatedTurnDeps {
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  /** Whether the session's turns run on the built-in runtime here. */
  isBuiltinRuntime: (sessionId: string) => boolean
  /** The open submission for this delivery, when one was already accepted. */
  existingSubmission: (runId: string) => Promise<{ sessionId?: string } | undefined>
  /** The visible transcript, oldest first: what the accepted turn names. */
  listMessageIds: (sessionId: string) => Promise<string[]>
  accept: typeof import("@/lib/work-submission/chat-adapter").acceptChatTurn
  claim: typeof import("@/lib/work-submission/chat-adapter").claimChatTurnForDispatch
  markStarted: typeof import("@/lib/work-submission/chat-adapter").markChatTurnStarted
  heartbeat: (submissionId: string) => () => void
  /** Write the user row (the accepted turn's transcript write). */
  writeUserRow: (sessionId: string, row: import("ai").UIMessage) => Promise<void>
  /** Mark the row as answering the runs whose results it carries. */
  bindMessageRuns: (messageId: string, runIds: readonly string[]) => void
  buildOptions: (session: ChatSession, text: string, executionRunId: string) => Promise<SendOptions>
  /**
   * Prepare and send under the transcript lock, binding the frozen context
   * and the tool-call run first.
   */
  dispatch: (
    sessionId: string,
    text: string,
    options: SendOptions,
    turn: { messageId: string; receipt: WorkReceiptV1; commandId: string }
  ) => Promise<void>
  onError: (error: unknown) => void
}

const TURN_DEP_KEYS: readonly (keyof HostAutomatedTurnDeps)[] = [
  "getSession",
  "isBuiltinRuntime",
  "existingSubmission",
  "listMessageIds",
  "accept",
  "claim",
  "markStarted",
  "heartbeat",
  "writeUserRow",
  "bindMessageRuns",
  "buildOptions",
  "dispatch",
  "onError",
]

/**
 * Take one automated turn carrying `text` into `sessionId` on this Host.
 * Resolves `true` once the turn is durably accepted (or already was), which
 * is when the delivery may be marked done. Resolves `false`, leaving the
 * results pending, when the turn could not be accepted here.
 */
export async function runHostAutomatedTurn(
  input: {
    sessionId: string
    text: string
    deliveryId: string
    personalRunIds?: readonly string[]
  },
  overrides: Partial<HostAutomatedTurnDeps> = {}
): Promise<boolean> {
  const deps = TURN_DEP_KEYS.every((key) => overrides[key] !== undefined)
    ? (overrides as HostAutomatedTurnDeps)
    : { ...(await defaultTurnDeps()), ...overrides }
  const { sessionId, text, deliveryId } = input
  const session = await deps.getSession(sessionId)
  if (!session || !deps.isBuiltinRuntime(sessionId)) return false
  // The run and the user row share the delivery id, as a window's delivery
  // does: a second attempt finds the first one's receipt.
  const runId = deliveryId
  const accepted = await deps.existingSubmission(runId)
  if (accepted?.sessionId === sessionId) return true

  const { makeUserMessage } = await import("@/lib/claude/adapter")
  const { automatedTurnMetadata } = await import("@cognia/agent-config-types/automated-turn")
  const row = makeUserMessage(text, deliveryId)
  row.metadata = {
    ...(row.metadata as Record<string, unknown> | undefined),
    ...automatedTurnMetadata("background-result"),
  }
  if (input.personalRunIds?.length) deps.bindMessageRuns(row.id, input.personalRunIds)
  const history = (await deps.listMessageIds(sessionId)).filter((id) => id !== row.id)
  const receipt = await deps
    .accept({
      sessionId,
      runId,
      messageId: row.id,
      content: text,
      visibleMessageIds: [...history, row.id],
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.issueId ? { workItemRef: { kind: "issue" as const, id: session.issueId } } : {}),
      writeTranscript: () => deps.writeUserRow(sessionId, row),
    })
    .catch((error: unknown) => {
      deps.onError(error)
      return null
    })
  if (!receipt) return false

  // Accepted: from here the work outbox owns a turn that fails to start.
  void startAcceptedTurn(deps, session, text, row.id, receipt).catch(deps.onError)
  return true
}

async function startAcceptedTurn(
  deps: HostAutomatedTurnDeps,
  session: ChatSession,
  text: string,
  messageId: string,
  receipt: WorkReceiptV1
): Promise<void> {
  const claim = await deps.claim(receipt.runId)
  if (claim === "owned_elsewhere") return
  const stopHeartbeat = claim === "claimed" ? deps.heartbeat(receipt.submissionId) : () => {}
  try {
    const options = await deps.buildOptions(session, text, receipt.runId)
    await deps.dispatch(session.id, text, options, {
      messageId,
      receipt,
      commandId: receipt.runId,
    })
    await deps.markStarted(receipt.runId)
  } finally {
    stopHeartbeat()
  }
}

async function defaultTurnDeps(): Promise<HostAutomatedTurnDeps> {
  const [
    chatAdapter,
    { getSession },
    { listMessages, commitMessageDelta },
    { getDb },
    { runtimeRefForSession },
    { startWorkSubmissionLeaseHeartbeat },
    { bindPersonalMessageRun },
    { bindToolCallRun },
  ] = await Promise.all([
    import("@/lib/work-submission/chat-adapter"),
    import("@/lib/db/sessions"),
    import("@/lib/db/messages"),
    import("@/lib/db/schema"),
    import("@/stores/agent/agent-runtime-store"),
    import("@/lib/work-submission/lease-heartbeat"),
    import("@/lib/execution/personal-marks"),
    import("@/lib/execution/acting-authority"),
  ])
  return {
    getSession,
    isBuiltinRuntime: (sessionId) => runtimeRefForSession(sessionId).kind === "builtin",
    existingSubmission: (runId) => getDb().workSubmissions.get(chatAdapter.chatSubmissionId(runId)),
    listMessageIds: async (sessionId) =>
      (await listMessages(sessionId)).map((message) => message.id),
    accept: chatAdapter.acceptChatTurn,
    claim: chatAdapter.claimChatTurnForDispatch,
    markStarted: chatAdapter.markChatTurnStarted,
    heartbeat: (submissionId) =>
      startWorkSubmissionLeaseHeartbeat(submissionId, "live-chat", {
        onError: (error) => console.error("background delivery lease renewal failed", error),
      }),
    writeUserRow: (sessionId, row) => commitMessageDelta(sessionId, { upserts: [row] }),
    bindMessageRuns: (messageId, runIds) => bindPersonalMessageRun(messageId, runIds),
    buildOptions: async (session, text, executionRunId) => {
      const { buildSendOptions } = await import("@/hooks/chat/claude-chat-send-options")
      return buildSendOptions(session, text, undefined, undefined, undefined, { executionRunId })
    },
    dispatch: async (sessionId, text, options, turn) => {
      const [{ prepareTranscriptRuntimeSend }, { withTranscriptRuntimeLock }, { sendPrompt }] =
        await Promise.all([
          import("@/hooks/chat/claude-chat-send-options"),
          import("@/lib/chat/transcript/revision-events"),
          import("@/lib/claude/ipc"),
        ])
      await withTranscriptRuntimeLock(sessionId, async () => {
        const prepared = await prepareTranscriptRuntimeSend(sessionId, options, {
          currentMessageId: turn.messageId,
        })
        await chatAdapter.bindChatTurnContext({
          runId: turn.receipt.runId,
          context: {
            ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
            sendOptions: prepared,
          },
        })
        prepared.turnId ??= turn.receipt.turnId
        bindToolCallRun(sessionId, prepared.turnId, turn.receipt.runId)
        await sendPrompt(sessionId, text, prepared, {
          commandId: turn.commandId,
          transcriptRuntime: "prepared",
        })
      })
    },
    onError: (error) => console.error("background delivery turn failed", error),
  }
}

export interface HostDeliveryLaneDeps {
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  isBuiltinRuntime: (sessionId: string) => boolean
  /** Whether a turn of the session is open in the work ledger. */
  hasOpenTurn: (sessionId: string) => Promise<boolean>
  send: BackgroundReplaySend
  /** The Host's account database name: one consumer per Host and account. */
  databaseName: () => string
}

/** The lane: a conversation the Host owns, idle in the work ledger. */
export function createHostDeliveryLane(deps: HostDeliveryLaneDeps): BackgroundDeliveryLane {
  return {
    isReachable: async (sessionId) => {
      const session = await deps.getSession(sessionId)
      // An archived conversation is not woken; its results wait for a reader.
      if (!session || session.archivedAt !== undefined) return false
      return deps.isBuiltinRuntime(sessionId)
    },
    isIdle: async (sessionId) => !(await deps.hasOpenTurn(sessionId)),
    send: deps.send,
    consumerId: () => `brain:${deps.databaseName()}`,
  }
}

/**
 * Wait until the session's turn is closed in the ledger (bounded), then run
 * `then`. A turn's end reaches this process before the listener settles its
 * submission, so a drain at the end itself would always find it busy.
 */
export function afterTurnSettles(
  sessionId: string,
  then: () => void,
  deps: {
    hasOpenTurn: (sessionId: string) => Promise<boolean>
    schedule?: (run: () => void, ms: number) => unknown
    now?: () => number
    timeoutMs?: number
    pollMs?: number
  }
): void {
  const schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms))
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.timeoutMs ?? HOST_IDLE_WAIT_MS)
  const check = () => {
    void deps
      .hasOpenTurn(sessionId)
      .catch(() => false)
      .then((open) => {
        if (!open || now() >= deadline) then()
        else schedule(check, deps.pollMs ?? HOST_IDLE_POLL_MS)
      })
  }
  check()
}

/** Whether a frame says a session's turn ended. */
export function isTurnEndFrame(event: ClaudeEvent): event is ClaudeEvent & { sessionId: string } {
  return event.type === "session_ended" && typeof event.sessionId === "string"
}
