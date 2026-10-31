/**
 * The paired host answered and refused a write because its authority (the
 * brain) is not connected (ADR-0250 §4): nothing was written. The Rust data
 * plane spells it `HOST_UNAVAILABLE` and sends it as a retryable 503
 * (`crates/cognia-companion/src/data_plane.rs`).
 *
 * Distinct from "the host could not be reached": that one never got an
 * answer, this one did, and it says the write did not happen.
 */
export const HOST_UNAVAILABLE = "HOST_UNAVAILABLE"

/**
 * Whether `error` (or, for an `AggregateError` such as a fan-out of deletes,
 * any error it carries) is the host's `HOST_UNAVAILABLE` refusal. Read
 * structurally, so this stays free of the transport.
 */
export function isHostUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ((error as { code?: unknown }).code === HOST_UNAVAILABLE) return true
  const inner = (error as { errors?: unknown }).errors
  return Array.isArray(inner) && inner.some(isHostUnavailableError)
}
