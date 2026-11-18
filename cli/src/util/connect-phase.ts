/**
 * Whether a failed HTTP request ever left this machine.
 *
 * A request that failed before its connection was made (DNS, a refused or
 * unroutable address, a connect that took too long, a TLS handshake or pin
 * that failed) provably carried nothing to the host, so sending it another
 * way cannot run it twice. A failure after the request was handed to an open
 * connection (a reset, a response that never came) may have reached the host
 * and run there. The relay fallback (`../api/transport.ts`) repeats only the
 * first kind for every command, and the second only for commands the host
 * deduplicates.
 */

/** Thrown by the connection layer when the request never reached an open connection. */
export class HostConnectError extends Error {
  readonly code: string

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "HostConnectError"
    this.code = code
  }
}

/** The connect deadline ran out before a connection was established. */
export const CONNECT_TIMEOUT_CODE = "COGNIA_CONNECT_TIMEOUT"

/**
 * Node and undici codes raised only before any request byte is written: name
 * resolution, the TCP connect and the TLS handshake. `ETIMEDOUT` is the
 * kernel's connect timeout; undici reports read timeouts under its own
 * `UND_ERR_*_TIMEOUT` codes, which are deliberately absent.
 */
const CONNECT_PHASE_CODES = new Set([
  CONNECT_TIMEOUT_CODE,
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  // The pinned connection layer's own refusals (`../worker/companion-worker-transport.ts`).
  "tls_pin_mismatch",
  "tls_peer_certificate_missing",
])

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** True when `error`, or an error it wraps, says the request was never sent. */
export function neverSent(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof HostConnectError) return true
    const code = codeOf(current)
    if (code && CONNECT_PHASE_CODES.has(code)) return true
    current = current && typeof current === "object" ? (current as { cause?: unknown }).cause : null
  }
  return false
}

/** The longest a direct connect may take when a relay can carry the request instead. */
export const MAX_CONNECT_DEADLINE_MS = 5_000
const MIN_CONNECT_DEADLINE_MS = 500

const CONNECT_DEADLINE_STEP_MS = 100

/**
 * How long the direct route may spend connecting before it gives up and
 * leaves the rest of the budget to the relay: a third of the budget, between
 * half a second and {@link MAX_CONNECT_DEADLINE_MS}, in 100 ms steps (each
 * distinct deadline keeps its own connection pool, so the set stays small).
 */
export function connectDeadlineMs(budgetMs: number | undefined): number {
  if (!budgetMs || !Number.isFinite(budgetMs) || budgetMs <= 0) return MAX_CONNECT_DEADLINE_MS
  const third = Math.floor(budgetMs / 3 / CONNECT_DEADLINE_STEP_MS) * CONNECT_DEADLINE_STEP_MS
  return Math.min(MAX_CONNECT_DEADLINE_MS, Math.max(MIN_CONNECT_DEADLINE_MS, third))
}
