import { bindPersonalMessageRun } from "@/lib/execution/personal-marks"
/**
 * A synchronous, tool-enabled agent turn, run headlessly on a plugin's behalf.
 *
 * `ctx.agent` dispatches subagents and invokes tools; it cannot run a full
 * CHARACTER turn — resolve a persona, pin it to a working directory, drive the
 * sidecar with that character's tools and wait for the reply. A plugin that
 * wants the one workflow path that actually edits code had to assemble that
 * from `@/lib/db/characters`, `@/lib/db/sessions`, `@/lib/db/settings`,
 * `@/lib/claude/build-options` and `@/lib/claude/run-and-capture` — five
 * host-private modules, one of which (`getSettings`) hands over the entire
 * settings row including every credential.
 *
 * This is that sequence as one call, published to authors as
 * `@cognia/plugin-sdk/api/agent-turn`. `AppSettings` never leaves the host.
 *
 * ## Permission posture
 *
 * `permissionMode` defaults to the character's own. A headless caller has no UI
 * to answer a permission prompt, so a tool-enabled turn would hang forever
 * waiting on one — but the fix must be a decision at THIS call site, not a
 * property of the character: a character's `permissionMode` is consulted for
 * every interactive chat with that character too, so widening it there hands
 * un-prompted Edit/Write/Bash to anyone who picks that persona from the
 * character list. Pass `"bypassPermissions"` explicitly, per call.
 *
 * Every turn is unattended (ADR-0224 A7). It carries a permission profile: the
 * host's ceiling, narrowed by any profile the caller's grants declare (a Bot's
 * installation profile arrives that way). Outbound messages, secret use and
 * host configuration changes therefore ask a person even under
 * `bypassPermissions`, and a request that asks is parked for a person rather
 * than denied, with the turn's wall clock stopped while it waits.
 */

import {
  PluginAgentTurnError,
  type PluginAgentTurnRequest,
  type PluginAgentTurnResult,
} from "@cognia/plugin-sdk/api/agent-turn"
import { createUnattendedPermissionResponder } from "@/lib/claude/unattended-permission-responder"
import { createUnattendedPark } from "@/lib/claude/unattended-park"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import type { ChatSession, SendOptions } from "@cognia/agent-config-types"
import type { SessionImAuthority } from "@cognia/plugin-contract/types/connectors/binding"
import { commitMessageDelta, prepareMessageDelta, stampSessionLastMessage } from "@/lib/db/messages"
import {
  operationTranscriptDigest,
  type AgentTurnOperationCompletion,
} from "@/lib/db/shared-run-journal"
import { getDb } from "@/lib/db/schema"
import {
  acknowledgeTranscriptRuntime,
  invalidateTranscriptRuntime,
  withTranscriptRuntimeLock,
} from "@/lib/chat/transcript/revision-events"
import { registerCaptureResponder } from "@/lib/connectors/hitl/approval-registry"
import { startToolExecutionRun, finishToolExecutionRun } from "@/lib/execution/acting-authority"
import { applySdkEvent, sdkMediaPart, type UsageInfo } from "@/lib/claude/adapter"
import { applyExternalAgentEventToParts } from "@/lib/ai/agent/external/session/event-to-parts"
import type { UIMessage } from "ai"
import type { A2UIPart, SourcesPart } from "@/lib/claude/parts-extensions"
import { claimTurnUsage, trackCaptureUsage } from "@/lib/usage/claimed-turn-usage"
import { withSessionTurnLock } from "@/lib/execution/session-turn-lock"
import { createMutex, type Mutex } from "@cognia/primitives"
import { sha256Hex } from "@/lib/share/hash"

const agentTurnLocks = new Map<string, { mutex: Mutex; users: number }>()

/** Distinct lock namespaces avoid nesting the capture's transcript-runtime lock. */
async function withAgentTurnLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const database = getDb()
  const name = `cognia:agent-turn:${database.name}:${key}`
  const guarded = async () => {
    if (getDb() !== database)
      throw new PluginAgentTurnError("runPluginAgentTurn: database changed while waiting")
    return action()
  }
  const locks = globalThis.navigator?.locks
  if (locks?.request) return locks.request(name, guarded)
  let entry = agentTurnLocks.get(name)
  if (!entry) {
    entry = { mutex: createMutex(), users: 0 }
    agentTurnLocks.set(name, entry)
  }
  entry.users++
  try {
    return await entry.mutex.runExclusive(guarded)
  } finally {
    if (--entry.users === 0) agentTurnLocks.delete(name)
  }
}

export {
  PluginAgentTurnError,
  type PluginAgentTurnDenial,
  type PluginAgentTurnRequest,
  type PluginAgentTurnResult,
} from "@cognia/plugin-sdk/api/agent-turn"

/**
 * Reuse only a session created for this caller and character. Implicit reuse
 * also requires the same cwd; only an explicit owned session may be repinned.
 * Legacy sessions have no ownership stamp and must never be adopted by title.
 */
async function ensureSession(
  characterId: string,
  cwd: string,
  owner: NonNullable<ChatSession["agentTurnOwner"]>,
  sessionId?: string,
  platformBinding?: ChatSession["platformBinding"],
  creationId?: string,
  refresh = true
): Promise<string> {
  const db = await import("@/lib/db/sessions")
  const authorityBinding = (session: ChatSession & SessionImAuthority) =>
    session.imAuthorityBinding ?? session.platformBinding
  const isOwned = (session: ChatSession) =>
    session.characterId === characterId &&
    session.agentTurnOwner?.kind === owner.kind &&
    session.agentTurnOwner.id === owner.id &&
    session.agentTurnOwner.key === owner.key &&
    authorityBinding(session)?.adapterId === platformBinding?.adapterId &&
    authorityBinding(session)?.conversationKey === platformBinding?.conversationKey &&
    authorityBinding(session)?.platform === platformBinding?.platform
  const refreshAuthority = async (session: ChatSession) => {
    // Convert earlier 2-0b owned rows as well. Never turn an app transcript into
    // a connector conversation, including when sync copies it to another client.
    const patch: Partial<ChatSession> & SessionImAuthority = {
      ...(session.workingDir !== cwd ? { workingDir: cwd } : {}),
      ...(platformBinding ? { imAuthorityBinding: platformBinding } : {}),
      platformBinding: undefined,
      platformConversationKey: undefined,
    }
    await db.updateSession(session.id, patch)
  }
  if (sessionId) {
    const existing = await db.getSession(sessionId)
    if (!existing) {
      throw new PluginAgentTurnError(`runPluginAgentTurn: session "${sessionId}" not found`)
    }
    if (!isOwned(existing)) {
      throw new PluginAgentTurnError(
        `runPluginAgentTurn: session "${sessionId}" is not owned by this caller and character`
      )
    }
    if (refresh && (existing.workingDir !== cwd || platformBinding || existing.platformBinding))
      await refreshAuthority(existing)
    return existing.id
  }
  const match = (await db.listSessions()).find((s) => isOwned(s) && s.workingDir === cwd)
  if (match) {
    if (refresh && (platformBinding || match.platformBinding)) await refreshAuthority(match)
    return match.id
  }
  const seed: Partial<ChatSession> & SessionImAuthority = {
    title: `Plugin turn — ${characterId}`,
    characterId,
    workingDir: cwd,
    agentTurnOwner: owner,
    ...(platformBinding ? { imAuthorityBinding: platformBinding } : {}),
  }
  // Explicit continuation can repin a formerly implicit row to a different
  // cwd. Occupied deterministic slots remain history; all creators converge on
  // the next slot instead of overwriting that row or failing the old cwd.
  for (let slot = 0; ; slot++) {
    const candidateId = creationId ? `${creationId}${slot ? `_${slot}` : ""}` : undefined
    try {
      const created = await db.createSession(
        seed,
        undefined,
        candidateId ? { id: candidateId } : undefined
      )
      return created.id
    } catch (error) {
      if (
        !candidateId ||
        !error ||
        typeof error !== "object" ||
        !("name" in error) ||
        error.name !== "ConstraintError"
      )
        throw error
      const winner = await db.getSession(candidateId)
      if (!winner || !isOwned(winner))
        throw new PluginAgentTurnError(
          "runPluginAgentTurn: session identity is owned by another caller"
        )
      if (winner.workingDir === cwd) return winner.id
    }
  }
}

/**
 * Validate the request's grants and attribute them to the caller. A malformed
 * grant fails the turn rather than being dropped: running without a denial the
 * caller asked for is the unsafe direction.
 */
async function acceptedGrants(
  request: PluginAgentTurnRequest,
  source: { kind: "plugin" | "bot"; id?: string } | undefined
): Promise<AgentCapabilityGrantV1[] | undefined> {
  if (!request.capabilityGrants?.length) return undefined
  const { validateAgentCapabilityGrant } =
    await import("@cognia/agent-config-types/agent-capability-grant")
  return request.capabilityGrants.map((grant, index) => {
    const checked = validateAgentCapabilityGrant(grant)
    if (!checked.ok) {
      throw new PluginAgentTurnError(
        `runPluginAgentTurn: capabilityGrants[${index}] is invalid: ${checked.errors.join("; ")}`
      )
    }
    return source ? { ...checked.value, source } : checked.value
  })
}

export interface RunPluginAgentTurnOptions {
  /** Stable host operation identity; retries reuse its user row, not its wire turnId. */
  operationId?: string
  /**
   * Who is calling, stamped over every grant's self-declared source so the
   * audit trail names the real caller. Host-side callers (bots) pass their own.
   * A non-empty id is required to establish session ownership.
   */
  grantSource?: { kind: "plugin" | "bot"; id?: string }
  /** Host-owned conversation scope within the caller, such as a Bot installation id. */
  sessionKey?: string
  /** Host-derived IM authority, not connector ownership or a plugin-supplied binding. */
  platformBinding?: ChatSession["platformBinding"]
  /** Bot control-plane root; the executing turn inherits its event identity. */
  parentRunId?: string
  /** What a parked approval calls this turn ("Bot: Release notes"). */
  unattendedLabel?: string
  /**
   * Book this turn's spend in the usage ledger under the caller's identity.
   *
   * Without it the turn is booked only where the desktop chat runtime happens
   * to ingest the session's stream, as a `chat` row that names no provider, so
   * the spend misses the provider rollup and the cost-budget gate, and on the
   * always-on host it is not booked at all. With it the turn is claimed (the
   * chat runtime then skips it) and written here as a `plugin` row.
   */
  usage?: PluginAgentTurnUsageBooking
  /**
   * The origin the outbound policy (ADR-0239) plans this turn's outbound
   * calls in, for a caller that carries its own: a Bot passes its
   * installation's (`botPlanOrigin`). Default: the turn's session.
   */
  outboundOrigin?: import("@/lib/policy/action-review/plan-context").ActionReviewPlanOrigin
  /**
   * Recipient lists a person configured for the caller, which this turn's
   * outbound calls may reach unattended: a Bot passes its installation's
   * (`botRecipientGrants`).
   */
  outboundPolicyGrants?: readonly import("@/lib/policy/action-review/plan-context").OutboundPolicyGrantList[]
}

export interface PluginAgentTurnUsageBooking {
  /** Deterministic per-turn id. A replayed turn MUST reuse it. */
  operationId: string
  /** The grouping key the row rolls up under, e.g. `bot:<runId>`. */
  sessionId: string
  /** The caller's run, for per-run spend. */
  runId?: string
  /** The owning project, for per-workspace budgets. */
  projectId?: string
}

/**
 * The host's own grant for an unattended turn: an empty permission profile,
 * which resolves to the ceiling and which the caller's grants may only narrow.
 */
function unattendedGrant(source: { kind: "plugin" | "bot"; id?: string }): AgentCapabilityGrantV1 {
  return { schemaVersion: 1, source, permissionProfile: {} }
}

/**
 * Write the booked row for one turn. Never fails the turn: the ledger is a
 * mirror of spend that already happened, not a precondition of the reply.
 */
async function bookTurnUsage(
  booking: PluginAgentTurnUsageBooking,
  sendOptions: Pick<SendOptions, "model" | "provider" | "turnId">,
  usage: UsageInfo | undefined,
  costAuthority = false
): Promise<void> {
  if (!usage) return
  try {
    const [{ recordSurfaceUsage, surfaceUsageFromUsageInfo, externalAgentSurfaceUsage }, models] =
      await Promise.all([
        import("@/lib/db/session-usage"),
        import("@/lib/ai/agent/external/session/session-models"),
      ])
    const external = models.isExternalAgentProviderId(sendOptions.provider)
    await recordSurfaceUsage({
      surface: "plugin",
      operationId: booking.operationId,
      sessionId: booking.sessionId,
      usage: {
        ...(external
          ? externalAgentSurfaceUsage(usage)
          : surfaceUsageFromUsageInfo(usage, {
              costAuthority,
            })),
        ...(sendOptions.model ? { model: sendOptions.model } : {}),
        // An external agent's own provider is not a Cognia price list, so it
        // has no bucket in the provider rollup (as for interactive external turns).
        ...(sendOptions.provider && !external ? { providerId: sendOptions.provider } : {}),
        ...(sendOptions.turnId ? { turnId: sendOptions.turnId } : {}),
        ...(booking.runId ? { runId: booking.runId } : {}),
        ...(booking.projectId ? { projectId: booking.projectId } : {}),
      },
    })
  } catch (error) {
    console.warn("runPluginAgentTurn: usage booking failed", error)
  }
}

async function settleCompletedOperation(completion: AgentTurnOperationCompletion): Promise<void> {
  if (completion.executionRunId) await finishToolExecutionRun(completion.executionRunId)
  if (completion.usageBooking) {
    const saved = completion.usageBooking
    await bookTurnUsage(saved.booking, saved.sendOptions, saved.usage, saved.costAuthority)
  }
  if (completion.approvalRunId) {
    const [{ getExecutionRun }, { AgentRunEventProducer }] = await Promise.all([
      import("@/lib/db/execution-runs"),
      import("@/lib/execution/sources/agent-turn"),
    ])
    const run = await getExecutionRun(completion.approvalRunId)
    if (run && !["completed", "failed", "cancelled"].includes(run.status))
      await new AgentRunEventProducer(run.id).finish("completed", Date.now())
  }
}

export async function runPluginAgentTurn(
  request: PluginAgentTurnRequest,
  options: RunPluginAgentTurnOptions = {}
): Promise<PluginAgentTurnResult> {
  const prompt = request.prompt.trim()
  const cwd = request.cwd.trim()
  if (!prompt) throw new PluginAgentTurnError("runPluginAgentTurn requires a non-empty prompt")
  if (!cwd) throw new PluginAgentTurnError("runPluginAgentTurn requires an absolute cwd")
  const source = options.grantSource
  if (!source?.id?.trim()) {
    throw new PluginAgentTurnError("runPluginAgentTurn requires a host-attributed caller identity")
  }

  const [{ resolveCharacterById }, sessionsDb, { getSettings }, { resolveSendOptions }, runner] =
    await Promise.all([
      import("@/lib/db/characters"),
      import("@/lib/db/sessions"),
      import("@/lib/db/settings"),
      import("@/lib/claude/build-options"),
      import("@/lib/claude/run-and-capture"),
    ])

  const character = await resolveCharacterById(request.characterId)
  if (!character) {
    throw new PluginAgentTurnError(
      `runPluginAgentTurn: character "${request.characterId}" not found`
    )
  }

  const callerGrants = await acceptedGrants(request, options.grantSource)
  const capabilityGrants = [unattendedGrant(source), ...(callerGrants ?? [])]
  const owner = {
    kind: source.kind,
    id: source.id,
    ...(options.sessionKey ? { key: options.sessionKey } : {}),
  }
  const binding = options.platformBinding
  const identity = JSON.stringify([
    owner.kind,
    owner.id,
    owner.key ?? null,
    request.characterId,
    cwd,
    binding?.platform ?? null,
    binding?.adapterId ?? null,
    binding?.conversationKey ?? null,
  ])
  const creationId = `s_agent_turn_${await sha256Hex(identity)}`
  const runOwnedTurn = async () => {
    const operationId = options.operationId ?? options.usage?.operationId
    const completionId = operationId
      ? `agent-turn:${JSON.stringify([source.kind, source.id, owner.key ?? null, operationId])}`
      : undefined
    const requestFingerprint = await sha256Hex(
      JSON.stringify([
        prompt,
        cwd,
        request.characterId,
        request.permissionMode ?? null,
        request.composition ?? null,
        callerGrants ?? null,
        binding ?? null,
        request.sessionId?.trim() ?? null,
      ])
    )
    const transcriptCancellation = (message: string) =>
      Object.assign(new runner.RunAndCaptureError(message, "aborted"), {
        terminalCancellation: true as const,
      })
    let pendingOperation: AgentTurnOperationCompletion | undefined
    if (completionId) {
      const completed = (await getDb().sharedRunJournals.get(completionId))?.agentTurnOperation
      if (completed) {
        if (
          completed.version !== 1 ||
          completed.operationId !== operationId ||
          completed.requestFingerprint !== requestFingerprint
        )
          throw new PluginAgentTurnError("runPluginAgentTurn: operation prompt changed")
        if (completed.deleted || (!completed.result && !completed.userMessageId))
          throw transcriptCancellation("runPluginAgentTurn: operation transcript deleted")
        if (completed.result) {
          const rows = await getDb().messages.bulkGet([
            completed.userMessageId ?? "",
            ...(completed.replyMessageIds ?? []),
          ])
          if (
            !completed.transcriptDigest ||
            operationTranscriptDigest(rows, completed.sessionId) !== completed.transcriptDigest
          )
            throw transcriptCancellation("runPluginAgentTurn: operation transcript changed")
          await settleCompletedOperation(completed)
          return structuredClone(completed.result)
        }
        pendingOperation = completed
        const user = await getDb().messages.get(completed.userMessageId!)
        if (
          !user ||
          user.sessionId !== completed.sessionId ||
          user.metadata?.deletedAt !== undefined
        )
          throw transcriptCancellation("runPluginAgentTurn: operation transcript deleted")
      }
    }
    const sessionId = await withAgentTurnLock(`identity:${creationId}`, () =>
      ensureSession(
        request.characterId,
        cwd,
        owner,
        pendingOperation?.sessionId ?? request.sessionId?.trim(),
        binding,
        creationId,
        false
      )
    )
    return withSessionTurnLock<PluginAgentTurnResult>(sessionId, async () => {
      request.signal?.throwIfAborted()
      // Revalidate ownership and refresh authority/cwd only after the prior turn
      // has fully committed and finished its approval responder.
      await ensureSession(request.characterId, cwd, owner, sessionId, binding)
      const session = await sessionsDb.getSession(sessionId)
      const appSettings = await getSettings().catch(() => undefined)
      const sendOptions = await resolveSendOptions({
        session: session ?? null,
        character,
        appSettings: appSettings ?? null,
        ...(request.composition ? { compositionSelection: request.composition } : {}),
        capabilityGrants,
      })
      if (request.permissionMode) sendOptions.permissionMode = request.permissionMode

      // Nobody is watching this turn. A permission request is answered here,
      // by parking it for a person, rather than left to whichever shell-specific
      // listener happens to exist (desktop: silent auto-deny; headless: a
      // five-minute hang reported as a timeout).
      const origin = source.kind === "bot" ? "bot" : "plugin"
      const permissions = createUnattendedPermissionResponder(origin, {
        park: createUnattendedPark({
          origin,
          sessionId,
          label: options.unattendedLabel ?? `Plugin turn: ${character.name}`,
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      })
      // Claimed before the send: the desktop chat runtime ingests this session's
      // stream too, and must leave the turn to the row booked below.
      const booking = options.usage
      const usageTracker = booking ? trackCaptureUsage() : undefined
      sendOptions.turnId ??= crypto.randomUUID()
      const userMessageId = operationId
        ? `agent-turn:user:${JSON.stringify([source.kind, source.id, sessionId, operationId])}`
        : sendOptions.turnId
      if (booking) claimTurnUsage(sessionId, sendOptions.turnId)
      // Ordinary delta writes preserve history that this producer has not loaded.
      // Own transcript ingestion just as capture already owns permission responses.
      const releaseTranscript = registerCaptureResponder(sessionId, sendOptions.turnId, false, true)
      let entry: Awaited<ReturnType<typeof startToolExecutionRun>> | undefined
      const turnDb = getDb()
      let consumedGeneration = session?.runtimeTranscriptGeneration
      let consumedInvalidation = session?.runtimeTranscriptInvalidated
      // Set only when the engine actually receives this turn. Middleware may
      // answer without dispatch; the engine history then lacks this turn.
      let engineDispatched = false
      let latestResumeId: string | undefined
      let resumeWrites = Promise.resolve()
      const saveResumeId = (id: string) => {
        latestResumeId = id
        resumeWrites = resumeWrites.then(async () => {
          if (getDb() !== turnDb)
            throw new PluginAgentTurnError("runPluginAgentTurn: database changed")
          await turnDb.transaction("rw", turnDb.sessions, async () => {
            const current = await turnDb.sessions.get(sessionId)
            if (current && current.runtimeTranscriptGeneration === consumedGeneration)
              await sessionsDb.setSdkSessionId(sessionId, id)
          })
        })
        // Capture callbacks are observational; retain failures for the turn while
        // preventing an unhandled rejection before the engine finishes.
        void resumeWrites.catch(() => undefined)
        return resumeWrites
      }
      let result: Awaited<ReturnType<typeof runner.runAndCaptureAssistantReply>>
      let transcript: UIMessage[] = []
      let externalParts: UIMessage["parts"] = []
      let projectionError: unknown
      let replyCommitted = false
      let dispatchCancellation: InstanceType<typeof runner.RunAndCaptureError> | undefined
      // The logical user row must survive unchanged from write to commit. A clear,
      // delete, edit or move in between cancels the turn instead of reviving it.
      const userRowIntact = async () => {
        const user = await turnDb.messages.get(userMessageId)
        return Boolean(
          user &&
          user.sessionId === sessionId &&
          user.role === "user" &&
          user.metadata?.deletedAt === undefined &&
          JSON.stringify(user.parts) === JSON.stringify([{ type: "text", text: prompt }])
        )
      }
      const cancelForChangedUserRow = (stage: string) => {
        dispatchCancellation = transcriptCancellation(
          `runPluginAgentTurn: user message changed ${stage}`
        )
        return dispatchCancellation
      }
      try {
        const preparedUser = await prepareMessageDelta(sessionId, {
          upserts: [
            {
              id: userMessageId,
              role: "user",
              parts: [{ type: "text", text: prompt }],
              metadata: { createdAt: Date.now(), triggerWorkflows: false },
            },
          ],
        })
        let retry = false
        await turnDb.transaction(
          "rw",
          turnDb.messages,
          turnDb.messageMediaRefs,
          turnDb.sessions,
          turnDb.sharedRunJournals,
          async () => {
            const operation = completionId
              ? (await turnDb.sharedRunJournals.get(completionId))?.agentTurnOperation
              : undefined
            const previousUser = operationId ? await turnDb.messages.get(userMessageId) : undefined
            if (operation?.deleted || (operation && !(await userRowIntact())))
              throw cancelForChangedUserRow("before retry")
            if (previousUser) {
              if (
                previousUser.sessionId !== sessionId ||
                previousUser.role !== "user" ||
                JSON.stringify(previousUser.parts) !==
                  JSON.stringify([{ type: "text", text: prompt }])
              )
                throw new PluginAgentTurnError("runPluginAgentTurn: operation prompt changed")
              retry = true
            } else await commitMessageDelta(sessionId, preparedUser)
            if (completionId && operationId && !operation)
              await turnDb.sharedRunJournals.add({
                id: completionId,
                agentTurnOperation: {
                  version: 1,
                  operationId,
                  requestFingerprint,
                  sessionId,
                  userMessageId,
                },
              })
          }
        )
        if (retry) {
          // A failed attempt may retain its prompt inside either engine. Rebuild
          // from durable history, excluding the one logical user row below.
          await invalidateTranscriptRuntime(sessionId)
        }
        entry = await startToolExecutionRun(sessionId, {
          ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
          title: options.unattendedLabel ?? `Plugin turn: ${character.name}`,
        })
        result = await runner.runAndCaptureAssistantReply(sessionId, prompt, sendOptions, {
          currentMessageId: userMessageId,
          onSdkEvent: (event) => {
            try {
              transcript = applySdkEvent(transcript, event).messages
            } catch (error) {
              projectionError = error
            }
          },
          onExternalEvent: (event) => {
            try {
              externalParts = applyExternalAgentEventToParts(externalParts, event, { sessionId })
            } catch (error) {
              projectionError = error
            }
          },
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
          onPermissionRequest: permissions.onPermissionRequest,
          onSdkSessionId: saveResumeId,
          beforeSend: async () => {
            if (getDb() !== turnDb)
              throw new PluginAgentTurnError("runPluginAgentTurn: database changed")
            // Capture invokes this inside the transcript-runtime lock through
            // engine dispatch. Never adopt a post-clear generation for an old
            // in-memory prompt, including after retries or async middleware.
            await turnDb.transaction("r", turnDb.sessions, turnDb.messages, async () => {
              const sendingSession = await turnDb.sessions.get(sessionId)
              if (!sendingSession || !(await userRowIntact()))
                throw cancelForChangedUserRow("before send")
              consumedGeneration = sendingSession.runtimeTranscriptGeneration
              consumedInvalidation = sendingSession.runtimeTranscriptInvalidated
              engineDispatched = true
            })
          },
          pauseTimeoutWhileAwaitingPermission: true,
          outboundPolicy: {
            unattended: true,
            ...(options.outboundOrigin ? { origin: options.outboundOrigin } : {}),
            ...(options.outboundPolicyGrants?.length
              ? { policyGrants: options.outboundPolicyGrants }
              : {}),
          },
          ...(usageTracker ? { onEvent: usageTracker.observe } : {}),
        })
        if (projectionError) throw projectionError
        await resumeWrites
        // Rebuild the engine from the stored transcript next turn when its own
        // history no longer matches what is persisted.
        const engineHistoryStale = Boolean(result.textTransformed) || !engineDispatched
        const persistReply = async () => {
          const createdAt = Date.now()
          // Reuse the renderer's event converters. Text-only transports still have
          // a final-result fallback, without replacing captured tools or reasoning.
          if (!transcript.some((message) => message.role === "assistant"))
            transcript.push({
              id: result.messageId || crypto.randomUUID(),
              role: "assistant",
              parts: externalParts,
            })
          const lastAssistant = transcript.findLast((message) => message.role === "assistant")!
          const textIndex = lastAssistant.parts.findIndex((part) => part.type === "text")
          // The final middleware response is authoritative. Discard raw text across
          // assistant rounds on a transform/filter, retaining ordinary unmodified
          // multi-round transcripts, tool/media parts and non-prose surfaces.
          if (result.textTransformed)
            for (const message of transcript)
              if (message.role === "assistant")
                message.parts = message.parts.flatMap((part) => {
                  if (part.type === "text") return []
                  const extension = part as unknown as A2UIPart | SourcesPart
                  if (extension.type === "a2ui" && extension.source === "codeblock") return []
                  if (extension.type === "sources") {
                    const sources = extension.sources.filter(
                      (source) => source.origin !== "footnote" && source.origin !== "anthropic"
                    )
                    return sources.length
                      ? [{ ...extension, sources } as unknown as typeof part]
                      : []
                  }
                  return [part]
                })
          if (
            result.text.trim() &&
            (result.textTransformed ||
              !lastAssistant.parts.some(
                (part) =>
                  (part.type === "text" && part.text.trim()) ||
                  (part as unknown as A2UIPart).type === "a2ui"
              ))
          ) {
            const fallback = applySdkEvent([], {
              type: "assistant",
              uuid: lastAssistant.id,
              message: {
                id: lastAssistant.id,
                role: "assistant",
                content: [{ type: "text", text: result.text }],
              },
            } as Parameters<typeof applySdkEvent>[1]).messages
            const replacements = (fallback[0]?.parts ?? []).filter(
              (part) =>
                (part as unknown as A2UIPart).type !== "a2ui" ||
                !transcript.some((message) =>
                  message.parts.some(
                    (existing) =>
                      (existing as unknown as A2UIPart).type === "a2ui" &&
                      (existing as unknown as A2UIPart).surfaceId ===
                        (part as unknown as A2UIPart).surfaceId
                  )
                )
            )
            lastAssistant.parts.splice(
              textIndex < 0 ? lastAssistant.parts.length : textIndex,
              0,
              ...replacements
            )
          }
          for (const surfaceId of result.a2uiSurfaceOrder ?? []) {
            const surface = result.a2uiSurfaces[surfaceId]
            if (
              !surface ||
              transcript.some((message) =>
                message.parts.some(
                  (part) =>
                    (part as unknown as A2UIPart).type === "a2ui" &&
                    (part as unknown as A2UIPart).surfaceId === surfaceId
                )
              )
            )
              continue
            const { segmentToMessages } = await import("@/lib/a2ui/ai-generate")
            const part: A2UIPart = {
              type: "a2ui",
              surfaceId,
              source: "mcp-bridge",
              content: JSON.stringify(segmentToMessages(surfaceId, surface)),
            }
            lastAssistant.parts.push(part as unknown as UIMessage["parts"][number])
          }
          transcript = transcript.filter(
            (message) => message === lastAssistant || message.parts.length > 0
          )
          // Match capture's terminal rule after middleware: reasoning alone is not
          // a reply, but tools, media, surfaces, structured output and budget stops are.
          const hasContent = transcript.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some(
                (part) =>
                  (part.type === "text" && part.text.trim()) ||
                  (part.type === "file" &&
                    sdkMediaPart({ type: "file", url: part.url, media_type: part.mediaType }) !==
                      null) ||
                  (part as unknown as A2UIPart).type === "a2ui" ||
                  ((part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
                    "toolCallId" in part)
              )
          )
          if (
            !hasContent &&
            !Object.prototype.hasOwnProperty.call(result, "structuredOutput") &&
            result.resultSubtype !== "error_max_turns" &&
            result.resultSubtype !== "error_max_budget_usd"
          )
            throw new runner.RunAndCaptureError(
              `session ${sessionId} ended with no assistant text`,
              "no_assistant_text"
            )
          transcript = transcript.map((message, index) => ({
            ...message,
            metadata: {
              ...(message.metadata as Record<string, unknown>),
              createdAt: createdAt + index,
            },
          }))
          // Hash/decode/store media before acquiring the final transcript transaction.
          // The writer consumes these prepared parts without reopening asset stores.
          for (const message of transcript) bindPersonalMessageRun(message.id, entry?.id)
          const prepared = await prepareMessageDelta(sessionId, { upserts: transcript })
          if (getDb() !== turnDb)
            throw new PluginAgentTurnError("runPluginAgentTurn: database changed")
          await turnDb.transaction(
            "rw",
            turnDb.sessions,
            turnDb.messages,
            turnDb.messageMediaRefs,
            turnDb.sharedRunJournals,
            async () => {
              // Middleware can answer without dispatch, so beforeSend may never run.
              if (!(await userRowIntact())) throw cancelForChangedUserRow("before reply")
              const current = await turnDb.sessions.get(sessionId)
              if (!current || current.runtimeTranscriptGeneration !== consumedGeneration)
                throw new PluginAgentTurnError(
                  "runPluginAgentTurn: transcript changed; captured result discarded"
                )
              await commitMessageDelta(sessionId, prepared)
              if (completionId && operationId) {
                const replyMessageIds = transcript.map((message) => message.id)
                const transcriptDigest = operationTranscriptDigest(
                  await turnDb.messages.bulkGet([userMessageId, ...replyMessageIds]),
                  sessionId
                )
                const completion: AgentTurnOperationCompletion = {
                  version: 1,
                  operationId,
                  requestFingerprint,
                  sessionId,
                  userMessageId,
                  replyMessageIds,
                  ...(transcriptDigest ? { transcriptDigest } : {}),
                  executionRunId: entry?.id,
                  approvalRunId: permissions.runId(),
                  ...(booking
                    ? {
                        usageBooking: {
                          booking: { ...booking },
                          costAuthority:
                            sendOptions.execution?.runtimeAdapter === "claude-agent-sdk",
                          sendOptions: {
                            model: sendOptions.model,
                            provider: sendOptions.provider,
                            turnId: sendOptions.turnId,
                          },
                          usage: usageTracker?.resolve(result.usage),
                        },
                      }
                    : {}),
                  result: {
                    sessionId,
                    text: result.text,
                    ...(result.messageId ? { messageId: result.messageId } : {}),
                    status: permissions.needsApproval() ? "needs_approval" : "completed",
                    ...(permissions.needsApproval()
                      ? { needsApproval: [...permissions.denials] }
                      : {}),
                  },
                }
                await turnDb.sharedRunJournals.put({
                  id: completionId,
                  agentTurnOperation: completion,
                })
              }
              const resumeId = engineHistoryStale
                ? undefined
                : (result.sdkSessionId ?? latestResumeId)
              if (resumeId) await sessionsDb.setSdkSessionId(sessionId, resumeId)
              await stampSessionLastMessage(sessionId, {
                parts: lastAssistant.parts,
                createdAt: createdAt + transcript.length - 1,
              })
              if (!engineHistoryStale && consumedInvalidation)
                await acknowledgeTranscriptRuntime(sessionId, consumedInvalidation)
            }
          )
        }
        if (engineHistoryStale) {
          // The opaque engine history either still contains the raw response or,
          // when middleware answered without dispatch, lacks this turn. Close it
          // before committing the filtered projection, including empty refusals.
          // Keep hydration/destructive edits outside this entire interval.
          await withTranscriptRuntimeLock(sessionId, async () => {
            if (getDb() !== turnDb)
              throw new PluginAgentTurnError("runPluginAgentTurn: database changed")
            const current = await turnDb.sessions.get(sessionId)
            if (!current || current.runtimeTranscriptGeneration !== consumedGeneration)
              throw new PluginAgentTurnError(
                "runPluginAgentTurn: transcript changed; captured result discarded"
              )
            await invalidateTranscriptRuntime(sessionId)
            consumedGeneration = (await turnDb.sessions.get(sessionId))?.runtimeTranscriptGeneration
            await persistReply()
          })
        } else await persistReply()
        replyCommitted = true
        await finishToolExecutionRun(entry.id)
      } catch (error) {
        await resumeWrites.catch(() => undefined)
        // Transport preparation can fail on the vanished row before beforeSend.
        if (
          !dispatchCancellation &&
          !replyCommitted &&
          getDb() === turnDb &&
          !(await userRowIntact().catch(() => true))
        )
          cancelForChangedUserRow("during dispatch")
        const cancelled = request.signal?.aborted || !!dispatchCancellation
        // The engine already holds this prompt (and any partial reply) that the
        // canonical transcript will not; the next operation rebuilds from rows.
        if (engineDispatched && !replyCommitted && getDb() === turnDb) {
          try {
            await withTranscriptRuntimeLock(sessionId, async () => {
              if (getDb() !== turnDb) return
              await invalidateTranscriptRuntime(sessionId).catch((invalidation) =>
                console.warn("runPluginAgentTurn: engine runtime close failed", invalidation)
              )
              // Durable on the turn's own database even when closing the live
              // runtime failed (or the helper resolved another account mid-way,
              // which at worst forces a redundant rebuild there): the next send
              // drops the resume identity and rebuilds from stored rows.
              await turnDb.transaction("rw", turnDb.sessions, async () => {
                const current = await turnDb.sessions.get(sessionId)
                if (!current || current.runtimeTranscriptInvalidated) return
                const generation = crypto.randomUUID()
                await turnDb.sessions.update(sessionId, {
                  runtimeTranscriptInvalidated: generation,
                  runtimeTranscriptGeneration: generation,
                })
              })
            })
          } catch (cleanup) {
            console.warn("runPluginAgentTurn: engine context invalidation failed", cleanup)
          }
        }
        if (entry && !replyCommitted)
          await finishToolExecutionRun(entry.id, cancelled ? "cancelled" : true)
        // A turn that failed or was cancelled still paid for the calls it made.
        if (booking)
          await bookTurnUsage(
            booking,
            sendOptions,
            usageTracker?.resolve(),
            sendOptions.execution?.runtimeAdapter === "claude-agent-sdk"
          )
        if (!replyCommitted) await permissions.finish(cancelled ? "cancelled" : "failed")
        // Transports may wrap beforeSend errors as send_failed. Preserve the
        // cancellation established at the locked logical-message boundary.
        throw dispatchCancellation ?? error
      } finally {
        releaseTranscript()
      }
      if (booking)
        await bookTurnUsage(
          booking,
          sendOptions,
          usageTracker?.resolve(result.usage),
          sendOptions.execution?.runtimeAdapter === "claude-agent-sdk"
        )
      await permissions.finish("completed")

      return {
        sessionId,
        text: result.text,
        ...(result.messageId ? { messageId: result.messageId } : {}),
        status: permissions.needsApproval() ? "needs_approval" : "completed",
        ...(permissions.needsApproval() ? { needsApproval: [...permissions.denials] } : {}),
      }
    })
  }
  const operationId = options.operationId ?? options.usage?.operationId
  const completionId = operationId
    ? `agent-turn:${JSON.stringify([source.kind, source.id, owner.key ?? null, operationId])}`
    : undefined
  return completionId
    ? withAgentTurnLock(`operation:${completionId}`, runOwnedTurn)
    : runOwnedTurn()
}
