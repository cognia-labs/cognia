/**
 * File-backed persistence for the CLI's active Logto session
 * (ADR-0059 cloud/headless — Logto). The standalone `cognia-agent` process has
 * no OS keyring, so — like `~/.cognia/credentials.json` — the session lives in
 * `~/.cognia/logto.json` with 0600 perms. All filesystem effects go through an
 * injectable {@link LogtoSessionFs} so the store unit-tests without real disk.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
  isLogtoRefreshError,
  refreshConfigFor,
  refreshLogtoToken,
  type LogtoSession,
} from "@/lib/logto/client"

import { createCliFileLock } from "../plugin/file-lock"

const MODE_0600 = 0o600

/** The lock every writer of `logto.json` and `logto-login.json` takes. */
const SESSION_LOCK_NAME = "logto-session"
/**
 * `lineage` because a refresh holds the lock across the issuer round trip:
 * that category waits long enough for one and releases its short guard
 * while the task awaits the network.
 */
const SESSION_LOCK_CATEGORY = "lineage"

export interface LogtoSessionFs {
  read(absPath: string): string | null
  write(absPath: string, content: string, mode: number): void
  remove(absPath: string): void
  mkdirp(dir: string): void
  /**
   * Run `task` holding the lock every `cognia-agent` process on this home
   * takes before it writes or removes the session, so a check and the write
   * that depends on it are one step. Absent: an in-process lock, which is
   * enough for a store that only one process can see (tests).
   */
  lock?: <T>(home: string, task: () => Promise<T>) => Promise<T>
}

/** Real-fs implementation (mirrors `realCredentialsFs`). */
export const realLogtoSessionFs: LogtoSessionFs = {
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  write: (p, content, mode) => {
    fs.writeFileSync(p, content, { mode })
    try {
      fs.chmodSync(p, mode)
    } catch {
      // Best-effort — Windows ignores chmod.
    }
  },
  remove: (p) => {
    try {
      fs.unlinkSync(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  },
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true })
  },
  lock: (home, task) => createCliFileLock(home)(SESSION_LOCK_NAME, task, SESSION_LOCK_CATEGORY),
}

/** Serializes tasks per home within this process, for stores without a `lock`. */
const inProcessLocks = new Map<string, Promise<unknown>>()

function inProcessLock<T>(home: string, task: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(home) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  inProcessLocks.set(home, settled)
  void settled.then(() => {
    if (inProcessLocks.get(home) === settled) inProcessLocks.delete(home)
  })
  return run
}

function withSessionLock<T>(
  home: string,
  fsImpl: LogtoSessionFs,
  task: () => Promise<T>
): Promise<T> {
  return (fsImpl.lock ?? inProcessLock)(home, task)
}

/** Absolute path of the CLI's Logto session file inside the cognia home dir. */
export function logtoSessionPath(home: string): string {
  return path.join(home, "logto.json")
}

/** Where the newest `logto login` in flight records itself. */
export function logtoLoginAttemptPath(home: string): string {
  return path.join(home, "logto-login.json")
}

/**
 * Persist (upsert) the CLI Logto session with 0600 perms. A bare write: the
 * commands go through {@link completeLogtoLogin} and the refresh path, which
 * hold the session lock.
 */
export function writeLogtoSessionFile(
  home: string,
  session: LogtoSession,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): void {
  fsImpl.mkdirp(home)
  fsImpl.write(logtoSessionPath(home), JSON.stringify(session, null, 2), MODE_0600)
}

function parseSession(raw: string | null): LogtoSession | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as LogtoSession
  } catch {
    return null
  }
}

/** Load the active CLI Logto session, or `null` if absent / corrupt. */
export function readLogtoSessionFile(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): LogtoSession | null {
  return parseSession(fsImpl.read(logtoSessionPath(home)))
}

/**
 * The stored session as one opaque value, for a writer that must act only if
 * nothing replaced it meanwhile ({@link removeLogtoSessionFileIf}).
 */
export function readLogtoSessionSnapshot(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): { raw: string; session: LogtoSession } | null {
  const raw = fsImpl.read(logtoSessionPath(home))
  const session = parseSession(raw)
  return raw && session ? { raw, session } : null
}

/** Remove the CLI Logto session file unconditionally. Idempotent. */
export function removeLogtoSessionFile(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): void {
  fsImpl.remove(logtoSessionPath(home))
}

/**
 * Remove the session only if it is still the one `snapshot` read. A sign-in
 * that landed while a sign-out was revoking the old tokens is the newer
 * intent and stays. Returns whether the file was removed.
 */
export function removeLogtoSessionFileIf(
  home: string,
  snapshot: { raw: string },
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<boolean> {
  return withSessionLock(home, fsImpl, async () => {
    if (fsImpl.read(logtoSessionPath(home)) !== snapshot.raw) return false
    fsImpl.remove(logtoSessionPath(home))
    return true
  })
}

function readAttempt(home: string, fsImpl: LogtoSessionFs): string | null {
  const raw = fsImpl.read(logtoLoginAttemptPath(home))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { attempt?: unknown }
    return typeof parsed.attempt === "string" ? parsed.attempt : null
  } catch {
    return null
  }
}

/**
 * Record a new `logto login` as the newest one. Only the newest attempt may
 * save its session: an earlier browser round trip that finishes later must
 * not replace what the person signed in as last.
 */
export function beginLogtoLogin(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs,
  newId: () => string = randomUUID
): Promise<string> {
  const attempt = newId()
  return withSessionLock(home, fsImpl, async () => {
    fsImpl.mkdirp(home)
    fsImpl.write(
      logtoLoginAttemptPath(home),
      JSON.stringify({ attempt, startedAt: Date.now() }),
      MODE_0600
    )
    return attempt
  })
}

export type LogtoLoginCompletion = "saved" | "superseded"

/**
 * Save `session` if `attempt` is still the newest sign-in; `superseded` when
 * a later `logto login` started or a `logto logout` ran after it began.
 */
export function completeLogtoLogin(
  home: string,
  attempt: string,
  session: LogtoSession,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<LogtoLoginCompletion> {
  return withSessionLock(home, fsImpl, async () => {
    if (readAttempt(home, fsImpl) !== attempt) return "superseded"
    writeLogtoSessionFile(home, session, fsImpl)
    fsImpl.remove(logtoLoginAttemptPath(home))
    return "saved"
  })
}

/** A failed or cancelled sign-in withdraws its marker, unless a newer one replaced it. */
export function abandonLogtoLogin(
  home: string,
  attempt: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<void> {
  return withSessionLock(home, fsImpl, async () => {
    if (readAttempt(home, fsImpl) === attempt) fsImpl.remove(logtoLoginAttemptPath(home))
  })
}

/** A sign-out supersedes every sign-in that started before it. */
export function cancelLogtoLogins(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<void> {
  return withSessionLock(home, fsImpl, async () => {
    fsImpl.remove(logtoLoginAttemptPath(home))
  })
}

/** Refresh this long before the access token expires. */
export const LOGTO_TOKEN_REFRESH_SKEW_MS = 60_000

export interface FreshLogtoSessionDeps {
  sessionFs?: LogtoSessionFs
  fetchImpl?: typeof fetch
  refreshToken?: typeof refreshLogtoToken
  now?: () => number
}

function needsRefresh(session: LogtoSession, now: () => number): boolean {
  return (
    session.expiresAt !== undefined &&
    session.expiresAt - now() <= LOGTO_TOKEN_REFRESH_SKEW_MS &&
    Boolean(session.refreshToken)
  )
}

/**
 * The CLI's session with an access token good right now: refreshed (and
 * written back) when it is about to expire, or null when there is none.
 *
 * The refresh runs under the session lock and decides on the session it reads
 * there, not the one read before waiting. Every `cognia-agent` process on a
 * home (the Brain, its readers, a command in another terminal) may want a
 * refresh at the same moment; presenting one refresh token twice would let a
 * stale result overwrite a newer sign-in, bring back a session that was
 * signed out, or delete a rotated session when the second use is refused.
 */
export async function freshLogtoSessionFile(
  home: string,
  deps: FreshLogtoSessionDeps = {}
): Promise<LogtoSession | null> {
  const fsImpl = deps.sessionFs ?? realLogtoSessionFs
  const now = deps.now ?? Date.now
  const session = readLogtoSessionFile(home, fsImpl)
  if (!session) return null
  if (!needsRefresh(session, now)) return session
  return withSessionLock(home, fsImpl, async () => {
    const current = readLogtoSessionFile(home, fsImpl)
    // Signed out, signed in again or refreshed by another process meanwhile.
    if (!current) return null
    if (!needsRefresh(current, now)) return current
    try {
      const refreshed = await (deps.refreshToken ?? refreshLogtoToken)(
        refreshConfigFor(current),
        current.refreshToken!,
        deps.fetchImpl
      )
      writeLogtoSessionFile(home, refreshed, fsImpl)
      return refreshed
    } catch (error) {
      // A refused refresh is a dead login: keeping the file would make every
      // later call present the same spent token and read every 401 as a server
      // fault. A transient failure keeps the file, because the next call may
      // succeed, but hands out no token now: the stored one has expired.
      if (isLogtoRefreshError(error) && error.permanent) removeLogtoSessionFile(home, fsImpl)
      return null
    }
  })
}
