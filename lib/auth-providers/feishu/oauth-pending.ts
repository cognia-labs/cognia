/**
 * Pending-authorization store for the Lark send-as-user OAuth flow.
 *
 * The authorize step and the completion step run in different call stacks and,
 * with the relay redirect, potentially across a restart. The PKCE
 * `code_verifier`, the exact `redirect_uri` used at authorize time, and the
 * `state` for a durable CSRF check must survive that gap and reach
 * `handleLarkOAuth`.
 *
 * Both halves run **in the brain** (ADR-0059 host parity): on the desktop the
 * brain is the WebView, on a self-hosted install it is the `cognia-agent serve`
 * process. That is why this is no longer `localStorage` — the headless brain's
 * Web Storage is an in-memory shim (`lib/headless/node-indexeddb.ts`, "the
 * brain's durable state is Dexie"), and the browser that opened the settings
 * dialog is a different process entirely, so a verifier written there was
 * never visible to the process that had to spend it.
 *
 * It lives in the connectors secret store instead: the same
 * `cognia_secrets::secret_store` that already holds this adapter's `appId`,
 * `appSecret` and `user_token`. A PKCE verifier IS a secret, the store is
 * durable and encrypted on both hosts, and it needs no schema version.
 *
 * Keyed by the sign-in's own `state` (`larkPendingCredential`), so several
 * people can authorize one adapter at once (ADR-0243 phase 4), with a
 * 10-minute TTL and a clear-on-use contract so a completed or abandoned
 * authorization leaves no replayable residue. The Host checks the same record
 * when it publishes the tokens (`lark_user_auth` in `keyring.rs`): one issued
 * to a person publishes only that person's authorization.
 */

import {
  connectorsKeyringDelete,
  connectorsKeyringGet,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import { larkPendingCredential } from "./user-key"

const TTL_MS = 10 * 60 * 1000

/** Whom a pending sign-in may authorize. */
export type LarkOAuthIssuedTo =
  /** A delegated link: only this person (`larkUserKey`), at their captured epoch. */
  | { principal: string; authorizationEpoch: string }
  /** The owner's sign-in from settings: whoever signs in, fenced on the app credentials. */
  | { appEpoch: string }

export type LarkOAuthPending = LarkOAuthIssuedTo & {
  /** The `lark:<adapterId>:<nonce>` state echoed back on the redirect. */
  state: string
  /** PKCE verifier whose challenge was sent to the authorize endpoint. */
  codeVerifier: string
  /** The exact redirect_uri sent to authorize — must be replayed at exchange. */
  redirectUri: string
  /** Host-only reconnect fence; never sent to the authorization server. */
  connection?: { ref: string; revision: number }
  /** Wall-clock ms the record was written (for TTL expiry). */
  ts: number
}

/** Persist a pending sign-in on `adapterId`. Stamps `ts` = now. */
export async function setLarkOAuthPending(
  adapterId: string,
  pending: Omit<LarkOAuthPending, "ts">,
  now = Date.now()
): Promise<void> {
  const record = { ...pending, ts: now } as LarkOAuthPending
  await connectorsKeyringSet(
    adapterId,
    await larkPendingCredential(pending.state),
    JSON.stringify(record)
  )
}

function issuedTo(record: Record<string, unknown>): boolean {
  return typeof record.principal === "string"
    ? typeof record.authorizationEpoch === "string"
    : typeof record.appEpoch === "string"
}

/**
 * Read the pending sign-in `state` names on `adapterId`. Returns null when
 * absent, malformed, or older than the TTL (an expired record is also evicted).
 */
export async function getLarkOAuthPending(
  adapterId: string,
  state: string,
  now = Date.now()
): Promise<LarkOAuthPending | null> {
  let raw: string | null
  try {
    raw = await connectorsKeyringGet(adapterId, await larkPendingCredential(state))
  } catch {
    // Store unavailable (locked, or no host) — indistinguishable from absent
    // for this caller, and the exchange reports "retry Connect" either way.
    return null
  }
  if (!raw) return null
  let record: LarkOAuthPending
  try {
    record = JSON.parse(raw) as LarkOAuthPending
  } catch {
    return null
  }
  if (
    !record ||
    typeof record.ts !== "number" ||
    record.state !== state ||
    typeof record.codeVerifier !== "string" ||
    typeof record.redirectUri !== "string" ||
    !issuedTo(record as unknown as Record<string, unknown>)
  ) {
    return null
  }
  if (now - record.ts > TTL_MS) {
    await clearLarkOAuthPending(adapterId, state)
    return null
  }
  return record
}

/** Remove the pending sign-in `state` names (clear-on-use). */
export async function clearLarkOAuthPending(adapterId: string, state: string): Promise<void> {
  try {
    await connectorsKeyringDelete(adapterId, await larkPendingCredential(state))
  } catch {
    // Delete is idempotent and best-effort; the TTL is the backstop.
  }
}
