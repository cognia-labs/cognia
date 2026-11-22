/**
 * Deleting an official Cognia account (ADR-0215 §10): the identity part.
 *
 * The identity Worker serves `/api/account/deletion` next to its issuer:
 *
 * - `GET` reads the person's state (`none`, `pending` with the purge date, or
 *   `cancelled`);
 * - `POST` starts a 7-day cooling-off period, after which the Worker purges
 *   the person's sign-ins, sessions and tokens;
 * - `DELETE` cancels a pending request.
 *
 * All three take the person's access token. `POST` also wants proof that the
 * person is at the keyboard: an ID token from a sign-in at most 10 minutes
 * old. {@link confirmAccountDeletion} gets one with a fresh login
 * (`prompt=login&max_age=0`) and refuses to go on when that login names
 * someone other than the person signed in on this profile. The fresh tokens
 * prove the request and are then dropped; the profile keeps its own session.
 *
 * Local data is untouched: deleting the account deletes who the person is to
 * Cognia, not what is on this device.
 */

import {
  loginToLogto,
  revokeLogtoToken,
  type LogtoDrivers,
  type LogtoSession,
} from "@/lib/logto/client"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { decodeJwtPayload, stringClaim } from "@/lib/security/jwt-payload"

import {
  officialLogtoConfig,
  type OfficialConfigOptions,
  type OfficialDeployment,
} from "./official-deployment"

export const DEFAULT_DELETION_COOLING_OFF_DAYS = 7

export interface OfficialDeletionState {
  status: "none" | "pending" | "cancelled"
  /** ISO timestamps, present while `pending`. */
  requestedAt?: string
  purgeAfter?: string
  /** Server-configured cooling-off window in days, when advertised. */
  coolingOffDays?: number
}

export type AccountDeletionErrorCode =
  /** The access token was refused: sign in again. */
  | "unauthorized"
  /** The confirming sign-in was not fresh enough, or not the same person. */
  | "stale-sign-in"
  /** The fresh sign-in named a different person than this profile's. */
  | "different-person"
  | "failed"

export class AccountDeletionError extends Error {
  constructor(
    readonly code: AccountDeletionErrorCode,
    message: string
  ) {
    super(message)
    this.name = "AccountDeletionError"
  }
}

export interface AccountDeletionDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

type Credentials = Pick<LogtoSession, "issuer" | "accessToken">

/** The deletion endpoint beside an issuer: same origin, `/api/account/deletion`. */
export function accountDeletionUrl(issuer: string): string {
  return new URL("/api/account/deletion", issuer).href
}

function readState(body: unknown): OfficialDeletionState {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AccountDeletionError("failed", "Malformed account deletion response")
  }
  const record = body as Record<string, unknown>
  if (record.status !== "none" && record.status !== "pending" && record.status !== "cancelled") {
    throw new AccountDeletionError(
      "failed",
      `Unexpected account deletion status: ${String(record.status)}`
    )
  }
  const coolingOffDays =
    typeof record.coolingOffDays === "number" &&
    Number.isFinite(record.coolingOffDays) &&
    record.coolingOffDays >= 1
      ? Math.trunc(record.coolingOffDays)
      : undefined
  return {
    status: record.status,
    ...(typeof record.requestedAt === "string" ? { requestedAt: record.requestedAt } : {}),
    ...(typeof record.purgeAfter === "string" ? { purgeAfter: record.purgeAfter } : {}),
    ...(coolingOffDays !== undefined ? { coolingOffDays } : {}),
  }
}

async function call(
  method: "GET" | "POST" | "DELETE",
  credentials: Credentials,
  deps: AccountDeletionDeps,
  body?: unknown
): Promise<OfficialDeletionState> {
  deps.signal?.throwIfAborted()
  const fetchImpl = deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
  const response = await fetchImpl(accountDeletionUrl(credentials.issuer), {
    method,
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (response.ok) return readState(payload)
  const description =
    typeof payload?.error_description === "string"
      ? payload.error_description
      : `HTTP ${response.status}`
  if (response.status === 401) throw new AccountDeletionError("unauthorized", description)
  if (response.status === 403) throw new AccountDeletionError("stale-sign-in", description)
  throw new AccountDeletionError("failed", description)
}

export function readAccountDeletion(
  session: Credentials,
  deps: AccountDeletionDeps = {}
): Promise<OfficialDeletionState> {
  return call("GET", session, deps)
}

export function cancelAccountDeletion(
  session: Credentials,
  deps: AccountDeletionDeps = {}
): Promise<OfficialDeletionState> {
  return call("DELETE", session, deps)
}

/** Start the cooling-off period with a session from a sign-in that just happened. */
export function requestAccountDeletion(
  fresh: Pick<LogtoSession, "issuer" | "accessToken" | "idToken">,
  deps: AccountDeletionDeps = {}
): Promise<OfficialDeletionState> {
  if (!fresh.idToken) {
    return Promise.reject(
      new AccountDeletionError("stale-sign-in", "the confirming sign-in returned no ID token")
    )
  }
  return call("POST", fresh, deps, { id_token: fresh.idToken })
}

export interface ConfirmAccountDeletionDeps extends AccountDeletionDeps {
  login?: typeof loginToLogto
  revoke?: typeof revokeLogtoToken
  /**
   * Final fence evaluated right after interactive re-authentication completes
   * and immediately before `POST /api/account/deletion`. Rejects if the local
   * profile switched or signed out while the browser was open.
   */
  assertActive?: (expectedSub: string) => void | Promise<void>
  /** Notifies the caller right before `POST` starts so "Stop" UI can settle. */
  onSubmitting?: () => void
}

/**
 * Sign in again, check it is the same person, and request the deletion with
 * that sign-in's tokens.
 */
export async function confirmAccountDeletion(
  deployment: OfficialDeployment,
  drivers: LogtoDrivers,
  options: Omit<OfficialConfigOptions, "freshLogin">,
  current: Pick<LogtoSession, "accessToken">,
  deps: ConfirmAccountDeletionDeps = {}
): Promise<OfficialDeletionState> {
  const expected = stringClaim(decodeJwtPayload(current.accessToken), "sub")
  if (!expected) {
    throw new AccountDeletionError("unauthorized", "this profile's session names no person")
  }
  deps.signal?.throwIfAborted()
  const fresh = await (deps.login ?? loginToLogto)(
    {
      ...officialLogtoConfig(deployment, { ...options, freshLogin: true }),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    drivers
  )
  const disposeFreshRefreshToken = () => {
    if (!fresh.refreshToken) return
    void (deps.revoke ?? revokeLogtoToken)(
      { issuer: fresh.issuer, clientId: fresh.clientId },
      fresh.refreshToken,
      "refresh_token",
      deps.fetchImpl ?? drivers.fetchImpl
    ).catch(() => undefined)
  }
  try {
    deps.signal?.throwIfAborted()
    await deps.assertActive?.(expected)
    deps.signal?.throwIfAborted()
    if (stringClaim(decodeJwtPayload(fresh.accessToken), "sub") !== expected) {
      throw new AccountDeletionError(
        "different-person",
        "the confirming sign-in is a different account than the one signed in here"
      )
    }
    deps.onSubmitting?.()
    // Once POST begins, do not pass the interactive-wait signal: cancelling the
    // HTTP read after the Worker accepted the request would falsely report the
    // scheduled deletion as cancelled.
    return await requestAccountDeletion(fresh, { fetchImpl: deps.fetchImpl })
  } finally {
    disposeFreshRefreshToken()
  }
}
