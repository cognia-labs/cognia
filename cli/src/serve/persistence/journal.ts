/**
 * `journal-v4` — checkpoint + append-only transaction journal.
 *
 * On-disk shape under `<root>/`:
 *
 * ```
 * generations/gen-0001/…      immutable checkpoint (see ./checkpoint.ts)
 * journal/gen-0001.jsonl      commits recorded *after* gen-0001
 * ```
 *
 * One line per committed Dexie transaction:
 *
 * ```
 * <canonical-json-payload>\t<sha256-of-payload>\n
 * ```
 *
 * Framing rules, and why each exists:
 *
 * - **Trailing newline = commit fence.** A crash mid-append leaves a line with
 *   no `\n`. That transaction never resolved to the caller, so discarding it on
 *   replay is not data loss — it is the definition of the commit point.
 * - **Checksum.** A line that *is* terminated but does not hash is corruption
 *   (torn sector, truncated-then-extended file) and fails replay loudly rather
 *   than feeding half a transaction into the store.
 * - **Gapless sequence.** Sequences are dense from `checkpoint.sequence + 1`.
 *   A gap means a lost segment; replay refuses instead of silently skipping.
 *
 * Appends are **synchronous** (`writeSync` + `fsyncSync`). They run from the
 * Dexie transaction-complete listener, which cannot await — see
 * `./capture.ts` for why that listener is where the commit point lives.
 */
import fs from "node:fs"
import path from "node:path"

import { canonicalJson, sha256Hex } from "./canonical"
import { LegacyValueReport, normalizeLegacyValue, VALUE_CODEC } from "./value-codec"
import { latestGeneration, nextGeneration, readCheckpoint, writeCheckpoint } from "./checkpoint"
import {
  DurabilityFault,
  emptyDurabilityState,
  type CompactionResult,
  type DurabilityCommit,
  type DurabilityMutation,
  type DurabilityState,
  type HeadlessDurabilityBackend,
} from "./types"

export function journalDir(root: string): string {
  return path.join(root, "journal")
}

export function journalFile(root: string, generation: string): string {
  return path.join(journalDir(root), `${generation}.jsonl`)
}

/** Serialise one commit to its on-disk line (including the trailing newline). */
export function encodeCommitLine(commit: DurabilityCommit): string {
  // Mutation values are already codec-1 JSON (the store encodes them at the
  // Dexie boundary); the field tells replay so, and lines without it are
  // normalised as codec 0.
  const payload = canonicalJson({
    sequence: commit.sequence,
    committedAt: commit.committedAt,
    valueCodec: VALUE_CODEC,
    mutations: commit.mutations,
  })
  return `${payload}\t${sha256Hex(payload)}\n`
}

export interface ReplayResult {
  commits: DurabilityCommit[]
  /** Bytes of the trailing torn record that replay discarded (0 when clean). */
  discardedBytes: number
}

/**
 * Parse a journal file body into commits.
 *
 * `fromSequence` is the checkpoint's sequence: the first record must be
 * `fromSequence + 1`. Lines written before value codec 1 come back normalised,
 * with what looks like lost binary data recorded in `report`.
 */
export function replayJournal(
  body: string,
  fromSequence: number,
  report: LegacyValueReport = new LegacyValueReport()
): ReplayResult {
  const commits: DurabilityCommit[] = []
  let expected = fromSequence + 1
  let offset = 0
  let discardedBytes = 0

  while (offset < body.length) {
    const newline = body.indexOf("\n", offset)
    if (newline === -1) {
      // Unterminated tail: the process died between `write` and the newline.
      discardedBytes = Buffer.byteLength(body.slice(offset), "utf8")
      break
    }
    const line = body.slice(offset, newline)
    offset = newline + 1
    if (line.length === 0) continue

    const separator = line.lastIndexOf("\t")
    if (separator === -1) {
      throw new DurabilityFault(
        "journal-torn-record",
        `journal record at sequence ${expected} has no checksum separator`,
        expected
      )
    }
    const payload = line.slice(0, separator)
    const checksum = line.slice(separator + 1)
    if (sha256Hex(payload) !== checksum) {
      throw new DurabilityFault(
        "journal-checksum-mismatch",
        `journal record at sequence ${expected} failed its checksum`,
        expected
      )
    }
    const commit = parseCommitPayload(payload, expected, report)
    if (commit.sequence !== expected) {
      throw new DurabilityFault(
        "journal-sequence-gap",
        `journal expected sequence ${expected} but found ${commit.sequence}`,
        expected
      )
    }
    commits.push(commit)
    expected += 1
  }

  return { commits, discardedBytes }
}

function parseCommitPayload(
  payload: string,
  expected: number,
  report: LegacyValueReport
): DurabilityCommit {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new DurabilityFault(
      "journal-torn-record",
      `journal record at sequence ${expected} is not valid JSON`,
      expected
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DurabilityFault(
      "journal-torn-record",
      `journal record at sequence ${expected} is not an object`,
      expected
    )
  }
  const root = parsed as Record<string, unknown>
  if (typeof root.sequence !== "number" || !Number.isInteger(root.sequence)) {
    throw new DurabilityFault(
      "journal-torn-record",
      `journal record at sequence ${expected} has no integer sequence`,
      expected
    )
  }
  if (root.valueCodec !== undefined && root.valueCodec !== VALUE_CODEC) {
    throw new DurabilityFault(
      "journal-torn-record",
      `journal record at sequence ${expected} uses unsupported value codec ${String(root.valueCodec)}`,
      expected
    )
  }
  const legacy = root.valueCodec === undefined
  if (!Array.isArray(root.mutations)) {
    throw new DurabilityFault(
      "journal-torn-record",
      `journal record at sequence ${expected} has no mutation array`,
      expected
    )
  }
  const mutations: DurabilityMutation[] = []
  for (const raw of root.mutations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DurabilityFault(
        "journal-torn-record",
        `journal record at sequence ${expected} has a malformed mutation`,
        expected
      )
    }
    const mutation = raw as Record<string, unknown>
    if (
      typeof mutation.database !== "string" ||
      typeof mutation.table !== "string" ||
      typeof mutation.key !== "string"
    ) {
      throw new DurabilityFault(
        "journal-torn-record",
        `journal record at sequence ${expected} has a malformed mutation address`,
        expected
      )
    }
    const value = mutation.value === undefined ? null : (mutation.value ?? null)
    mutations.push({
      database: mutation.database,
      table: mutation.table,
      key: mutation.key,
      value:
        legacy && value !== null
          ? normalizeLegacyValue(value, {
              database: mutation.database,
              table: mutation.table,
              key: mutation.key,
              report,
            })
          : value,
    })
  }
  return {
    sequence: root.sequence,
    committedAt: typeof root.committedAt === "number" ? root.committedAt : 0,
    mutations,
  }
}

/** Fold commits onto a checkpoint state, in place. */
export function applyCommits(state: DurabilityState, commits: readonly DurabilityCommit[]): void {
  for (const commit of commits) {
    for (const mutation of commit.mutations) {
      const db = state.dbs[mutation.database]
      if (!db) continue
      // A table added after the checkpoint (a plugin's runtime table, one a
      // schema upgrade created) joins the state with its first commit;
      // skipping it dropped every row written there since the checkpoint.
      let table = db.rows[mutation.table]
      if (!table) {
        table = db.rows[mutation.table] = {}
        if (!db.schema.tables.includes(mutation.table))
          db.schema.tables = [...db.schema.tables, mutation.table].sort()
      }
      if (mutation.value === null) delete table[mutation.key]
      else table[mutation.key] = mutation.value
    }
    state.sequence = commit.sequence
  }
}

export interface JournalBackendOptions {
  root: string
}

/**
 * Open the journal backend rooted at `opts.root`.
 *
 * Opening does **not** replay — `load()` does, so a caller can construct the
 * backend and decide how to handle a fault (the `durability` CLI stages a
 * recovery instead of crashing the brain).
 */
export function openJournalBackend(opts: JournalBackendOptions): HeadlessDurabilityBackend {
  const { root } = opts
  let generation = latestGeneration(root)
  let descriptor: number | null = null
  let sequence = 0
  let loaded = false
  /** The append target predates value codec 1 (see `DurabilityState.legacyValueCodec`). */
  let legacyGeneration = false

  function ensureJournalOpen(): number {
    if (descriptor !== null) return descriptor
    if (!generation) {
      throw new DurabilityFault(
        "checkpoint-corrupt",
        "journal backend has no checkpoint generation to append against"
      )
    }
    fs.mkdirSync(journalDir(root), { recursive: true, mode: 0o700 })
    descriptor = fs.openSync(journalFile(root, generation), "a", 0o600)
    return descriptor
  }

  async function load(): Promise<DurabilityState> {
    if (!generation) {
      loaded = true
      sequence = 0
      return emptyDurabilityState()
    }
    const report = new LegacyValueReport()
    const state = readCheckpoint(root, generation, report)
    const file = journalFile(root, generation)
    if (fs.existsSync(file)) {
      const { commits } = replayJournal(fs.readFileSync(file, "utf8"), state.sequence, report)
      applyCommits(state, commits)
    }
    sequence = state.sequence
    loaded = true
    legacyGeneration = state.legacyValueCodec === true
    const findings = report.findings()
    if (findings.length > 0) state.legacyValueFindings = findings
    return state
  }

  function commitSync(commit: DurabilityCommit): void {
    if (!loaded) {
      throw new DurabilityFault(
        "journal-sequence-gap",
        "journal backend received a commit before load() established the sequence"
      )
    }
    if (commit.sequence !== sequence + 1) {
      throw new DurabilityFault(
        "journal-sequence-gap",
        `journal expected sequence ${sequence + 1} but was handed ${commit.sequence}`,
        sequence + 1
      )
    }
    if (legacyGeneration) {
      throw new DurabilityFault(
        "checkpoint-schema-mismatch",
        `generation ${String(generation)} predates value codec 1; it must be compacted into a ` +
          "current generation before the journal appends to it, or an older build would replay " +
          "codec-1 lines without decoding them",
        commit.sequence
      )
    }
    const fd = ensureJournalOpen()
    const line = Buffer.from(encodeCommitLine(commit), "utf8")
    let written = 0
    while (written < line.length) {
      written += fs.writeSync(fd, line, written, line.length - written)
    }
    fs.fsyncSync(fd)
    sequence = commit.sequence
  }

  return {
    id: "journal-v4",
    load,
    commitSync,
    async commit(commit) {
      commitSync(commit)
    },
    lastSequence: () => sequence,
    async compact(state: DurabilityState): Promise<CompactionResult> {
      const previousGeneration = generation
      const target = nextGeneration(root)
      // `state.sequence` — not the backend's own counter — is authoritative:
      // during a migration this backend is the *target* and was never loaded,
      // so its counter is 0 while the incoming state may be at any sequence.
      writeCheckpoint(root, target, state)
      // Verify the new generation is readable *before* it becomes the append
      // target; a compaction that cannot be read back is not a checkpoint.
      const verified = readCheckpoint(root, target)
      if (verified.sequence !== state.sequence) {
        throw new DurabilityFault(
          "checkpoint-corrupt",
          `compaction wrote sequence ${verified.sequence} but the state is at ${state.sequence}`,
          state.sequence
        )
      }
      if (descriptor !== null) {
        fs.closeSync(descriptor)
        descriptor = null
      }
      generation = target
      sequence = state.sequence
      loaded = true
      legacyGeneration = false
      return { generation: target, previousGeneration, sequence }
    },
    async close() {
      if (descriptor !== null) {
        fs.closeSync(descriptor)
        descriptor = null
      }
    },
  }
}

/**
 * Seed the immutable generation a journal appends against.
 *
 * Idempotent: when a generation already exists the caller's state is ignored and
 * the existing generation id is returned, so a restart never re-seeds over live
 * data.
 */
export function seedCheckpoint(root: string, state: DurabilityState): string {
  const existing = latestGeneration(root)
  if (existing) return existing
  return writeCheckpoint(root, nextGeneration(root), state)
}
