/**
 * File-backed persistence for the CLI's Logto sessions (ADR-0059
 * cloud/headless — Logto). The standalone `cognia-agent` process has no OS
 * keyring, so — like `~/.cognia/credentials.json` — each session lives in a
 * 0600 file. All filesystem effects go through an injectable
 * {@link LogtoSessionFs} so the store unit-tests without real disk.
 *
 * # One sign-in per local account (ADR-0149 §9)
 *
 * A local account (`../config/local-account.ts`) is the CLI's LocalProfile,
 * and as on the desktop each holds its own session:
 *
 *     <home>/accounts/<id>/logto.json        the session
 *     <home>/accounts/<id>/logto-login.json  the newest sign-in in flight
 *     <home>/accounts/<id>/person.json       the person the account acts for
 *
 * The account binds to a person on its first sign-in. A later sign-in as
 * anyone else is refused unless the caller asks to rebind, and signing out
 * removes the tokens but keeps the binding, so the next sign-in as the same
 * person needs nothing more. Two Hosts that share a home therefore never
 * share a person, and one account never quietly starts acting for someone
 * else.
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

import { readLogtoAccessClaims, readLogtoProfileClaims } from "@/lib/identity/logto-claims"

import { createCliFileLock } from "../plugin/file-lock"
import {
  accountIdFromDirName,
  accountSignInDir,
  localAccountsRoot,
  type AccountSignInDir,
} from "./local-account"

const MODE_0600 = 0o600

/** The lock every writer of an account's sign-in files takes. */
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
  /** Names of the directories directly inside `dir`; empty when it does not exist. */
  listDirs(dir: string): string[]
  /**
   * Run `task` holding the lock every `cognia-agent` process takes before it
   * writes or removes this account's sign-in, so a check and the write that
   * depends on it are one step. Absent: an in-process lock, which is enough
   * for a store that only one process can see (tests).
   */
  lock?: <T>(dir: AccountSignInDir, task: () => Promise<T>) => Promise<T>
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
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  },
  listDirs: (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
  },
  // Rooted in the account's own directory: one account's sign-in never waits on another's.
  lock: (dir, task) => createCliFileLock(dir)(SESSION_LOCK_NAME, task, SESSION_LOCK_CATEGORY),
}

/** Serializes tasks per account within this process, for stores without a `lock`. */
const inProcessLocks = new Map<string, Promise<unknown>>()

function inProcessLock<T>(dir: AccountSignInDir, task: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(dir) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  inProcessLocks.set(dir, settled)
  void settled.then(() => {
    if (inProcessLocks.get(dir) === settled) inProcessLocks.delete(dir)
  })
  return run
}

function withSessionLock<T>(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs,
  task: () => Promise<T>
): Promise<T> {
  return (fsImpl.lock ?? inProcessLock)(dir, task)
}

/** The account's Logto session file. */
export function logtoSessionPath(dir: AccountSignInDir): string {
  return path.join(dir, "logto.json")
}

/** Where the account's newest `logto login` in flight records itself. */
export function logtoLoginAttemptPath(dir: AccountSignInDir): string {
  return path.join(dir, "logto-login.json")
}

/** The person the account acts for; kept when the account signs out. */
export function logtoBoundPersonPath(dir: AccountSignInDir): string {
  return path.join(dir, "person.json")
}

/**
 * Persist (upsert) the CLI Logto session with 0600 perms. A bare write: the
 * commands go through {@link completeLogtoLogin} and the refresh path, which
 * hold the session lock.
 */
export function writeLogtoSessionFile(
  dir: AccountSignInDir,
  session: LogtoSession,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): void {
  fsImpl.mkdirp(dir)
  fsImpl.write(logtoSessionPath(dir), JSON.stringify(session, null, 2), MODE_0600)
}

function parseSession(raw: string | null): LogtoSession | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as LogtoSession
  } catch {
    return null
  }
}

/** Load the account's Logto session, or `null` if absent / corrupt. */
export function readLogtoSessionFile(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): LogtoSession | null {
  return parseSession(fsImpl.read(logtoSessionPath(dir)))
}

/**
 * The stored session as one opaque value, for a writer that must act only if
 * nothing replaced it meanwhile ({@link removeLogtoSessionFileIf}).
 */
export function readLogtoSessionSnapshot(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): { raw: string; session: LogtoSession } | null {
  const raw = fsImpl.read(logtoSessionPath(dir))
  const session = parseSession(raw)
  return raw && session ? { raw, session } : null
}

/** Remove the account's session file unconditionally; the binding stays. Idempotent. */
export function removeLogtoSessionFile(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): void {
  fsImpl.remove(logtoSessionPath(dir))
}

/**
 * Remove the session only if it is still the one `snapshot` read. A sign-in
 * that landed while a sign-out was revoking the old tokens is the newer
 * intent and stays. Returns whether the file was removed.
 */
export function removeLogtoSessionFileIf(
  dir: AccountSignInDir,
  snapshot: { raw: string },
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<boolean> {
  return withSessionLock(dir, fsImpl, async () => {
    if (fsImpl.read(logtoSessionPath(dir)) !== snapshot.raw) return false
    fsImpl.remove(logtoSessionPath(dir))
    return true
  })
}

function readAttempt(dir: AccountSignInDir, fsImpl: LogtoSessionFs): string | null {
  const raw = fsImpl.read(logtoLoginAttemptPath(dir))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { attempt?: unknown }
    return typeof parsed.attempt === "string" ? parsed.attempt : null
  } catch {
    return null
  }
}

/** Whether a sign-in for this account is waiting on its browser round trip. */
export function logtoLoginInFlight(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): boolean {
  return readAttempt(dir, fsImpl) !== null
}

/**
 * The person an account acts for (ADR-0149 §9): who signed in to it first,
 * or whom it was explicitly rebound to since. Identity is the issuer and the
 * access token's subject; the rest is for messages.
 */
export interface BoundPerson {
  issuer: string
  subject: string
  /** The token's `sub` when it is already a Cognia person id (`usr_…`). */
  userId?: string
  organizationId?: string
  displayName?: string
  email?: string
  /** Epoch ms of the sign-in that bound (or rebound) the account. */
  boundAt: number
}

function trimIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "")
}

/** True when both name the same person at the same deployment. */
export function samePerson(
  a: Pick<BoundPerson, "issuer" | "subject">,
  b: Pick<BoundPerson, "issuer" | "subject">
): boolean {
  return a.subject === b.subject && trimIssuer(a.issuer) === trimIssuer(b.issuer)
}

/** The person a session signs in as, or null when its access token has no readable subject. */
export function personOfSession(session: LogtoSession, boundAt: number): BoundPerson | null {
  const access = readLogtoAccessClaims(session.accessToken)
  if (!access?.subject) return null
  const profile = readLogtoProfileClaims(session.idToken)
  return {
    issuer: trimIssuer(session.issuer),
    subject: access.subject,
    ...(access.subject.startsWith("usr_") ? { userId: access.subject } : {}),
    ...(access.organizationId ? { organizationId: access.organizationId } : {}),
    ...(profile.name ? { displayName: profile.name } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    boundAt,
  }
}

/** How a message names a person: "Ann <ann@example.com> (usr_…)", whatever of it is known. */
export function describePerson(person: Pick<BoundPerson, "subject" | "displayName" | "email">) {
  const label = person.displayName ?? person.email
  const email = person.displayName && person.email ? ` <${person.email}>` : ""
  return label ? `${label}${email} (${person.subject})` : person.subject
}

function parseBoundPerson(raw: string | null): BoundPerson | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const value = parsed as Record<string, unknown>
  if (
    typeof value.issuer !== "string" ||
    !value.issuer ||
    typeof value.subject !== "string" ||
    !value.subject ||
    typeof value.boundAt !== "number"
  ) {
    return null
  }
  const optional = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string) : undefined
  const person: BoundPerson = {
    issuer: value.issuer,
    subject: value.subject,
    boundAt: value.boundAt,
  }
  for (const key of ["userId", "organizationId", "displayName", "email"] as const) {
    const field = optional(key)
    if (field) person[key] = field
  }
  return person
}

/**
 * The person this account is bound to, or null when it never signed in.
 *
 * A file that exists but cannot be read is an error, not "unbound": treating
 * it as unbound would let the next sign-in as anyone bind the account afresh.
 */
export function readBoundPerson(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): BoundPerson | null {
  const raw = fsImpl.read(logtoBoundPersonPath(dir))
  if (raw === null) return null
  const person = parseBoundPerson(raw)
  if (!person) {
    throw new Error(
      `${logtoBoundPersonPath(dir)} is not a readable binding; restore it, or remove it to let ` +
        "the next sign-in bind this account again"
    )
  }
  return person
}

function writeBoundPerson(dir: AccountSignInDir, person: BoundPerson, fsImpl: LogtoSessionFs) {
  fsImpl.mkdirp(dir)
  fsImpl.write(logtoBoundPersonPath(dir), JSON.stringify(person, null, 2), MODE_0600)
}

/**
 * Record a new `logto login` as the newest one. Only the newest attempt may
 * save its session: an earlier browser round trip that finishes later must
 * not replace what the person signed in as last.
 */
export function beginLogtoLogin(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs,
  newId: () => string = randomUUID
): Promise<string> {
  const attempt = newId()
  return withSessionLock(dir, fsImpl, async () => {
    fsImpl.mkdirp(dir)
    fsImpl.write(
      logtoLoginAttemptPath(dir),
      JSON.stringify({ attempt, startedAt: Date.now() }),
      MODE_0600
    )
    return attempt
  })
}

export type LogtoLoginCompletion =
  /** Saved. `bound`: first sign-in; `same`: the bound person again; `rebound`: taken over. */
  | {
      kind: "saved"
      binding: "bound" | "same" | "rebound"
      person: BoundPerson
      /** Whom the account acted for before a `rebound`. */
      previous?: BoundPerson
    }
  /** A later `logto login` started, or a `logto logout` ran, after this one began. */
  | { kind: "superseded" }
  /** Signed in as someone other than the account's person, without asking to rebind. */
  | { kind: "mismatch"; bound: BoundPerson; incoming: BoundPerson }
  /** The access token names nobody, so there is no person to bind the account to. */
  | { kind: "no-person" }

export interface CompleteLogtoLoginOptions {
  /** Let a different person take the account over (`logto login --rebind`). */
  rebind?: boolean
  now?: () => number
}

/**
 * Save `session` for the account if `attempt` is still its newest sign-in and
 * the session's person may act for it. Nothing is written unless the result
 * is `saved`; every outcome but `superseded` settles the attempt.
 */
export function completeLogtoLogin(
  dir: AccountSignInDir,
  attempt: string,
  session: LogtoSession,
  fsImpl: LogtoSessionFs = realLogtoSessionFs,
  options: CompleteLogtoLoginOptions = {}
): Promise<LogtoLoginCompletion> {
  return withSessionLock(dir, fsImpl, async () => {
    if (readAttempt(dir, fsImpl) !== attempt) return { kind: "superseded" }
    const settle = () => fsImpl.remove(logtoLoginAttemptPath(dir))
    const incoming = personOfSession(session, (options.now ?? Date.now)())
    if (!incoming) {
      settle()
      return { kind: "no-person" }
    }
    const bound = readBoundPerson(dir, fsImpl)
    if (bound && samePerson(bound, incoming)) {
      writeLogtoSessionFile(dir, session, fsImpl)
      // Names and emails change; the person and the moment they bound do not.
      writeBoundPerson(dir, { ...incoming, boundAt: bound.boundAt }, fsImpl)
      settle()
      return { kind: "saved", binding: "same", person: { ...incoming, boundAt: bound.boundAt } }
    }
    if (bound && !options.rebind) {
      settle()
      return { kind: "mismatch", bound, incoming }
    }
    writeBoundPerson(dir, incoming, fsImpl)
    writeLogtoSessionFile(dir, session, fsImpl)
    settle()
    return bound
      ? { kind: "saved", binding: "rebound", person: incoming, previous: bound }
      : { kind: "saved", binding: "bound", person: incoming }
  })
}

/** A failed or cancelled sign-in withdraws its marker, unless a newer one replaced it. */
export function abandonLogtoLogin(
  dir: AccountSignInDir,
  attempt: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<void> {
  return withSessionLock(dir, fsImpl, async () => {
    if (readAttempt(dir, fsImpl) === attempt) fsImpl.remove(logtoLoginAttemptPath(dir))
  })
}

/** A sign-out supersedes every sign-in to the account that started before it. */
export function cancelLogtoLogins(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): Promise<void> {
  return withSessionLock(dir, fsImpl, async () => {
    fsImpl.remove(logtoLoginAttemptPath(dir))
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
 * The account's session with an access token good right now: refreshed (and
 * written back) when it is about to expire, or null when there is none.
 *
 * The refresh runs under the account's lock and decides on the session it
 * reads there, not the one read before waiting. Every `cognia-agent` process
 * acting for the account (the Brain, its readers, a command in another
 * terminal) may want a refresh at the same moment; presenting one refresh
 * token twice would let a stale result overwrite a newer sign-in, bring back a
 * session that was signed out, or delete a rotated session when the second use
 * is refused.
 */
export async function freshLogtoSessionFile(
  dir: AccountSignInDir,
  deps: FreshLogtoSessionDeps = {}
): Promise<LogtoSession | null> {
  const fsImpl = deps.sessionFs ?? realLogtoSessionFs
  const now = deps.now ?? Date.now
  const session = readLogtoSessionFile(dir, fsImpl)
  if (!session) return null
  if (!needsRefresh(session, now)) return session
  return withSessionLock(dir, fsImpl, async () => {
    const current = readLogtoSessionFile(dir, fsImpl)
    // Signed out, signed in again or refreshed by another process meanwhile.
    if (!current) return null
    if (!needsRefresh(current, now)) return current
    try {
      const refreshed = await (deps.refreshToken ?? refreshLogtoToken)(
        refreshConfigFor(current),
        current.refreshToken!,
        deps.fetchImpl
      )
      writeLogtoSessionFile(dir, refreshed, fsImpl)
      return refreshed
    } catch (error) {
      // A refused refresh is a dead login: keeping the file would make every
      // later call present the same spent token and read every 401 as a server
      // fault. A transient failure keeps the file, because the next call may
      // succeed, but hands out no token now: the stored one has expired.
      if (isLogtoRefreshError(error) && error.permanent) removeLogtoSessionFile(dir, fsImpl)
      return null
    }
  })
}

/**
 * The person a long-running process acts for: the account's bound person,
 * read until there is one and then fixed for the life of the process.
 *
 * A `logto login --rebind` while the Brain runs takes effect at its next
 * start. Until then every token the Brain is handed must still be the pinned
 * person's, so the account never changes hands in the middle of a run. An
 * unreadable binding pins nobody, and the caller says so at start.
 */
export function pinBoundPerson(
  dir: AccountSignInDir,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): () => BoundPerson | null {
  let pinned: BoundPerson | null = null
  return () => {
    if (pinned) return pinned
    try {
      pinned = readBoundPerson(dir, fsImpl)
    } catch {
      return null
    }
    return pinned
  }
}

/**
 * The account's fresh session ({@link freshLogtoSessionFile}), but only while
 * it signs in as `person`. Anything else (signed out, signed in as somebody
 * else since, an unreadable token) is null: the caller acts for nobody rather
 * than for the wrong person.
 */
export async function freshSessionFor(
  dir: AccountSignInDir,
  person: Pick<BoundPerson, "issuer" | "subject">,
  deps: FreshLogtoSessionDeps = {}
): Promise<LogtoSession | null> {
  const session = await freshLogtoSessionFile(dir, deps)
  if (!session) return null
  const current = personOfSession(session, 0)
  return current && samePerson(current, person) ? session : null
}

/** One local account that has a sign-in directory under the home. */
export interface AccountSignInEntry {
  accountId: string
  dir: AccountSignInDir
  session: LogtoSession | null
  /** Null when unbound; an unreadable binding is reported, not hidden. */
  person: BoundPerson | null
  personError?: string
  loginInFlight: boolean
}

/** What is stored for one account. Nothing is refreshed. */
export function readAccountSignIn(
  dir: AccountSignInDir,
  accountId: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): AccountSignInEntry {
  let person: BoundPerson | null = null
  let personError: string | undefined
  try {
    person = readBoundPerson(dir, fsImpl)
  } catch (error) {
    personError = error instanceof Error ? error.message : String(error)
  }
  return {
    accountId,
    dir,
    session: readLogtoSessionFile(dir, fsImpl),
    person,
    ...(personError ? { personError } : {}),
    loginInFlight: logtoLoginInFlight(dir, fsImpl),
  }
}

/** Every local account with a sign-in directory, sorted by id. Nothing is refreshed. */
export function listAccountSignIns(
  home: string,
  fsImpl: LogtoSessionFs = realLogtoSessionFs
): AccountSignInEntry[] {
  const entries: AccountSignInEntry[] = []
  for (const name of fsImpl.listDirs(localAccountsRoot(home))) {
    const accountId = accountIdFromDirName(name)
    if (accountId !== null)
      entries.push(readAccountSignIn(accountSignInDir(home, accountId), accountId, fsImpl))
  }
  return entries.sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0
  )
}
