// The host's answer ledger for the Files writes a retry must not repeat
// (ADR-0223 §9): Duplicate, Use in chat, New folder and an upload's commit.
// Each would otherwise make a second copy, binding, folder or library file
// when a phone loses the reply and presses again.
//
// The semantics are remote pet care's, and the implementation is the
// companion's shared ledger (`lib/companion/idempotency-ledger.ts`): keyed on
// the AUTHENTICATED device
// (`callerDeviceId`, injected server-side) and the body `idempotencyKey`, the
// in-flight promise stored so a concurrent retry joins it, a rejection
// forgotten so a transient failure can be retried with the same key.

import { createIdempotencyLedger, type IdempotencyLedger } from "@/lib/companion/idempotency-ledger"

export type FilesIdempotencyLedger = IdempotencyLedger

export function createFilesIdempotencyLedger(
  opts: Parameters<typeof createIdempotencyLedger>[0] = {}
): FilesIdempotencyLedger {
  return createIdempotencyLedger(opts)
}
