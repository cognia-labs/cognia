interface ExposableSession {
  kind?: string
  visibility?: string
}

export type SessionExposureChannel =
  | "main-list"
  | "global-search"
  | "plugin-enumeration"
  | "external-connector"
  | "authenticated-project-sync"
  | "standard-export"
  | "resource-export"

/**
 * The channels an embedded session may still ride on. Never a LISTING channel —
 * that is what "embedded" means — only the machine-to-machine ones where the
 * session's absence would break a reference the payload itself carries.
 */
const EMBEDDED_ALLOWED_CHANNELS = new Set<SessionExposureChannel>([
  "authenticated-project-sync",
  "resource-export",
])

/**
 * Imported subagent inner transcripts (ADR-0062) additionally ride along in a
 * full backup.
 *
 * They were previously excluded from EVERY channel, unconditionally — which
 * made a backup self-inconsistent: the parent turn IS exported, and its
 * `SubagentPart.nestedSessionId` points at the inner transcript, so after a
 * restore the "Open transcript" button navigated to a session that no longer
 * existed. The same hole applied to cross-device sync. They stay out of the
 * list, search, plugin enumeration, and connector surfaces exactly as before —
 * the drill-in from a parent turn remains the only way to reach one.
 */
const SUBAGENT_ALLOWED_CHANNELS = new Set<SessionExposureChannel>([
  ...EMBEDDED_ALLOWED_CHANNELS,
  "standard-export",
])

export function isEmbeddedSession(session: ExposableSession): boolean {
  return (
    session.visibility === "embedded" ||
    session.kind === "resource-workbench" ||
    session.kind === "workflow-editor" ||
    session.kind === "agent-builder" ||
    session.kind === "subagent"
  )
}

export function isSessionExposed(
  session: ExposableSession,
  channel: SessionExposureChannel
): boolean {
  if (!isEmbeddedSession(session)) return true
  if (session.kind === "subagent") return SUBAGENT_ALLOWED_CHANNELS.has(channel)
  return EMBEDDED_ALLOWED_CHANNELS.has(channel)
}

export function filterExposedSessions<T extends ExposableSession>(
  sessions: readonly T[],
  channel: SessionExposureChannel
): T[] {
  return sessions.filter((session) => isSessionExposed(session, channel))
}

/**
 * User-facing discovery only: expand an ALREADY eligible global-search result
 * with its session-bound side chats. Apply archive, workspace and personal
 * history eligibility to the parents before calling; missing parents stay closed.
 * Never use this for headless-context, project-history-tool, main-list, plugins,
 * connectors, exports or sync: their existing exposure channels do not widen.
 */
export function withScopedAsides<
  T extends ExposableSession & {
    id: string
    platformBinding?: unknown
    surfaceBinding?: { kind: string; sessionId?: string }
  },
>(exposed: readonly T[], all: readonly T[]): T[] {
  const parents = filterExposedSessions(exposed, "global-search")
  const parentIds = new Set(parents.filter((s) => !s.platformBinding).map((s) => s.id))
  const existing = new Set(parents.map((s) => s.id))
  return [
    ...parents,
    ...all.filter(
      (s) =>
        !existing.has(s.id) &&
        s.kind === "resource-workbench" &&
        s.surfaceBinding?.kind === "session" &&
        parentIds.has(s.surfaceBinding.sessionId ?? "")
    ),
  ]
}
