/** Shared cohort math, independent of settings stores and native updater APIs. */
export const ROLLOUT_BUCKET_COUNT = 10_000

/** Generate a fresh device bucket from crypto randomness when available. */
export function generateRolloutBucket(random: () => number = Math.random): number {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const buf = new Uint32Array(1)
    cryptoRef.getRandomValues(buf)
    return buf[0] % ROLLOUT_BUCKET_COUNT
  }
  return Math.floor(random() * ROLLOUT_BUCKET_COUNT) % ROLLOUT_BUCKET_COUNT
}

/** Whether a persisted value is already a usable device bucket. */
export function isValidRolloutBucket(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < ROLLOUT_BUCKET_COUNT
  )
}

/** Normalize a persisted bucket, regenerating anything out of range. */
export function normalizeRolloutBucket(value: unknown, random?: () => number): number {
  return isValidRolloutBucket(value) ? value : generateRolloutBucket(random)
}
