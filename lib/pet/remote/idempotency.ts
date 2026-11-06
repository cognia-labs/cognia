// The host's answer ledger for remote pet care (ADR-0219): feed, play, talk,
// buy and the rest move XP, coins and cooldowns once per intent, however often
// a phone retries it. The ledger itself is the companion's
// (`lib/companion/idempotency-ledger.ts`); this file keeps the pet's one
// process-wide instance.

import { createIdempotencyLedger, type IdempotencyLedger } from "@/lib/companion/idempotency-ledger"

export type PetIdempotencyLedger = IdempotencyLedger

export function createPetIdempotencyLedger(
  opts: Parameters<typeof createIdempotencyLedger>[0] = {}
): PetIdempotencyLedger {
  return createIdempotencyLedger(opts)
}

let shared: PetIdempotencyLedger | null = null

/** The process-wide ledger the host dispatch uses. */
export function getPetIdempotencyLedger(): PetIdempotencyLedger {
  if (!shared) shared = createPetIdempotencyLedger()
  return shared
}

/** Test helper: drop the process-wide ledger. */
export function __resetPetIdempotencyLedgerForTesting(): void {
  shared = null
}
