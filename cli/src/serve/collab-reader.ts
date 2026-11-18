/** Read-only collaboration-plane activation for the headless Brain. */

import path from "node:path"

import { CollabClient, type CollabFetch } from "@/lib/collab/client"
import { saveCollabConnection } from "@/lib/collab/connection"
import { requestCollabRefresh } from "@/lib/collab/refresh-scheduler"
import { ALL_COLLAB_REFRESH_LEGS, refreshCollabPlaneQuietly } from "@/lib/collab/refresh"
import type { HeadlessCollabAdapter } from "@/lib/headless/runtimes/collab-runtime"
import { isOfficialIssuer, officialDeployment } from "@/lib/identity/official-deployment"
import { UserBindingRegistry, type BindUserInput } from "@/lib/identity/user-binding"
import { refreshLogtoToken, type LogtoSession } from "@/lib/logto/client"

import type { CollabCliConfig } from "../config/schema"
import { accountSignInDir, type AccountSignInDir } from "../config/local-account"
import {
  describePerson,
  freshSessionFor,
  samePerson,
  type BoundPerson,
  type LogtoSessionFs,
} from "../config/logto-session"
import { realSessionStoreFs, type SessionStoreFs } from "../agent/session-store/paths"

export interface HeadlessCollabReaderDeps {
  sessionFs?: LogtoSessionFs
  fetchImpl?: CollabFetch
  refreshToken?: typeof refreshLogtoToken
  registry?: UserBindingRegistry
  now?: () => number
  cursorFs?: Pick<SessionStoreFs, "readFile" | "writeFileAtomic">
}

function freshSession(
  dir: AccountSignInDir,
  person: BoundPerson,
  deps: HeadlessCollabReaderDeps
): Promise<LogtoSession | null> {
  return freshSessionFor(dir, person, {
    sessionFs: deps.sessionFs,
    fetchImpl: deps.fetchImpl as typeof fetch | undefined,
    refreshToken: deps.refreshToken,
    now: deps.now,
  })
}

export interface HeadlessCollabReader {
  status: "active" | "not-signed-in"
  runtime?: HeadlessCollabAdapter
  /** Whom this profile acted for before the account was rebound, when it just was. */
  rebound?: { from: string; to: string }
  stop(): void
}

function collabCursorFile(cliHome: string, localAccountId: string): string {
  return path.join(cliHome, "collab-notifications", `${encodeURIComponent(localAccountId)}.json`)
}

/**
 * Forget the account's read cursors. They mark one person's feed: after the
 * account is rebound they would skip or acknowledge the next person's.
 */
export function clearCollabCursors(
  cliHome: string,
  localAccountId: string,
  fsImpl: NonNullable<HeadlessCollabReaderDeps["cursorFs"]> = realSessionStoreFs
): void {
  fsImpl.writeFileAtomic(collabCursorFile(cliHome, localAccountId), JSON.stringify({}))
}

/** Synchronous cursor updates, persisted atomically outside ephemeral Web Storage. */
export function createCollabCursorStorage(
  cliHome: string,
  localAccountId: string,
  fsImpl: NonNullable<HeadlessCollabReaderDeps["cursorFs"]> = realSessionStoreFs
): HeadlessCollabAdapter["local"] {
  const file = collabCursorFile(cliHome, localAccountId)
  const read = (): Record<string, string> => {
    const raw = fsImpl.readFile(file)
    if (!raw) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {}
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== "string")
    ) {
      return {}
    }
    return parsed as Record<string, string>
  }
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) =>
      fsImpl.writeFileAtomic(file, JSON.stringify({ ...read(), [key]: value })),
    removeItem: (key) => {
      const current = read()
      delete current[key]
      fsImpl.writeFileAtomic(file, JSON.stringify(current))
    },
  }
}

/** How a binding row names its person, for the rebind line `serve` prints. */
function describeRow(row: { userId: string; displayName?: string; email?: string }): string {
  return describePerson({ subject: row.userId, displayName: row.displayName, email: row.email })
}

/**
 * Bind the Brain profile to the server-owned identity and pull once. The
 * registered collab runtimes own subsequent feed, notification and poll work.
 * It intentionally installs no outbound runner: Brain is a reader, never an
 * autonomous collaboration actor.
 *
 * The profile acts for the person its local account is bound to, pinned when
 * the Brain started (`pinBoundPerson`). A sign-in as somebody else in another
 * terminal is refused by `logto login` itself; and even a session that names
 * someone else is never exchanged for a grant, never reconciles this
 * profile's user id, and never acknowledges its notifications. The reader
 * goes quiet until the pinned person signs in again.
 *
 * The registry row follows the account's binding: when `logto login --rebind`
 * handed the account to someone else while the Brain was down, the row is
 * rebound here and the old person's read cursors are cleared.
 */
export async function startHeadlessCollabReader(input: {
  localAccountId: string
  cliHome: string
  config: CollabCliConfig
  /** The person this Brain acts for, pinned at start. */
  person: () => BoundPerson | null
  env?: Record<string, string | undefined>
  deps?: HeadlessCollabReaderDeps
}): Promise<HeadlessCollabReader> {
  const deps = input.deps ?? {}
  const person = input.person()
  const dir = accountSignInDir(input.cliHome, input.localAccountId)
  if (!person || !(await freshSession(dir, person, deps))) {
    return { status: "not-signed-in", stop: () => undefined }
  }

  /** The current session, only while it is still the person this profile is bound to. */
  const boundSession = (): Promise<LogtoSession | null> => freshSession(dir, person, deps)
  const accessToken = async (): Promise<string | null> =>
    (await boundSession())?.accessToken ?? null
  const fetchImpl = deps.fetchImpl ?? fetch
  const client = new CollabClient({
    baseUrl: input.config.url,
    accessToken,
    fetchImpl,
    ...(deps.now ? { now: deps.now } : {}),
  })
  let identity: Awaited<ReturnType<CollabClient["identity"]>>
  try {
    identity = await client.identity(input.config.orgId)
  } catch (cause) {
    const env = input.env ?? {}
    const official = officialDeployment({
      issuer: env.COGNIA_ID_ISSUER,
      audience: env.COGNIA_ID_AUDIENCE,
    })
    if (official && isOfficialIssuer(person.issuer, official)) {
      throw new Error(
        `account ${input.localAccountId} is signed in to the Cognia account, which the ` +
          `collaboration server at ${input.config.url} does not accept; sign the account in to ` +
          "the organization's Logto, or serve the organization from another --account " +
          `(${cause instanceof Error ? cause.message : String(cause)})`
      )
    }
    throw cause
  }

  const registry = deps.registry ?? new UserBindingRegistry()
  const binding: BindUserInput = {
    localAccountId: input.localAccountId,
    userId: identity.userId,
    orgId: identity.orgId,
    logtoSubject: person.subject,
    logtoIssuer: person.issuer,
    ...(person.displayName ? { displayName: person.displayName } : {}),
    ...(person.email ? { email: person.email } : {}),
  }
  const owner = await registry.getOwner(input.localAccountId)
  let rebound: HeadlessCollabReader["rebound"]
  if (owner && !samePerson({ issuer: owner.logtoIssuer, subject: owner.logtoSubject }, person)) {
    // The account's binding is the operator's choice (`logto login --rebind`).
    await registry.rebind(binding)
    clearCollabCursors(input.cliHome, input.localAccountId, deps.cursorFs)
    rebound = { from: describeRow(owner), to: describePerson(person) }
  } else {
    await registry.bind(binding)
  }
  saveCollabConnection(input.localAccountId, { baseUrl: input.config.url })

  const refresh: HeadlessCollabAdapter["refresh"] = (localAccountId, legs) =>
    refreshCollabPlaneQuietly({
      localAccountId: localAccountId,
      registry,
      fetchImpl,
      accessToken: async () => accessToken(),
      legs,
      ...(deps.now ? { now: deps.now } : {}),
    })
  const refreshAll = () => refresh(input.localAccountId, ALL_COLLAB_REFRESH_LEGS)
  await requestCollabRefresh(input.localAccountId, refreshAll, deps.now)
  return {
    status: "active",
    ...(rebound ? { rebound } : {}),
    runtime: {
      resolve: async (localAccountId) =>
        localAccountId === input.localAccountId && (await boundSession())
          ? { client, orgId: input.config.orgId }
          : null,
      refresh,
      refreshAll,
      local: createCollabCursorStorage(input.cliHome, input.localAccountId, deps.cursorFs),
    },
    stop: () => undefined,
  }
}
