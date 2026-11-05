/**
 * A member's turns after the Host restarted under them (ADR-0253 §7).
 *
 * The Host tells each person brain when it booted (`COGNIA_HOST_BOOTED_AT`).
 * A turn this partition accepted before then belonged to the previous Host
 * process, which took the brain, the agent and every lease with it. HostState
 * recovery asks this module which turns those are, whether the organization
 * wants them retried (`resumeAfterRestart` in its agent policy, else the
 * operator's default), and how to end or retry each one.
 *
 * Retrying is at-least-once: a tool effect the first attempt already had may
 * happen again. The transcript says so first, with a notice placed right after
 * the member's message, so whoever reads the retried reply reads it below the
 * warning.
 */

import type { UIMessage } from "ai"

import type { SessionNoticePartData } from "@/lib/claude/adapter"
import { commitMessageDelta } from "@/lib/db/messages"
import { getDb } from "@/lib/db/schema"
import type { HostRestartRecovery } from "@/lib/sync/host-state-service"
import {
  failHostStateTurnAfterRestart,
  listHostStateTurnsInterruptedBefore,
  permitHostStateRedispatchAfterRestart,
  revokeHostStateRedispatchPermit,
  type InterruptedHostStateTurn,
} from "@/lib/work-submission/host-adapter"

import { personHostBootedAt } from "./person-chat"

export interface PersonHostRestartDeps {
  bootedAt?: number | null
  /** Whether the organization retries interrupted turns; read from the Host's policy. */
  resumeEnabled?: () => Promise<boolean>
  listInterrupted?: typeof listHostStateTurnsInterruptedBefore
  fail?: typeof failHostStateTurnAfterRestart
  writeNotice?: (sessionId: string, message: UIMessage) => Promise<void>
  /** When the member's message was written, so the notice can follow it. */
  messageCreatedAt?: (sessionId: string, messageId: string) => Promise<number | undefined>
}

/** The id of the notice that says `actionId` is being retried. */
export function hostRestartNoticeId(actionId: string): string {
  return `notice-host-restarted-${actionId}`
}

/**
 * The notice a retried turn gets: a session-notice marker, which renders as a
 * divider and is no part of the history an agent is sent.
 */
export function hostRestartNotice(actionId: string, createdAt?: number): UIMessage {
  const part: SessionNoticePartData = { type: "session-notice", variant: "host-restarted" }
  return {
    id: hostRestartNoticeId(actionId),
    role: "system",
    parts: [part as unknown as UIMessage["parts"][number]],
    ...(createdAt !== undefined ? { metadata: { createdAt } } : {}),
  }
}

async function readResumeAfterRestart(): Promise<boolean> {
  const [{ fetchPersonAgentPolicy }, { transport }] = await Promise.all([
    import("./person-agent/policy"),
    import("@/lib/tauri/transport-instance"),
  ])
  return (await fetchPersonAgentPolicy(transport)).resumeAfterRestart === true
}

async function storedMessageCreatedAt(
  sessionId: string,
  messageId: string
): Promise<number | undefined> {
  const row = await getDb().messages.get(messageId)
  return row?.sessionId === sessionId ? row.createdAt : undefined
}

/**
 * The recovery a member's HostState service runs with, or `undefined` when
 * this brain was not told when its Host booted (outside a member's partition,
 * or under an older Host): then recovery is what it always was.
 */
export function createPersonHostRestartRecovery(
  deps: PersonHostRestartDeps = {}
): HostRestartRecovery | undefined {
  const bootedAt = deps.bootedAt === undefined ? personHostBootedAt() : deps.bootedAt
  if (bootedAt === null) return undefined
  const list = deps.listInterrupted ?? listHostStateTurnsInterruptedBefore
  const fail = deps.fail ?? failHostStateTurnAfterRestart
  const writeNotice =
    deps.writeNotice ??
    (async (sessionId: string, message: UIMessage) => {
      await commitMessageDelta(sessionId, { upserts: [message] })
    })
  const createdAtOf = deps.messageCreatedAt ?? storedMessageCreatedAt
  // Read once per recovery: every interrupted turn is ended or retried under
  // the same answer.
  let resume: Promise<boolean> | null = null
  return {
    bootedAt,
    interruptedTurns: (sessionId) => list(sessionId, bootedAt),
    resumeEnabled: () => (resume ??= (deps.resumeEnabled ?? readResumeAfterRestart)()),
    fail: async (turn: InterruptedHostStateTurn) => {
      await fail(turn.submissionId)
    },
    markRetry: async (turn: InterruptedHostStateTurn) => {
      // Right after the member's message, so the retried reply (which may
      // reuse the first attempt's row) reads below the notice.
      const after = turn.messageId ? await createdAtOf(turn.sessionId, turn.messageId) : undefined
      await writeNotice(
        turn.sessionId,
        hostRestartNotice(turn.actionId, after === undefined ? undefined : after + 1)
      )
    },
    permit: permitHostStateRedispatchAfterRestart,
    revoke: revokeHostStateRedispatchPermit,
  }
}
