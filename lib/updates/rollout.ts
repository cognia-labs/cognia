/**
 * Staged-rollout eligibility.
 *
 * The device contributes exactly one number to the control plane: a stable
 * bucket in 0 to 9999. It is generated once from local randomness and is
 * deliberately NOT derived from the account id, the paired-device id, or the
 * diagnostics installation id, so a rollout cohort cannot be joined back to a
 * user across those planes.
 */

import type { UpdateCandidate, UpdateRollout } from "@cognia/agent-config-types"

export {
  ROLLOUT_BUCKET_COUNT,
  generateRolloutBucket,
  normalizeRolloutBucket,
} from "@/lib/tauri/update-cohort"
import { ROLLOUT_BUCKET_COUNT } from "@/lib/tauri/update-cohort"

export type RolloutVerdict = "offered" | "not-yet" | "paused" | "revoked"

/**
 * Decide whether a rollout window currently offers this device the candidate.
 *
 * `manual` marks a user-initiated check. It bypasses the percentage gate only.
 * A paused or revoked rollout still refuses, and so do the channel,
 * compatibility and signature gates that run outside this function.
 */
export function rolloutVerdict(
  rollout: UpdateRollout | undefined,
  bucket: number,
  options: { manual?: boolean } = {}
): RolloutVerdict {
  if (!rollout) return "offered"
  if (rollout.revoked) return "revoked"
  if (rollout.paused) return "paused"
  if (options.manual) return "offered"
  const percentage = Math.max(0, Math.min(100, rollout.percentage))
  const threshold = (percentage / 100) * ROLLOUT_BUCKET_COUNT
  return bucket < threshold ? "offered" : "not-yet"
}

/** Filter a candidate list down to what this device may currently install. */
export function eligibleCandidates(
  candidates: readonly UpdateCandidate[],
  bucket: number,
  options: { manual?: boolean } = {}
): UpdateCandidate[] {
  return candidates.filter((c) => rolloutVerdict(c.rollout, bucket, options) === "offered")
}
