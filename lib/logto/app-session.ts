/**
 * Desktop/web app-session layer for Logto (ADR-0059 cloud/headless, Logto).
 *
 * Assembles the runtime-agnostic client ({@link ./client}) with the OS-keyring
 * store ({@link ./session-store}) into the actions the app drives: interactive
 * sign-in, resolve-the-active-session (with lazy refresh), and sign-out. This
 * is the app (Tauri/web keyring) counterpart to the standalone CLI's
 * file-backed session (`cli/src/config/logto-session.ts`). Same client,
 * different persistence, because the `cognia-agent` process has no OS keyring.
 *
 * # An expired token is never "active"
 *
 * `getActiveLogtoSession` used to surface a stale session when the refresh
 * failed, so a caller could not tell "refresh the token later" from "this
 * login is dead". Worse, both looked exactly like a healthy session. The
 * resolution is now a discriminated union ({@link LogtoSessionResolution}):
 * `active` is the only state that carries a token, a refused refresh becomes a
 * `reauth-required` marker with the tokens cleared, and an unreachable issuer
 * is `offline` with the material kept for the next attempt.
 *
 * # One refresh at a time
 *
 * The issuer rotates the refresh token on use, so two refreshes with the same
 * token race: the first wins and the second is refused. Callers ask for a
 * token concurrently (account sync's push, pull and poller, other tabs), so
 * refreshes are serialized per profile: one in flight per tab, and a Web Lock
 * across tabs. Short auth commits use another lock and a durable revision,
 * so logout and newer logins can invalidate an in-flight issuer request.
 *
 * Every effect is injectable so the orchestration unit-tests without a real
 * browser round-trip, network, or keyring.
 */

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { withLogtoSessionLock } from "./session-lock"

import { discoverLogtoEndpoints } from "./discovery"
import {
  buildLogtoEndSessionUrl,
  isLogtoRefreshError,
  loginToLogto,
  refreshConfigFor,
  refreshLogtoToken,
  revokeLogtoToken,
  toLogtoSessionMetadata,
  type LogtoClientConfig,
  type LogtoDrivers,
  type LogtoRevocationOutcome,
  type LogtoSession,
  type LogtoSessionMetadata,
} from "./client"
import {
  clearLogtoReauthMarker,
  commitLogtoAuthState,
  supportsAtomicLogtoAuthCommit,
  type LogtoAuthMutation,
  clearLogtoSession,
  loadLogtoAuthRevision,
  loadLogtoReauthMarker,
  loadLogtoSession,
  markLogtoSessionForReauth,
  saveLogtoSession,
  saveLogtoAuthRevision,
  type LogtoReauthMarker,
} from "./session-store"

/** Refresh this far ahead of the actual expiry so a request never races it. */
export const REFRESH_SKEW_MS = 60_000

/** Fence local identity side effects to the auth commit that authorized them. */
export interface LogtoAuthCommitContext {
  assertCurrent: () => void
  /** Exact persisted revision; supplied only by production native atomic storage. */
  authRevision?: string
}

export interface LogtoAppSessionDeps {
  /** Defaults to the profile this runtime is serving. */
  localAccountId?: string
  login?: typeof loginToLogto
  refresh?: typeof refreshLogtoToken
  revoke?: typeof revokeLogtoToken
  discover?: typeof discoverLogtoEndpoints
  load?: typeof loadLogtoSession
  save?: typeof saveLogtoSession
  clear?: typeof clearLogtoSession
  loadReauth?: typeof loadLogtoReauthMarker
  markReauth?: typeof markLogtoSessionForReauth
  clearReauth?: typeof clearLogtoReauthMarker
  /** Validate profile ownership before a candidate session is persisted. */
  beforeCommit?: (candidate: LogtoSession) => Promise<void>
  /** Publish local identity only after credential persistence succeeds. */
  afterCommit?: (candidate: LogtoSession, context: LogtoAuthCommitContext) => Promise<void>
  /** Finish local identity deactivation while the logout commit is still exclusive. */
  afterClear?: (context: LogtoAuthCommitContext) => Promise<void>
  loadRevision?: typeof loadLogtoAuthRevision
  saveRevision?: typeof saveLogtoAuthRevision
  fetchImpl?: typeof fetch
  now?: () => number
  /** Serializes refreshes and auth commits across tabs; defaults to `navigator.locks`. */
  locks?: Pick<LockManager, "request"> | null
}

/**
 * What the keyring holds for one profile, after any refresh it needed.
 *
 * - `none`: nothing stored. Nobody has signed in here.
 * - `active`: a token that is good right now. The only state with one.
 * - `reauth-required`: the refresh was refused. Tokens are gone, metadata stays.
 * - `offline`: the issuer could not be reached. Tokens are KEPT so the next
 *   attempt can refresh. The caller gets no token because presenting an
 *   expired one is pointless.
 * - `error`: the issuer answered but not usefully (a misconfigured client, a
 *   malformed response). Material kept, state surfaced, nothing pretends to
 *   be signed in.
 */
export type LogtoSessionResolution =
  | { status: "none" }
  | { status: "active"; session: LogtoSession }
  | { status: "reauth-required"; reason: "expired" | "revoked"; metadata: LogtoSessionMetadata }
  | { status: "offline"; metadata: LogtoSessionMetadata }
  | { status: "error"; reason: string; metadata: LogtoSessionMetadata }

/** Run PKCE, validate profile ownership, then persist only a current candidate. */
export async function signInToLogto(
  config: LogtoClientConfig,
  drivers: LogtoDrivers,
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  deps = { ...deps, localAccountId }
  const login = deps.login ?? loginToLogto
  const attempt = await withAuthLock(localAccountId, deps, (assertHeld) =>
    advanceAttempt(deps, assertHeld)
  )
  const session = await login(config, drivers)
  await withAuthLock(localAccountId, deps, async (assertHeld) => {
    if ((await readAuthState(deps)).attempt !== attempt)
      throw new LogtoAuthOperationSupersededError()
    await deps.beforeCommit?.(session)
    assertHeld()
    const context = await commitMutation(deps, { kind: "session", session }, assertHeld)
    assertHeld()
    await deps.afterCommit?.(session, context)
  })
  return session
}

export class LogtoAuthOperationSupersededError extends Error {
  constructor() {
    super("The authentication operation was superseded by a newer sign-in or sign-out.")
    this.name = "LogtoAuthOperationSupersededError"
  }
}

/** Update an existing session without racing a newer login, logout or refresh. */
export async function updateLogtoSession(
  previous: LogtoSession,
  update: () => Promise<LogtoSession>,
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  deps = { ...deps, localAccountId }
  const load = deps.load ?? loadLogtoSession
  const revision = await withAuthLock(localAccountId, deps, async () => {
    if (!sameStoredSession(await load(localAccountId), previous)) {
      throw new LogtoAuthOperationSupersededError()
    }
    return readRevision(deps)
  })
  const candidate = await update()
  await withAuthLock(localAccountId, deps, async (assertHeld) => {
    if (
      (await readRevision(deps)) !== revision ||
      !sameStoredSession(await load(localAccountId), previous)
    ) {
      throw new LogtoAuthOperationSupersededError()
    }
    await deps.beforeCommit?.(candidate)
    assertHeld()
    const context = await commitMutation(deps, { kind: "session", session: candidate }, assertHeld)
    assertHeld()
    await deps.afterCommit?.(candidate, context)
  })
  return candidate
}

/**
 * The platform transport rather than bare `fetch`: the desktop routes it
 * through the configured proxy, and the issuer would otherwise be the one
 * host every other call honours the proxy for and this one does not.
 */
function issuerFetch(deps: LogtoAppSessionDeps): typeof fetch {
  return deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
}

function isStale(session: LogtoSession, now: number): boolean {
  return session.expiresAt != null && session.expiresAt - now <= REFRESH_SKEW_MS
}

/**
 * Resolve this profile's session, refreshing when the access token has expired
 * (or is within {@link REFRESH_SKEW_MS} of expiring) and a refresh token exists.
 *
 * A refused refresh (`invalid_grant`) clears the tokens and leaves a marker.
 * A transient failure keeps everything and reports `offline`. Either way the
 * caller never receives a token that has stopped working.
 */
export async function resolveLogtoSession(
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSessionResolution> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  deps = { ...deps, localAccountId }
  const load = deps.load ?? loadLogtoSession
  const loadReauth = deps.loadReauth ?? loadLogtoReauthMarker
  const refresh = deps.refresh ?? refreshLogtoToken
  const now = deps.now ?? Date.now

  const stored = async (): Promise<LogtoSessionResolution | LogtoSession> => {
    const session = await load(deps.localAccountId)
    if (!session) {
      const marker = await loadReauth(deps.localAccountId)
      if (marker) {
        return { status: "reauth-required", reason: marker.reason, metadata: marker.metadata }
      }
      return { status: "none" }
    }
    if (!isStale(session, now())) return { status: "active", session }
    return session
  }

  const first = await stored()
  if (!isStaleSession(first)) return first

  const key = localAccountId
  const pending = refreshesInFlight.get(key)
  if (pending) return pending
  const run = withRefreshLock(key, deps, async () => {
    // Another caller (or tab) may have refreshed while this one waited.
    const start = await withAuthLock(key, deps, async () => {
      const session = await stored()
      return isStaleSession(session)
        ? { kind: "refresh" as const, session, revision: await readRevision(deps) }
        : { kind: "resolved" as const, resolved: session }
    })
    if (start.kind === "resolved") return start.resolved
    return refreshStale(start.session, start.revision)
  }).finally(() => {
    if (refreshesInFlight.get(key) === run) refreshesInFlight.delete(key)
  })
  refreshesInFlight.set(key, run)
  return run

  async function currentResolution(): Promise<LogtoSessionResolution> {
    const latest = await stored()
    return isStaleSession(latest)
      ? {
          status: "error",
          reason: "Authentication changed while refreshing.",
          metadata: toLogtoSessionMetadata(latest),
        }
      : latest
  }

  async function stillCurrent(session: LogtoSession, revision: string | null): Promise<boolean> {
    if ((await readRevision(deps)) !== revision) return false
    const latest = await load(localAccountId)
    return sameStoredSession(latest, session)
  }

  async function refreshStale(
    session: LogtoSession,
    revision: string | null
  ): Promise<LogtoSessionResolution> {
    const metadata = toLogtoSessionMetadata(session)
    if (!session.refreshToken) {
      // Nothing to refresh with. The token is past its expiry and the only way
      // forward is a new interactive sign-in, so say so and drop the token. It
      // is not a credential any more, only a liability.
      const marker: LogtoReauthMarker = { reason: "expired", metadata, at: now() }
      return withAuthLock(key, deps, async (assertHeld) => {
        if (!(await stillCurrent(session, revision))) return currentResolution()
        assertHeld()
        await commitMutation(deps, { kind: "reauth", marker }, assertHeld)
        return { status: "reauth-required", reason: "expired", metadata }
      })
    }
    let refreshed: LogtoSession
    try {
      refreshed = await refresh(refreshConfigFor(session), session.refreshToken, issuerFetch(deps))
    } catch (error) {
      return withAuthLock(key, deps, async (assertHeld) => {
        if (!(await stillCurrent(session, revision))) return currentResolution()
        assertHeld()
        return refreshFailed(session, metadata, error, assertHeld)
      })
    }
    return withAuthLock(key, deps, async (assertHeld) => {
      if (!(await stillCurrent(session, revision))) return currentResolution()
      assertHeld()
      await commitMutation(deps, { kind: "session", session: refreshed }, assertHeld)
      return { status: "active", session: refreshed }
    })
  }

  async function refreshFailed(
    session: LogtoSession,
    metadata: LogtoSessionMetadata,
    error: unknown,
    assertHeld: () => void
  ): Promise<LogtoSessionResolution> {
    if (isLogtoRefreshError(error)) {
      if (error.permanent) {
        // The revision/session comparison above already excluded a newer login
        // or another tab's rotated token before marking this session dead.
        const marker: LogtoReauthMarker = { reason: error.reauthReason, metadata, at: now() }
        await commitMutation(deps, { kind: "reauth", marker }, assertHeld)
        return { status: "reauth-required", reason: marker.reason, metadata }
      }
      if (error.transient) return { status: "offline", metadata }
      return { status: "error", reason: error.message, metadata }
    }
    // An injected `refresh` that throws something untyped is still not a
    // reason to invent a revocation: keep the material, surface the failure.
    return {
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
      metadata,
    }
  }
}

/** Refreshes in flight in this tab, by profile. */
const refreshesInFlight = new Map<string, Promise<LogtoSessionResolution>>()
const authCommits = new Map<string, Promise<unknown>>()
const injectedRevisions = new Map<string, string>()

function usesInjectedStorage(deps: LogtoAppSessionDeps): boolean {
  return !!(
    (deps.load && deps.load !== loadLogtoSession) ||
    (deps.save && deps.save !== saveLogtoSession) ||
    (deps.clear && deps.clear !== clearLogtoSession) ||
    (deps.markReauth && deps.markReauth !== markLogtoSessionForReauth) ||
    (deps.clearReauth && deps.clearReauth !== clearLogtoReauthMarker)
  )
}

function loadRevisionValue(deps: LogtoAppSessionDeps): Promise<string | null> {
  if (deps.loadRevision) return deps.loadRevision(deps.localAccountId)
  if (usesInjectedStorage(deps))
    return Promise.resolve(injectedRevisions.get(deps.localAccountId!) ?? null)
  return loadLogtoAuthRevision(deps.localAccountId)
}

interface AuthRevisionState {
  session: string | null
  attempt: string | null
}

function parseAuthState(raw: string | null): AuthRevisionState {
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed &&
        typeof parsed === "object" &&
        "session" in parsed &&
        "attempt" in parsed &&
        (parsed.session === null || typeof parsed.session === "string") &&
        (parsed.attempt === null || typeof parsed.attempt === "string")
      ) {
        return { session: parsed.session, attempt: parsed.attempt }
      }
    } catch {
      /* Existing single-revision records remain valid session fences. */
    }
  }
  return { session: raw, attempt: null }
}

async function readAuthState(deps: LogtoAppSessionDeps): Promise<AuthRevisionState> {
  return parseAuthState(await loadRevisionValue(deps))
}

function usesAtomicStorage(deps: LogtoAppSessionDeps): boolean {
  return (
    !usesInjectedStorage(deps) &&
    !deps.loadRevision &&
    !deps.saveRevision &&
    supportsAtomicLogtoAuthCommit()
  )
}

async function writeAuthState(
  deps: LogtoAppSessionDeps,
  state: AuthRevisionState,
  expected: string | null
): Promise<void> {
  const value = JSON.stringify(state)
  if (usesAtomicStorage(deps))
    await commitLogtoAuthState(expected, value, undefined, deps.localAccountId)
  else if (deps.saveRevision) await deps.saveRevision(value, deps.localAccountId)
  else if (usesInjectedStorage(deps)) injectedRevisions.set(deps.localAccountId!, value)
  else await saveLogtoAuthRevision(value, deps.localAccountId)
}

async function readRevision(deps: LogtoAppSessionDeps): Promise<string | null> {
  return (await readAuthState(deps)).session
}

async function advanceAttempt(deps: LogtoAppSessionDeps, assertHeld: () => void): Promise<string> {
  const attempt = crypto.randomUUID()
  const raw = await loadRevisionValue(deps)
  const state = parseAuthState(raw)
  assertHeld()
  await writeAuthState(deps, { ...state, attempt }, raw)
  assertHeld()
  return attempt
}

async function advanceRevision(deps: LogtoAppSessionDeps, assertHeld: () => void): Promise<string> {
  const revision = crypto.randomUUID()
  const raw = await loadRevisionValue(deps)
  const state = parseAuthState(raw)
  assertHeld()
  await writeAuthState(deps, { ...state, session: revision }, raw)
  return revision
}

/** The native batch is the last fence for already-issued IPC writes. */
async function commitMutation(
  deps: LogtoAppSessionDeps,
  mutation: LogtoAuthMutation,
  assertHeld: () => void
): Promise<LogtoAuthCommitContext> {
  if (usesAtomicStorage(deps)) {
    const raw = await loadRevisionValue(deps)
    assertHeld()
    const next = { ...parseAuthState(raw), session: crypto.randomUUID() }
    if (mutation.kind === "clear") next.attempt = crypto.randomUUID()
    const authRevision = JSON.stringify(next)
    await commitLogtoAuthState(raw, authRevision, mutation, deps.localAccountId)
    assertHeld()
    return { assertCurrent: assertHeld, authRevision }
  }
  if (mutation.kind === "clear") {
    const raw = await loadRevisionValue(deps)
    assertHeld()
    await writeAuthState(deps, { session: crypto.randomUUID(), attempt: crypto.randomUUID() }, raw)
    assertHeld()
    await (deps.clear ?? clearLogtoSession)(deps.localAccountId)
    assertHeld()
    await (deps.clearReauth ?? clearLogtoReauthMarker)(deps.localAccountId)
  } else {
    if (mutation.kind === "session")
      await (deps.save ?? saveLogtoSession)(mutation.session, deps.localAccountId)
    else await (deps.markReauth ?? markLogtoSessionForReauth)(mutation.marker, deps.localAccountId)
    assertHeld()
    await advanceRevision(deps, assertHeld)
  }
  assertHeld()
  return { assertCurrent: assertHeld }
}

function sameStoredSession(left: LogtoSession | null, right: LogtoSession): boolean {
  return (
    !!left &&
    left.issuer === right.issuer &&
    left.clientId === right.clientId &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.resource === right.resource &&
    left.organizationId === right.organizationId
  )
}

function withAuthLock<T>(
  key: string,
  deps: LogtoAppSessionDeps,
  task: (assertHeld: () => void) => Promise<T>
): Promise<T> {
  const previous = authCommits.get(key) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => withWebLock(`cognia-logto-auth:${key}`, deps, task))
  authCommits.set(key, run)
  return run.finally(() => {
    if (authCommits.get(key) === run) authCommits.delete(key)
  })
}

function isStaleSession(value: LogtoSessionResolution | LogtoSession): value is LogtoSession {
  return !("status" in value)
}

function withRefreshLock<T>(
  key: string,
  deps: LogtoAppSessionDeps,
  task: () => Promise<T>
): Promise<T> {
  return withWebLock(`cognia-logto-refresh:${key}`, deps, task)
}

function withWebLock<T>(
  name: string,
  deps: LogtoAppSessionDeps,
  task: (assertHeld: () => void) => Promise<T>
): Promise<T> {
  return withLogtoSessionLock(name, task, {
    locks: deps.locks,
    allowInProcess: usesInjectedStorage(deps),
  })
}

/**
 * The active session, or `null` for every state that has no usable token.
 *
 * Kept for callers that only need a token. The states behind `null` are
 * distinguished by {@link resolveLogtoSession}, and a UI should call that
 * instead so it can name them.
 */
export async function getActiveLogtoSession(
  deps: LogtoAppSessionDeps = {}
): Promise<LogtoSession | null> {
  const resolved = await resolveLogtoSession(deps)
  return resolved.status === "active" ? resolved.session : null
}

/**
 * A token that is good right now, or `null`.
 *
 * The one call the collaboration plane, its outbound queue and its runtime
 * client should make. Reading the keyring directly hands them whatever is
 * stored, expired or not, and a request made with an expired token is a 401
 * that looks exactly like a revoked login.
 */
export async function readActiveAccessToken(
  localAccountId?: string,
  deps: Omit<LogtoAppSessionDeps, "localAccountId"> = {}
): Promise<string | null> {
  const session = await getActiveLogtoSession({ ...deps, localAccountId })
  return session?.accessToken ?? null
}

export interface LogtoSignOutOptions {
  /**
   * Revoke the refresh (and access) token at the issuer before clearing them.
   * On by default: a sign-out that only forgets a token locally leaves it live
   * at the issuer for the rest of its lifetime.
   */
  revoke?: boolean
  /** Where the issuer may send the browser after ending its own session. */
  postLogoutRedirectUri?: string
}

export interface LogtoSignOutReport {
  /** Whether there was a session to sign out of. */
  hadSession: boolean
  /** Local material is always cleared, whatever the issuer said. */
  cleared: true
  refreshTokenRevocation: LogtoRevocationOutcome | null
  accessTokenRevocation: LogtoRevocationOutcome | null
  /**
   * The issuer's RP-initiated logout URL, when it advertises one. Opening it
   * ends the issuer's browser cookie, which revocation does not.
   */
  endSessionUrl: string | null
}

/** True when the issuer may still consider a token live after this sign-out. */
export function signOutLeftTokensLive(report: LogtoSignOutReport): boolean {
  if (!report.hadSession) return false
  return [report.refreshTokenRevocation, report.accessTokenRevocation].some(
    (outcome) => outcome?.status === "failed"
  )
}

/**
 * Sign out: revoke at the issuer (best effort, reported), then drop the
 * session and any re-authentication marker from the keyring.
 *
 * Local clearing and identity deactivation finish before issuer work. A delayed
 * revocation cannot erase a newer login, and a failed local delete propagates
 * instead of reporting a successful sign-out.
 */
export async function signOutFromLogto(
  deps: LogtoAppSessionDeps = {},
  options: LogtoSignOutOptions = {}
): Promise<LogtoSignOutReport> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  deps = { ...deps, localAccountId }
  const load = deps.load ?? loadLogtoSession
  const revoke = deps.revoke ?? revokeLogtoToken
  const discover = deps.discover ?? discoverLogtoEndpoints
  const shouldRevoke = options.revoke ?? true

  const session = await withAuthLock(localAccountId, deps, async (assertHeld) => {
    const current = await load(localAccountId)
    assertHeld()
    const context = await commitMutation(deps, { kind: "clear" }, assertHeld)
    assertHeld()
    await deps.afterClear?.(context)
    return current
  })
  let refreshTokenRevocation: LogtoRevocationOutcome | null = null
  let accessTokenRevocation: LogtoRevocationOutcome | null = null
  let endSessionUrl: string | null = null

  if (session) {
    const fetchImpl = issuerFetch(deps)
    if (shouldRevoke) {
      if (session.refreshToken) {
        refreshTokenRevocation = await revoke(
          session,
          session.refreshToken,
          "refresh_token",
          fetchImpl
        )
      }
      accessTokenRevocation = await revoke(session, session.accessToken, "access_token", fetchImpl)
    }
    try {
      const endpoints = await discover(session.issuer, fetchImpl)
      endSessionUrl = buildLogtoEndSessionUrl(endpoints, {
        clientId: session.clientId,
        ...(session.idToken ? { idToken: session.idToken } : {}),
        ...(options.postLogoutRedirectUri
          ? { postLogoutRedirectUri: options.postLogoutRedirectUri }
          : {}),
      })
    } catch {
      // No discovery, no logout URL. The revocation above already said
      // whether the issuer could be reached, so this is not a second failure.
      endSessionUrl = null
    }
  }

  return {
    hadSession: Boolean(session),
    cleared: true,
    refreshTokenRevocation,
    accessTokenRevocation,
    endSessionUrl,
  }
}
