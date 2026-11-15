/**
 * The operations behind `cognia-agent durability …`.
 *
 * One invariant governs all of them: **no tool overwrites the only valid
 * generation.** Every operation adds — a generation, a rollback bundle, a
 * manifest revision — and the generation-pruning operation (`finalize`)
 * requires an explicit confirmation flag and reports the watermark it leaves
 * behind.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { backendHeldByUnpinnedRoot, inspectDurabilityRoot, openBackend } from "./backend"
import {
  activateGeneration,
  cleanupCheckpointStaging,
  isStagedGeneration,
  formatGeneration,
  generationDir,
  latestGeneration,
  listGenerations,
  parseGeneration,
  readCheckpoint,
  writeCheckpoint,
} from "./checkpoint"
import { journalFile, replayJournal, applyCommits, collectJournalBinaryReferences } from "./journal"
import { acquireWriterLease } from "./writer-lock"
import {
  defaultManifest,
  manifestFile,
  readManifest,
  writeManifest,
  type BackendManifest,
} from "./manifest"
import { formatParityReport, verifyParity, type ParityReport } from "./parity"
import {
  binaryDir,
  collectBinaryReferences,
  pinBinaryReferences,
  pruneBinaries,
  readBinarySync,
} from "./binary-store"
import {
  decodeSnapshotRows,
  parseMultiSnapshot,
  selectSnapshotRestoreTables,
  snapshotRowsForTable,
} from "../../db/snapshot"
import { collectSqliteBinaryReferences, readSqliteState, sqliteFile } from "./sqlite"
import { decodeDurableValue } from "./value-codec"
import {
  DurabilityFault,
  emptyDurabilityState,
  isDurabilityBackendId,
  type DurabilityBackendId,
  type DurabilityState,
} from "./types"

export type RecoverySource = "auto" | "snapshot" | "journal" | "sqlite"

export interface DurabilityStatus {
  root: string
  manifest: BackendManifest
  generations: string[]
  latestGeneration: string | null
  checkpointSequence: number | null
  journalCommits: number
  journalSequence: number | null
  journalDiscardedBytes: number
  sqlitePresent: boolean
  sqliteSequence: number | null
  faults: Array<{ code: string; message: string; sequence: number | null }>
  parity: ParityReport | null
  /** Snapshot tables restore ignores because they are derived or no longer installed. */
  skippedSnapshotTables: Array<{ database: string; table: string }>
  snapshotRoot?: string
}

function recordFault(status: DurabilityStatus, error: unknown): void {
  if (error instanceof DurabilityFault) {
    status.faults.push({ code: error.code, message: error.message, sequence: error.sequence })
    return
  }
  status.faults.push({
    code: "manifest-corrupt",
    message: error instanceof Error ? error.message : String(error),
    sequence: null,
  })
}

/**
 * Inspect an account's durability state without changing a byte.
 *
 * Every probe is independently faulted so one broken store still yields a full
 * report — an operator choosing a recovery source needs to see *all* the
 * options, including the ones that are damaged.
 */
export async function verifyDurability(root: string): Promise<DurabilityStatus> {
  const status: DurabilityStatus = {
    root,
    manifest: defaultManifest(),
    generations: [],
    latestGeneration: null,
    checkpointSequence: null,
    journalCommits: 0,
    journalSequence: null,
    journalDiscardedBytes: 0,
    sqlitePresent: fs.existsSync(sqliteFile(root)),
    sqliteSequence: null,
    faults: [],
    parity: null,
    skippedSnapshotTables: [],
  }
  try {
    if (!fs.existsSync(root)) {
      throw new DurabilityFault("manifest-corrupt", `durability root does not exist: ${root}`)
    }
    if (fs.statSync(root).isFile()) {
      status.manifest.activeBackend = "snapshot-v3"
      status.snapshotRoot = root
      await verifySnapshotFile(root, status.skippedSnapshotTables)
      return status
    }
    if (!fs.statSync(root).isDirectory()) {
      throw new DurabilityFault("manifest-corrupt", `invalid durability root: ${root}`)
    }
    const ledger = [
      manifestFile(root),
      path.join(root, "generations"),
      path.join(root, "sqlite"),
    ].some((file) => fs.existsSync(file))
    if (
      !ledger &&
      (path.basename(root).endsWith(".json.tables") ||
        fs.existsSync(path.join(root, "manifest.json")))
    ) {
      status.manifest.activeBackend = "snapshot-v3"
      status.snapshotRoot = root
      await verifySnapshotTables(root, status.skippedSnapshotTables)
      return status
    }
    status.manifest = readManifest(root)
    const inventory = inspectDurabilityRoot(root)
    const held = backendHeldByUnpinnedRoot(inventory)
    if (held) status.manifest.activeBackend = held
    if (inventory.manifest) {
      for (const backend of [status.manifest.activeBackend, status.manifest.shadowBackend]) {
        if (!backend) continue
        const generation = latestGeneration(root, status.manifest)
        let present: boolean
        if (backend === "snapshot-v3" && backend === status.manifest.activeBackend) {
          // serve's snapshot backend owns a sibling table store, whereas a
          // snapshot shadow is the checkpoint half of the journal backend.
          const home = path.dirname(path.dirname(root))
          const account = decodeURIComponent(path.basename(root))
          const snapshot = path.join(home, `db-${account}.json`)
          status.snapshotRoot = fs.existsSync(`${snapshot}.tables/manifest.json`)
            ? `${snapshot}.tables`
            : snapshot
          if (status.snapshotRoot === snapshot)
            await verifySnapshotFile(snapshot, status.skippedSnapshotTables)
          else await verifySnapshotTables(status.snapshotRoot, status.skippedSnapshotTables)
          present = true
        } else {
          present =
            backend === "sqlite-v5"
              ? inventory.sqlite
              : generation !== null && listGenerations(root).includes(generation)
        }
        if (!present)
          recordFault(
            status,
            new DurabilityFault("manifest-corrupt", `manifest backend ${backend} is missing`)
          )
      }
    }
  } catch (error) {
    recordFault(status, error)
  }

  let journalState: DurabilityState | null = null
  try {
    status.generations = listGenerations(root)
    status.latestGeneration = latestGeneration(root, status.manifest)
    for (const generation of status.generations) {
      try {
        const checkpoint = readCheckpoint(root, generation)
        assertDecodable(root, checkpoint)
        const checkpointSequence = checkpoint.sequence
        const file = journalFile(root, generation)
        const replay = fs.existsSync(file)
          ? replayJournal(fs.readFileSync(file, "utf8"), checkpoint.sequence)
          : { commits: [], discardedBytes: 0 }
        for (const commit of replay.commits) decodeDurableValue(commit.mutations, root)
        applyCommits(checkpoint, replay.commits)
        if (generation === status.latestGeneration) {
          status.checkpointSequence = checkpointSequence
          status.journalCommits = replay.commits.length
          status.journalDiscardedBytes = replay.discardedBytes
          status.journalSequence = checkpoint.sequence
          journalState = checkpoint
        }
      } catch (error) {
        recordFault(status, error)
      }
    }
  } catch (error) {
    recordFault(status, error)
  }

  let sqliteState: DurabilityState | null = null
  if (status.sqlitePresent) {
    try {
      // SQLite can create WAL/SHM files even for a read-only connection. Read
      // an exact disposable copy so verify never changes the operator's root.
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-verify-"))
      try {
        const file = sqliteFile(temporary)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.copyFileSync(sqliteFile(root), file)
        for (const suffix of ["-wal", "-journal"]) {
          if (fs.existsSync(`${sqliteFile(root)}${suffix}`))
            fs.copyFileSync(`${sqliteFile(root)}${suffix}`, `${file}${suffix}`)
        }
        sqliteState = readSqliteState(temporary)
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true })
      }
      assertDecodable(root, sqliteState)
      status.sqliteSequence = sqliteState.sequence
    } catch (error) {
      recordFault(status, error)
    }
  }

  const compatibilityWindow =
    !fs.existsSync(manifestFile(root)) || status.manifest.shadowBackend !== null
  if (journalState && sqliteState && compatibilityWindow) {
    status.parity = verifyParity(journalState, sqliteState)
    if (!status.parity.ok) {
      status.faults.push({
        code: "parity-mismatch",
        message: formatParityReport(status.parity),
        sequence: null,
      })
    }
  }

  return status
}

/** The snapshot-v3 rung uses bootstrap's table layout and the shared value codec. */
async function verifySnapshotTables(
  root: string,
  skipped: DurabilityStatus["skippedSnapshotTables"]
): Promise<void> {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))
  } catch (error) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `invalid snapshot-v3 manifest: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (
    !manifest ||
    manifest.snapshotFormat !== 4 ||
    !manifest.dbs ||
    typeof manifest.dbs !== "object" ||
    Array.isArray(manifest.dbs)
  )
    throw new DurabilityFault("manifest-corrupt", "invalid snapshot-v3 table manifest")
  const verifyRows = await snapshotRowVerifier(skipped)
  try {
    for (const [database, raw] of Object.entries(manifest.dbs)) {
      const schema = raw as { version?: unknown; tables?: unknown } | null
      if (
        !schema ||
        typeof schema.version !== "number" ||
        !Number.isFinite(schema.version) ||
        !Array.isArray(schema.tables) ||
        schema.tables.some((name: unknown) => typeof name !== "string")
      )
        throw new DurabilityFault("manifest-corrupt", `invalid snapshot-v3 schema: ${database}`)
      for (const table of verifyRows.selectTables(database, schema.tables as string[])) {
        const file = path.join(
          root,
          `${encodeURIComponent(database)}--${encodeURIComponent(table)}.json`
        )
        const rows: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
        const decoded = decodeSnapshotRows(rows, {
          read: (reference, length) => readBinarySync(root, reference, length),
        })
        await verifyRows.check(database, table, decoded)
      }
    }
    verifyRows.assertRestorable()
  } finally {
    await verifyRows.close()
  }
}

async function verifySnapshotFile(
  file: string,
  skipped: DurabilityStatus["skippedSnapshotTables"]
): Promise<void> {
  const parsed = parseMultiSnapshot(fs.readFileSync(file, "utf8"))
  if (parsed.kind !== "valid") {
    throw new DurabilityFault(
      "manifest-corrupt",
      `invalid snapshot-v3 file: ${parsed.kind === "absent" ? "absent" : parsed.reason}`
    )
  }
  const verifyRows = await snapshotRowVerifier(skipped)
  try {
    for (const [database, snapshot] of Object.entries(parsed.snapshot.dbs)) {
      for (const table of verifyRows.selectTables(database, Object.keys(snapshot.tables))) {
        await verifyRows.check(database, table, decodeSnapshotRows(snapshot.tables[table]))
      }
    }
    verifyRows.assertRestorable()
  } finally {
    await verifyRows.close()
  }
}

/** Use restore's actual schemas and IndexedDB constraints, without opening any account database. */
async function snapshotRowVerifier(skipped: DurabilityStatus["skippedSnapshotTables"]) {
  const [
    { default: Dexie },
    { IDBFactory, IDBKeyRange },
    { CURRENT_SCHEMA },
    { getBrowserBuiltinRegistry },
    { toNamespacedTableName },
  ] = await Promise.all([
    import("dexie"),
    import("fake-indexeddb"),
    import("@/lib/db/schema"),
    import("@/lib/plugin/core/browser-builtin-registry"),
    import("@/lib/plugin/dexie/namespace"),
  ])
  const schemas = { ...CURRENT_SCHEMA }
  for (const { manifest } of getBrowserBuiltinRegistry()) {
    for (const table of manifest.dexie?.tables ?? []) {
      schemas[toNamespacedTableName(manifest.id, table.name)] = table.schema
    }
  }
  // A private factory cannot reach the caller's IndexedDB, even in a long-lived CLI process.
  const db = new Dexie("snapshot-verify", { indexedDB: new IDBFactory(), IDBKeyRange })
  db.version(1).stores(schemas)
  const schemaTableNames = new Set(db.tables.map((table) => table.name))
  let offered = 0
  let restorable = 0
  return {
    selectTables(database: string, tableNames: string[]) {
      const targets = selectSnapshotRestoreTables(tableNames, schemaTableNames)
      const selected = new Set(targets)
      for (const table of tableNames) {
        if (!selected.has(table)) skipped.push({ database, table })
      }
      offered += tableNames.length
      restorable += targets.length
      return targets
    },
    /** A snapshot whose every table restore would skip restores nothing; it is not a verified backup. */
    assertRestorable() {
      if (offered > 0 && restorable === 0)
        throw new DurabilityFault(
          "manifest-corrupt",
          `snapshot holds ${offered} table(s), but restore would load none of them`
        )
    },
    async check(database: string, table: string, rows: unknown[]) {
      try {
        const target = db.table(table)
        const authoritative = snapshotRowsForTable(table, rows)
        if (authoritative.length > 0) await target.bulkPut(authoritative)
        // Keep only the current table in memory; no whole-database restore accumulates here.
        await target.clear()
      } catch (error) {
        throw new DurabilityFault(
          "manifest-corrupt",
          `snapshot rows for ${database}.${table} cannot be restored: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    close: () => db.delete(),
  }
}

function assertDecodable(root: string, state: DurabilityState): void {
  for (const entry of Object.values(state.dbs)) {
    for (const rows of Object.values(entry.rows)) {
      for (const value of Object.values(rows)) decodeDurableValue(value, root)
    }
  }
}

/** Materialise the journal stack (checkpoint + replay). */
export function readJournalState(
  root: string,
  generation = latestGeneration(root)
): DurabilityState {
  if (!generation) return emptyDurabilityState()
  const state = readCheckpoint(root, generation)
  assertDecodable(root, state)
  const file = journalFile(root, generation)
  if (fs.existsSync(file)) {
    const { commits } = replayJournal(fs.readFileSync(file, "utf8"), state.sequence)
    for (const commit of commits) decodeDurableValue(commit.mutations, root)
    applyCommits(state, commits)
  }
  return state
}

// ── rollback bundles ────────────────────────────────────────────────────────

export function rollbackDir(root: string): string {
  return path.join(root, "rollback")
}

export interface RollbackBundle {
  id: string
  createdAt: number
  reason: string
  manifest: BackendManifest
  generation: string | null
  sequence: number
}

/**
 * Freeze the pre-change state so any migration can be undone.
 *
 * The bundle records the manifest and the generation/sequence in force at the
 * time; the generation itself is never deleted, so restoring the bundle is a
 * pure manifest rewrite.
 */
export function writeRollbackBundle(root: string, reason: string, now = Date.now): RollbackBundle {
  const dir = rollbackDir(root)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const existing = fs
    .readdirSync(dir)
    .filter((name) => /^bundle-\d{4,}\.json$/.test(name))
    .sort()
  const index = existing.length + 1
  const id = `bundle-${String(index).padStart(4, "0")}`
  const generation =
    listGenerations(root)
      .reverse()
      .find((candidate) => {
        try {
          assertDecodable(root, readCheckpoint(root, candidate))
          return !isStagedGeneration(root, candidate)
        } catch {
          return false
        }
      }) ?? null
  const bundle: RollbackBundle = {
    id,
    createdAt: now(),
    reason,
    manifest: readManifest(root),
    generation,
    sequence: generation ? readCheckpoint(root, generation).sequence : 0,
  }
  const file = path.join(dir, `${id}.json`)
  const descriptor = fs.openSync(file, "wx", 0o400)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(bundle), "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  return bundle
}

export function listRollbackBundles(root: string): RollbackBundle[] {
  const dir = rollbackDir(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => /^bundle-\d{4,}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RollbackBundle)
}

// ── migrate ─────────────────────────────────────────────────────────────────

export interface MigrateResult {
  from: DurabilityBackendId
  to: DurabilityBackendId
  bundle: RollbackBundle
  parity: ParityReport
  promoted: boolean
}

/**
 * Migrate an account onto `to`.
 *
 * Sequence: rollback bundle → copy the incumbent's state into the target →
 * parity gate → atomic manifest promotion. A failed parity check leaves the
 * manifest untouched and the incumbent authoritative; the half-built target
 * stays on disk for inspection and is simply rebuilt on the next attempt.
 */
export interface MigrateOptions {
  now?: () => number
  /**
   * Parity verifier seam. Production always uses {@link verifyParity}; tests
   * substitute it to exercise the refuse-to-promote path without having to
   * manufacture a real backend divergence.
   */
  verify?: (source: DurabilityState, candidate: DurabilityState) => ParityReport
}

export async function migrateDurability(
  root: string,
  to: DurabilityBackendId,
  opts: MigrateOptions = {}
): Promise<MigrateResult> {
  const now = opts.now ?? Date.now
  const verify = opts.verify ?? verifyParity
  const manifest = readManifest(root)
  const inventory = inspectDurabilityRoot(root)
  const pinned = inventory.manifest
  const held = backendHeldByUnpinnedRoot(inventory)
  if (held) manifest.activeBackend = held
  if (manifest.activeBackend === to) {
    if (pinned || held === "sqlite-v5") {
      throw new DurabilityFault("parity-mismatch", `account is already on ${to}`)
    }
    // Existing journal data already selects journal-v4. Pin that choice so
    // later boots no longer need to infer it from the inventory.
    writeManifest(root, { ...manifest, activeBackend: to, shadowBackend: null }, now)
    return {
      from: manifest.activeBackend,
      to,
      bundle: writeRollbackBundle(root, `pin ${to}`, now),
      parity: { ok: true, mismatches: [], comparedRows: 0 },
      promoted: true,
    }
  }
  const bundle = writeRollbackBundle(root, `migrate ${manifest.activeBackend} -> ${to}`, now)

  const sourceBackend = openBackend(manifest.activeBackend, root)
  let sourceState: DurabilityState
  try {
    sourceState = await sourceBackend.load()
    assertDecodable(root, sourceState)
  } finally {
    await sourceBackend.close()
  }

  const targetBackend = openBackend(to, root)
  let parity: ParityReport
  try {
    await targetBackend.compact(sourceState)
    const targetState = await targetBackend.load()
    parity = verify(sourceState, targetState)
  } finally {
    await targetBackend.close()
  }

  if (!parity.ok) {
    return { from: manifest.activeBackend, to, bundle, parity, promoted: false }
  }

  writeManifest(
    root,
    {
      ...readManifest(root),
      activeBackend: to,
      // Keep the incumbent live as the shadow: the compatibility window is what
      // makes `rollback` a manifest rewrite instead of a restore.
      shadowBackend: manifest.activeBackend,
      rollbackWatermark: manifest.rollbackWatermark ?? bundle.generation,
    },
    now
  )
  return { from: manifest.activeBackend, to, bundle, parity, promoted: true }
}

// ── recover ─────────────────────────────────────────────────────────────────

export interface RecoverResult {
  source: Exclude<RecoverySource, "auto">
  /** Generation the recovered state was staged into. */
  generation: string
  sequence: number
  activated: boolean
  parity: ParityReport
}

/**
 * Stage a recovered state into a **new** generation, verify it, and optionally
 * activate it.
 *
 * `auto` prefers the source that yields the highest verified sequence, which is
 * the only ordering that cannot lose committed work: a damaged journal that
 * replays to sequence 40 loses less than a pristine checkpoint at sequence 12.
 */
export async function recoverDurability(
  root: string,
  from: RecoverySource,
  opts: { activate?: boolean; now?: () => number } = {}
): Promise<RecoverResult> {
  const now = opts.now ?? Date.now
  let releaseSqlite: (() => void) | undefined
  let releaseJournal: (() => void) | undefined
  let releaseBinaries: (() => void) | undefined
  try {
    if (opts.activate) {
      releaseSqlite = acquireWriterLease(root, "sqlite")
      releaseJournal = acquireWriterLease(root, "journal")
    }
    // Protect the read itself, before the selected candidate's hashes are known.
    let pins: Set<string> | null = null
    releaseBinaries = pinBinaryReferences(root, () => pins)
    const candidates = await collectRecoveryCandidates(root, from)
    if (candidates.length === 0) {
      throw new DurabilityFault("checkpoint-corrupt", "no readable recovery source was found")
    }
    candidates.sort((a, b) => b.state.sequence - a.state.sequence)
    const chosen = candidates[0]
    pins = collectBinaryReferences(chosen.state.dbs, new Set<string>())

    const inventory = inspectDurabilityRoot(root)
    if (
      !opts.activate &&
      !inventory.manifest &&
      inventory.sqlite &&
      !inventory.journal &&
      !inventory.stagedJournal
    ) {
      // Pin the incumbent before adding staged journal data so the next boot
      // still selects SQLite instead of refusing an ambiguous unpinned root.
      const release = acquireWriterLease(root, "sqlite")
      try {
        const current = inspectDurabilityRoot(root)
        if (!current.manifest && backendHeldByUnpinnedRoot(current) === "sqlite-v5") {
          writeManifest(root, { ...readManifest(root), activeBackend: "sqlite-v5" }, now)
        }
      } finally {
        release()
      }
    }

    const generation = writeCheckpoint(root, null, chosen.state, { staged: true })
    const staged = readCheckpoint(root, generation)
    assertDecodable(root, staged)
    const parity = verifyParity(chosen.state, staged)
    if (!parity.ok) {
      throw new DurabilityFault(
        "parity-mismatch",
        `staged generation ${generation} does not match the recovered state:\n${formatParityReport(parity)}`
      )
    }

    let activated = false
    if (opts.activate) {
      writeRollbackBundle(root, `recover ${chosen.source} -> ${generation}`, now)
      activateGeneration(root, generation, now)
      activated = true
    }

    return { source: chosen.source, generation, sequence: staged.sequence, activated, parity }
  } finally {
    try {
      releaseJournal?.()
    } finally {
      try {
        releaseSqlite?.()
      } finally {
        releaseBinaries?.()
      }
    }
  }
}

async function collectRecoveryCandidates(
  root: string,
  from: RecoverySource
): Promise<Array<{ source: Exclude<RecoverySource, "auto">; state: DurabilityState }>> {
  const wanted = (source: Exclude<RecoverySource, "auto">): boolean =>
    from === "auto" || from === source
  const out: Array<{ source: Exclude<RecoverySource, "auto">; state: DurabilityState }> = []

  const generations =
    from === "auto"
      ? listGenerations(root).reverse()
      : [latestGeneration(root)].filter((generation): generation is string => generation !== null)
  for (const generation of generations) {
    if (wanted("snapshot")) {
      try {
        const state = readCheckpoint(root, generation)
        assertDecodable(root, state)
        out.push({ source: "snapshot", state })
      } catch (error) {
        if (from !== "auto") throw error
      }
    }
    if (wanted("journal")) {
      try {
        const state = readJournalState(root, generation)
        assertDecodable(root, state)
        out.push({ source: "journal", state })
      } catch (error) {
        if (from !== "auto") throw error
      }
    }
  }
  if (wanted("sqlite") && fs.existsSync(sqliteFile(root))) {
    try {
      const state = readSqliteState(root)
      assertDecodable(root, state)
      out.push({ source: "sqlite", state })
    } catch (error) {
      if (from !== "auto") throw error
    }
  }
  return out
}

// ── rollback ────────────────────────────────────────────────────────────────

export interface RollbackResult {
  generation: string
  sequence: number
  manifest: BackendManifest
}

/**
 * Point the account back at an existing generation.
 *
 * Purely additive: the generation is already on disk (nothing deletes them),
 * so rollback is a bundle + a manifest rewrite. Journal records written after
 * that generation stay in their own file and are simply no longer replayed.
 */
export function rollbackDurability(
  root: string,
  generation: string,
  now = Date.now
): RollbackResult {
  if (parseGeneration(generation) === null) {
    throw new DurabilityFault("checkpoint-corrupt", `"${generation}" is not a generation id`)
  }
  if (!fs.existsSync(path.join(generationDir(root, generation), "checkpoint.json"))) {
    throw new DurabilityFault("checkpoint-corrupt", `generation ${generation} is not on disk`)
  }
  const releaseSqlite = acquireWriterLease(root, "sqlite")
  let releaseJournal: (() => void) | undefined
  try {
    releaseJournal = acquireWriterLease(root, "journal")
    const state = readCheckpoint(root, generation)
    writeRollbackBundle(root, `rollback -> ${generation}`, now)

    // Re-cut the target as the newest generation so the journal appends against
    // it: generations are immutable, and re-opening an older one for append would
    // interleave two histories in a single file.
    const target = writeCheckpoint(root, null, state, { writer: true, staged: true })

    const manifest = readManifest(root)
    const next: BackendManifest = {
      ...manifest,
      activeBackend: "journal-v4",
      journalGeneration: target,
      shadowBackend: null,
      rollbackWatermark: manifest.rollbackWatermark,
    }
    writeManifest(root, next, now)
    return { generation: target, sequence: state.sequence, manifest: next }
  } finally {
    try {
      releaseJournal?.()
    } finally {
      releaseSqlite()
    }
  }
}

// ── finalize ────────────────────────────────────────────────────────────────

export interface FinalizeResult {
  keptGenerations: string[]
  prunedGenerations: string[]
  /** Unreferenced binary side files removed (`binary-store.ts`). */
  prunedBinaries: string[]
  rollbackWatermark: string
  manifest: BackendManifest
}

/**
 * End a compatibility window: drop the shadow backend and prune generations
 * strictly older than `generation`.
 *
 * The named generation itself is always kept — it becomes the new rollback
 * watermark, and a finalize that left nothing to roll back to would defeat the
 * purpose of the ladder.
 */
export function finalizeDurability(
  root: string,
  generation: string,
  opts: { confirm: boolean; now?: () => number }
): FinalizeResult {
  const now = opts.now ?? Date.now
  if (!opts.confirm) {
    throw new DurabilityFault(
      "parity-mismatch",
      "finalize discards rollback generations and requires --confirm"
    )
  }
  const index = parseGeneration(generation)
  if (index === null) {
    throw new DurabilityFault("checkpoint-corrupt", `"${generation}" is not a generation id`)
  }
  const release = acquireWriterLease(root, "journal")
  let releaseBinaries: (() => void) | undefined
  try {
    if (fs.existsSync(binaryDir(root)))
      releaseBinaries = acquireWriterLease(root, "binary", { shared: true })
    const all = listGenerations(root)
    if (!all.includes(generation)) {
      throw new DurabilityFault("checkpoint-corrupt", `generation ${generation} is not on disk`)
    }
    const manifest = readManifest(root)
    const kept = all.filter((candidate) => (parseGeneration(candidate) ?? 0) >= index)
    if (isStagedGeneration(root, generation)) {
      throw new DurabilityFault(
        "checkpoint-corrupt",
        `generation ${generation} is staged; activate it before finalize`
      )
    }
    // All validation and reference discovery precedes the first destructive step.
    // Check the checkpoint itself as well as the replayed view: rollback still
    // needs a binary even when a later journal commit deleted its row.
    for (const candidate of kept) {
      assertDecodable(root, readCheckpoint(root, candidate))
      const file = journalFile(root, candidate)
      if (fs.existsSync(file)) {
        const checkpoint = readCheckpoint(root, candidate)
        const replay = replayJournal(fs.readFileSync(file, "utf8"), checkpoint.sequence)
        for (const commit of replay.commits) decodeDurableValue(commit.mutations, root)
      }
    }
    const references = collectJournalBinaryReferences(root, new Set<string>(), kept)
    collectSqliteBinaryReferences(root, references)
    if (fs.existsSync(sqliteFile(root))) assertDecodable(root, readSqliteState(root))
    const next: BackendManifest = {
      ...manifest,
      shadowBackend: null,
      rollbackWatermark: generation,
    }
    writeManifest(root, next, now)
    const pruned: string[] = []
    for (const candidate of all) {
      if ((parseGeneration(candidate) ?? 0) >= index) continue
      fs.rmSync(generationDir(root, candidate), { recursive: true, force: true })
      fs.rmSync(journalFile(root, candidate), { force: true })
      pruned.push(candidate)
    }
    const prunedBinaries = pruneBinaries(root, references, now())
    cleanupCheckpointStaging(root)
    return {
      keptGenerations: kept,
      prunedGenerations: pruned,
      prunedBinaries,
      rollbackWatermark: generation,
      manifest: next,
    }
  } finally {
    try {
      releaseBinaries?.()
    } finally {
      release()
    }
  }
}

/**
 * The documented spellings of a `--to` backend argument, mapped onto ids.
 * `journal` / `sqlite` are what the help text and the docs say. The ids are
 * accepted too so a script that pasted one from a manifest still works.
 */
const BACKEND_ARGUMENT_ALIASES: Readonly<Record<string, DurabilityBackendId>> = Object.freeze({
  journal: "journal-v4",
  sqlite: "sqlite-v5",
  snapshot: "snapshot-v3",
})

/**
 * Shared by the CLI: parse a `--to` backend argument.
 *
 * One parser, one accepted set. `durability-command.ts` used to carry its own
 * copy that accepted the aliases while this one accepted only the ids, so the
 * two disagreed about what `--to` meant and this one had no caller at all.
 */
export function parseBackendArgument(value: string | undefined): DurabilityBackendId {
  const aliased = value === undefined ? undefined : BACKEND_ARGUMENT_ALIASES[value]
  if (aliased) return aliased
  if (!isDurabilityBackendId(value)) {
    throw new DurabilityFault(
      "manifest-corrupt",
      `--to must be journal or sqlite (or a backend id: journal-v4, sqlite-v5, snapshot-v3; got ${String(value ?? "nothing")})`
    )
  }
  return value
}

/** Shared by the CLI: the generation a fresh account would create first. */
export function firstGeneration(): string {
  return formatGeneration(1)
}
