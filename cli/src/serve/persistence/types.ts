/**
 * Headless durability backend contract (ADR-0059).
 *
 * fake-indexeddb/Dexie stays the business-logic runtime; only the *persistence*
 * of that runtime sits behind {@link HeadlessDurabilityBackend}. One
 * implementation ships: `sqlite-v5`, Node's built-in SQLite (WAL) holding
 * generic database/table/key/value rows, so there is no second hand-maintained
 * Cognia schema.
 */
/** The persisted backend id. Wire format: it appears in `durability` CLI output. */
export const DURABILITY_BACKEND = "sqlite-v5" as const

export type DurabilityBackendId = typeof DURABILITY_BACKEND

/**
 * One row-level effect inside a committed transaction.
 *
 * `value === null` is a deletion. Keys are the canonical string encoding from
 * `./canonical.ts` — IndexedDB keys may be numbers, strings, dates or arrays,
 * and the backends need one total order and one equality that survives JSON.
 */
export interface DurabilityMutation {
  database: string
  table: string
  key: string
  value: unknown | null
}

/** A complete, durable transaction. Sequences are per-account and gapless. */
export interface DurabilityCommit {
  sequence: number
  /** Wall clock at append time. Diagnostics only — never used for ordering. */
  committedAt: number
  mutations: DurabilityMutation[]
}

/** Schema identity of one Dexie database, pinned so a restore cannot cross versions. */
export interface DurabilitySchema {
  version: number
  /** Table names the backend persists (post-exclusion), sorted. */
  tables: string[]
}

/** Full materialised state: `dbs[database].rows[table][key] = value`. */
export interface DurabilityState {
  /** Highest applied commit sequence; 0 before the first commit. */
  sequence: number
  dbs: Record<
    string,
    {
      schema: DurabilitySchema
      rows: Record<string, Record<string, unknown>>
    }
  >
}

export function emptyDurabilityState(): DurabilityState {
  return { sequence: 0, dbs: {} }
}

/**
 * The persistence port the headless brain writes through.
 *
 * `commit` MUST be durable (committed and synced) before it resolves: the
 * Dexie transaction-complete path awaits nothing, so the *synchronous* variant
 * `commitSync` is what actually runs on that path. `commit` exists for tooling
 * and tests that operate off the hot path.
 */
export interface HeadlessDurabilityBackend {
  readonly id: DurabilityBackendId
  /** Materialise everything persisted so far. */
  load(): Promise<DurabilityState>
  /** Durably record one transaction. Throws if the sequence is not `last + 1`. */
  commitSync(commit: DurabilityCommit): void
  /** Async wrapper over {@link commitSync}, for tooling and tests. */
  commit(commit: DurabilityCommit): Promise<void>
  /** Highest durably recorded sequence. */
  lastSequence(): number
  /** Replace the persisted content with `state` and re-pin its schemas, verified. */
  compact(state: DurabilityState): Promise<CompactionResult>
  /**
   * Routine upkeep on the commit-count cadence (WAL checkpoint, binary
   * garbage collection). The store calls it only while the schema the backend
   * holds matches the live one, and falls back to {@link compact} when it
   * drifted. It runs on the brain's event loop, so it must not rewrite the
   * data set.
   */
  maintain(): void
  /** Release file handles. Safe to call more than once. */
  close(): Promise<void>
}

export interface CompactionResult {
  /** Sequence the rewritten store holds. */
  sequence: number
}

/** Errors `durability verify` distinguishes; `code` is wire format. */
export type DurabilityFaultCode =
  "sequence-gap" | "schema-mismatch" | "sqlite-integrity-failure" | "store-corrupt" | "writer-busy"

export class DurabilityFault extends Error {
  readonly code: DurabilityFaultCode
  /** Sequence the fault was detected at, when the fault has one. */
  readonly sequence: number | null

  constructor(code: DurabilityFaultCode, message: string, sequence: number | null = null) {
    super(message)
    this.name = "DurabilityFault"
    this.code = code
    this.sequence = sequence
  }
}
