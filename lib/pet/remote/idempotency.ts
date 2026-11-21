// The host's answer ledger for remote pet care (ADR-0219): feed, play, talk,
// buy and the rest move XP, coins and cooldowns once per intent, however often
// a phone retries it. The ledger itself is the companion's
// (`lib/companion/idempotency-ledger.ts`); this file keeps the pet's one
// process-wide instance plus the private, clearable intent store for
// `pet_chat_send` (F25/F5/F4/F15).

import {
  createIdempotencyLedger,
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyLedger,
} from "@/lib/companion/idempotency-ledger"
import {
  capturePetScope,
  isPetConversationScopeCurrent,
  onActiveDatabaseChange,
  onPetConversationCleared,
  type PetScopeToken,
} from "@/lib/pet/runtime/pet-scope"
import type { PetChatSendResult } from "./types"

export type PetIdempotencyLedger = IdempotencyLedger

export function createPetIdempotencyLedger(
  opts: Parameters<typeof createIdempotencyLedger>[0] = {}
): PetIdempotencyLedger {
  return createIdempotencyLedger(opts)
}

type ChatIntentEntry =
  | {
      state: "pending"
      databaseName: string
      scope: PetScopeToken
      promise: Promise<PetChatSendResult>
      expiresAt: number
    }
  | {
      state: "settled"
      databaseName: string
      scope: PetScopeToken
      result: PetChatSendResult
      expiresAt: number
    }
  | {
      /** Redacted tombstone: blocks duplicate LLM calls without retaining private reply text. */
      state: "cleared"
      databaseName: string
      expiresAt: number
    }

export interface PetChatIntentStore {
  runChat(
    callerDeviceId: string,
    idempotencyKey: string,
    slowWorkWindowMs: number,
    startWork: (scope: PetScopeToken) => Promise<PetChatSendResult>
  ): Promise<PetChatSendResult>
  /** Scrub all cached replies for `databaseName` into redacted tombstones. */
  scrubDatabase(databaseName: string): void
  size(): number
  clear(): void
  dispose(): void
}

const CLEARED_RESULT: PetChatSendResult = { ok: true, status: "degraded", reason: "empty" }

async function raceWindow<T>(
  work: Promise<T>,
  ms: number
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ settled: true as const, value })), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Private, account-scoped, clearable intent store for `pet_chat_send`.
 *
 * - Never persists private replies outside the unlocked account memory space.
 * - Does not freeze `{ ok: true, status: "pending" }` as terminal: a retry with
 *   the same `idempotencyKey` joins the live promise or reads the settled reply.
 * - Clearing conversation history, resetting the pet, or switching/locking
 *   accounts immediately scrubs all stored replies for that database into
 *   redacted tombstones so retries neither re-invoke the model nor recover
 *   deleted private text.
 */
export function createPetChatIntentStore(
  opts: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}
): PetChatIntentStore {
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS
  const maxEntries = opts.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES
  const entries = new Map<string, ChatIntentEntry>()

  const sweep = (at: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key)
    }
  }

  const scrubDatabase = (databaseName: string) => {
    for (const [key, entry] of entries) {
      if (entry.databaseName !== databaseName) continue
      if (entry.state !== "cleared") {
        entries.set(key, { state: "cleared", databaseName, expiresAt: entry.expiresAt })
      }
    }
  }

  const offClear = onPetConversationCleared((dbName) => scrubDatabase(dbName))
  const offDb = onActiveDatabaseChange((_next, prevName) => scrubDatabase(prevName))

  return {
    async runChat(callerDeviceId, idempotencyKey, slowWorkWindowMs, startWork) {
      const at = now()
      sweep(at)
      const scope = capturePetScope()
      const key = `${scope.databaseName}#${scope.databaseEpoch}:${callerDeviceId}:${idempotencyKey}`
      const existing = entries.get(key)

      if (existing) {
        if (existing.state === "cleared") return CLEARED_RESULT
        if (existing.state === "settled") {
          if (!isPetConversationScopeCurrent(existing.scope)) {
            entries.set(key, {
              state: "cleared",
              databaseName: existing.databaseName,
              expiresAt: existing.expiresAt,
            })
            return CLEARED_RESULT
          }
          return existing.result
        }
        // Existing attempt is still running: join it within the bridge window.
        const joined = await raceWindow(existing.promise, slowWorkWindowMs)
        if (!joined.settled) return { ok: true, status: "pending" }
        const current = entries.get(key)
        if (current?.state === "cleared" || !isPetConversationScopeCurrent(existing.scope)) {
          return CLEARED_RESULT
        }
        return joined.value
      }

      const expiresAt = at + ttlMs
      const work = startWork(scope)
      const pendingEntry: ChatIntentEntry = {
        state: "pending",
        databaseName: scope.databaseName,
        scope,
        promise: work,
        expiresAt,
      }
      entries.set(key, pendingEntry)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }

      void work.then(
        (result) => {
          if (entries.get(key) !== pendingEntry) return
          if (!isPetConversationScopeCurrent(scope)) {
            entries.set(key, { state: "cleared", databaseName: scope.databaseName, expiresAt })
            return
          }
          entries.set(key, {
            state: "settled",
            databaseName: scope.databaseName,
            scope,
            result,
            expiresAt,
          })
        },
        () => {
          if (entries.get(key) === pendingEntry) entries.delete(key)
        }
      )

      const raced = await raceWindow(work, slowWorkWindowMs)
      if (!raced.settled) return { ok: true, status: "pending" }
      const current = entries.get(key)
      if (current?.state === "cleared" || !isPetConversationScopeCurrent(scope)) {
        return CLEARED_RESULT
      }
      return raced.value
    },
    scrubDatabase,
    size: () => entries.size,
    clear: () => entries.clear(),
    dispose: () => {
      offClear()
      offDb()
      entries.clear()
    },
  }
}

let shared: PetIdempotencyLedger | null = null
let sharedChatIntents: PetChatIntentStore | null = null
const chatIntentsByLedger = new WeakMap<PetIdempotencyLedger, PetChatIntentStore>()

/** The process-wide ledger the host dispatch uses. */
export function getPetIdempotencyLedger(): PetIdempotencyLedger {
  if (!shared) shared = createPetIdempotencyLedger()
  return shared
}

/**
 * Resolve the private chat intent store paired with a ledger. Passing a fresh
 * test ledger gets its own isolated store automatically; production shares one.
 */
export function getPetChatIntentStore(ledger?: PetIdempotencyLedger): PetChatIntentStore {
  if (ledger && ledger !== shared) {
    let store = chatIntentsByLedger.get(ledger)
    if (!store) {
      store = createPetChatIntentStore()
      chatIntentsByLedger.set(ledger, store)
    }
    return store
  }
  if (!sharedChatIntents) sharedChatIntents = createPetChatIntentStore()
  return sharedChatIntents
}

/** Test helper: drop the process-wide ledger and chat intent store. */
export function __resetPetIdempotencyLedgerForTesting(): void {
  shared = null
  sharedChatIntents?.dispose()
  sharedChatIntents = null
}
