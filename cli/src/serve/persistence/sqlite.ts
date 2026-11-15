/**
 * `sqlite-v5` — Node's built-in SQLite as the headless durability store.
 *
 * Deliberately **generic**: three tables holding database/table/key/value rows
 * (`durability_rows_codec1`) plus commit sequence and schema metadata. Mirroring the Dexie schema into
 * SQL would create a second hand-maintained Cognia schema that drifts on every
 * Dexie version bump — the exact failure ADR-0059 D3 rejects.
 *
 * Durability posture: WAL + `synchronous=FULL` so a returned `COMMIT` survives
 * process *and* OS loss, `foreign_keys=ON` so a row can never outlive its
 * schema row, and `integrity_check` on open so corruption surfaces as a typed
 * fault instead of as missing rows. The database directory is `0700` and every
 * SQLite file in it is `0600`.
 */
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  BINARY_PRUNE_GRACE_MS,
  binaryDir,
  collectBinaryReferences,
  pruneBinaries,
} from "./binary-store"
import { collectJournalBinaryReferences } from "./journal"
import { cleanupCheckpointStaging } from "./checkpoint"
import { acquireWriterLease } from "./writer-lock"
import { canonicalJson } from "./canonical"
import { VALUE_CODEC } from "./value-codec"
import {
  DurabilityFault,
  type CompactionResult,
  type DurabilityCommit,
  type DurabilitySchema,
  type DurabilityState,
  type HeadlessDurabilityBackend,
} from "./types"

export function sqliteDir(root: string): string {
  return path.join(root, "sqlite")
}

export function sqliteFile(root: string): string {
  return path.join(sqliteDir(root), "store.sqlite")
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS durability_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS durability_schema (
  database TEXT PRIMARY KEY,
  version  INTEGER NOT NULL,
  tables   TEXT NOT NULL
) STRICT;

`

/**
 * Row values live in `durability_rows_codec1`, each marked with the value codec
 * it was written in. Only this build writes the table, so the marker cannot
 * disagree with the bytes.
 */
export const SQLITE_ROWS_TABLE = "durability_rows_codec1"

const ROWS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${SQLITE_ROWS_TABLE} (
  database    TEXT NOT NULL REFERENCES durability_schema(database) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,
  row_key     TEXT NOT NULL,
  value       TEXT NOT NULL,
  value_codec INTEGER NOT NULL,
  PRIMARY KEY (database, table_name, row_key)
) STRICT, WITHOUT ROWID;
`

/** The `node:sqlite` surface used here, narrowed so tests can substitute it. */
export interface SqliteDatabaseLike {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  close(): void
}

export interface SqliteBackendOptions {
  root: string
  /** Injected database factory (tests). */
  open?: (file: string) => SqliteDatabaseLike
}

function defaultOpen(file: string): SqliteDatabaseLike {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file) as unknown as SqliteDatabaseLike
  try {
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA synchronous = FULL;")
    db.exec("PRAGMA foreign_keys = ON;")
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function restrictPermissions(file: string): void {
  if (process.platform === "win32") return
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600)
    } catch {
      // Permission tightening is best-effort on exotic filesystems; the parent
      // directory is already 0700, which is the boundary that matters.
    }
  }
}

/** Run `PRAGMA integrity_check` and raise a typed fault on anything but `ok`. */
export function assertIntegrity(db: SqliteDatabaseLike): void {
  const rows = db.prepare("PRAGMA integrity_check;").all() as Array<Record<string, unknown>>
  const verdicts = rows.map((row) => String(Object.values(row)[0] ?? "")).filter(Boolean)
  if (verdicts.length !== 1 || verdicts[0] !== "ok") {
    throw new DurabilityFault(
      "sqlite-integrity-failure",
      `sqlite integrity_check reported: ${verdicts.join("; ") || "no result"}`
    )
  }
}

export interface SqliteMaintenanceResult {
  busy: boolean
  logFrames: number
  checkpointedFrames: number
  prunedBinaries: string[]
}

export function openSqliteBackend(
  opts: SqliteBackendOptions
): Omit<HeadlessDurabilityBackend, "maintain"> & { maintain(): SqliteMaintenanceResult } {
  const file = sqliteFile(opts.root)
  // Injected databases have no on-disk store to own.
  const release = opts.open ? () => {} : acquireWriterLease(opts.root, "sqlite", { shared: true })
  let opened: SqliteDatabaseLike | undefined
  try {
    opened = (opts.open ?? defaultOpen)(file)
    opened.exec(SCHEMA_SQL)
    assertIntegrity(opened)
    opened.exec(ROWS_TABLE_SQL)
    restrictPermissions(file)
  } catch (error) {
    try {
      opened?.close()
    } finally {
      release()
    }
    throw error
  }
  const db = opened

  const selectSequence = db.prepare("SELECT value FROM durability_meta WHERE key = 'sequence'")
  const upsertSequence = db.prepare(
    "INSERT INTO durability_meta (key, value) VALUES ('sequence', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
  const upsertSchema = db.prepare(
    "INSERT INTO durability_schema (database, version, tables) VALUES (?, ?, ?) " +
      "ON CONFLICT(database) DO UPDATE SET version = excluded.version, tables = excluded.tables"
  )
  const selectSchemaTables = db.prepare("SELECT tables FROM durability_schema WHERE database = ?")
  const updateSchemaTables = db.prepare(
    "UPDATE durability_schema SET tables = ? WHERE database = ?"
  )
  // Values arrive in codec-1 form (the store encodes them at the Dexie boundary).
  const upsertRow = db.prepare(
    `INSERT INTO ${SQLITE_ROWS_TABLE} (database, table_name, row_key, value, value_codec) ` +
      `VALUES (?, ?, ?, ?, ${VALUE_CODEC}) ` +
      "ON CONFLICT(database, table_name, row_key) DO UPDATE SET value = excluded.value, " +
      "value_codec = excluded.value_codec"
  )
  const deleteRow = db.prepare(
    `DELETE FROM ${SQLITE_ROWS_TABLE} WHERE database = ? AND table_name = ? AND row_key = ?`
  )

  function readSequence(): number {
    const row = selectSequence.get() as { value?: string } | undefined
    return row?.value ? Number(row.value) : 0
  }

  let sequence = readSequence()
  let closed = false

  function writeSchemas(state: DurabilityState): void {
    for (const [database, entry] of Object.entries(state.dbs)) {
      upsertSchema.run(
        database,
        entry.schema.version,
        canonicalJson([...entry.schema.tables].sort())
      )
    }
  }

  async function load(): Promise<DurabilityState> {
    return materializeSqlite(db, sequence)
  }

  /**
   * List every table a commit touches, as the journal's `applyCommits` does:
   * a table added after the schema row was written (a live upgrade, a plugin
   * table) is listed from its first commit, even one that only deletes, so the
   * two backends agree on the table set and a restart re-declares it.
   */
  function listTouchedTables(commit: DurabilityCommit): void {
    const touched = new Map<string, Set<string>>()
    for (const mutation of commit.mutations) {
      let tables = touched.get(mutation.database)
      if (!tables) touched.set(mutation.database, (tables = new Set()))
      tables.add(mutation.table)
    }
    for (const [database, tables] of touched) {
      const row = selectSchemaTables.get(database) as { tables?: string } | undefined
      if (!row) continue
      let listed: string[] = []
      try {
        const parsed: unknown = JSON.parse(String(row.tables))
        if (Array.isArray(parsed)) listed = parsed.filter((t): t is string => typeof t === "string")
      } catch {
        throw new DurabilityFault(
          "sqlite-integrity-failure",
          `sqlite schema row for ${database} has an unreadable table list`
        )
      }
      const missing = [...tables].filter((table) => !listed.includes(table))
      if (missing.length === 0) continue
      updateSchemaTables.run(canonicalJson([...listed, ...missing].sort()), database)
    }
  }

  function commitSync(commit: DurabilityCommit): void {
    if (closed) throw new DurabilityFault("sqlite-integrity-failure", "sqlite backend is closed")
    if (commit.sequence <= sequence) {
      // Idempotent redelivery during the dual-write window: the journal is the
      // ordering authority and may replay a sequence SQLite already holds.
      return
    }
    if (commit.sequence !== sequence + 1) {
      throw new DurabilityFault(
        "journal-sequence-gap",
        `sqlite expected sequence ${sequence + 1} but was handed ${commit.sequence}`,
        sequence + 1
      )
    }
    db.exec("BEGIN IMMEDIATE")
    try {
      listTouchedTables(commit)
      for (const mutation of commit.mutations) {
        if (mutation.value === null) {
          deleteRow.run(mutation.database, mutation.table, mutation.key)
        } else {
          upsertRow.run(
            mutation.database,
            mutation.table,
            mutation.key,
            canonicalJson(mutation.value)
          )
        }
      }
      upsertSequence.run(String(commit.sequence))
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    sequence = commit.sequence
  }

  /**
   * Replace SQLite's whole content with `state`, inside one transaction.
   *
   * Used by `durability migrate` to seed SQLite from the journal, and by
   * `compact` — SQLite has no journal to fold, so "compaction" is a verified
   * rewrite that also re-pins the schema rows.
   */
  function replaceAll(state: DurabilityState): void {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(`DELETE FROM ${SQLITE_ROWS_TABLE}`)
      db.exec("DELETE FROM durability_schema")
      writeSchemas(state)
      for (const [database, entry] of Object.entries(state.dbs)) {
        for (const [table, rows] of Object.entries(entry.rows)) {
          for (const [key, value] of Object.entries(rows)) {
            upsertRow.run(database, table, key, canonicalJson(value))
          }
        }
      }
      upsertSequence.run(String(state.sequence))
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    sequence = state.sequence
  }

  const backend: Omit<HeadlessDurabilityBackend, "maintain"> & {
    replaceAll(state: DurabilityState): void
    maintain(): SqliteMaintenanceResult
  } = {
    id: "sqlite-v5",
    load,
    commitSync,
    async commit(commit) {
      commitSync(commit)
    },
    lastSequence: () => sequence,
    replaceAll,
    async compact(state: DurabilityState): Promise<CompactionResult> {
      replaceAll(state)
      assertIntegrity(db)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
      return { generation: "sqlite", previousGeneration: null, sequence }
    },
    maintain() {
      cleanupCheckpointStaging(opts.root)
      const result = checkpointWal(db)
      if (result.busy)
        console.warn("durability: SQLite WAL checkpoint busy; a reader retains WAL frames")
      const now = Date.now()
      const directory = binaryDir(opts.root)
      if (
        !fs.existsSync(directory) ||
        !fs
          .readdirSync(directory)
          .some(
            (name) => now - fs.statSync(path.join(directory, name)).mtimeMs >= BINARY_PRUNE_GRACE_MS
          )
      )
        return { ...result, prunedBinaries: [] }
      let releaseBinaries: () => void
      try {
        releaseBinaries = acquireWriterLease(opts.root, "binary", { shared: true })
      } catch (error) {
        if (error instanceof DurabilityFault && error.code === "writer-busy")
          return { ...result, prunedBinaries: [] }
        throw error
      }
      try {
        const references = collectJournalBinaryReferences(opts.root, new Set<string>())
        collectSqliteBinaryReferences(opts.root, references)
        return { ...result, prunedBinaries: pruneBinaries(opts.root, references, now) }
      } finally {
        releaseBinaries()
      }
    },
    async close() {
      if (closed) return
      closed = true
      try {
        db.close()
        restrictPermissions(file)
      } finally {
        release()
      }
    },
  }
  return backend
}

/** Narrowing helper: `replaceAll` only exists on the SQLite backend. */
export function asSqliteBackend(
  backend: HeadlessDurabilityBackend
): (HeadlessDurabilityBackend & { replaceAll(state: DurabilityState): void }) | null {
  return backend.id === "sqlite-v5"
    ? (backend as HeadlessDurabilityBackend & { replaceAll(state: DurabilityState): void })
    : null
}

/**
 * Side-file references every SQLite row holds, read straight from the file so
 * `durability finalize` (synchronous) can keep them. A store that does not
 * exist references nothing.
 */
export function collectSqliteBinaryReferences(root: string, into: Set<string>): Set<string> {
  const file = sqliteFile(root)
  if (!fs.existsSync(file)) return into
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(SQLITE_ROWS_TABLE))
      return into
    for (const raw of db.prepare(`SELECT value FROM ${SQLITE_ROWS_TABLE}`).all() as Array<
      Record<string, unknown>
    >) {
      collectBinaryReferences(JSON.parse(String(raw.value)), into)
    }
  } finally {
    db.close()
  }
  return into
}

function materializeSqlite(db: SqliteDatabaseLike, sequence: number): DurabilityState {
  const state: DurabilityState = { sequence, dbs: {} }
  for (const raw of db
    .prepare("SELECT database, version, tables FROM durability_schema")
    .all() as Array<Record<string, unknown>>) {
    const database = String(raw.database)
    let tables: string[] = []
    try {
      const parsed: unknown = JSON.parse(String(raw.tables))
      if (Array.isArray(parsed)) tables = parsed.filter((t): t is string => typeof t === "string")
    } catch {
      throw new DurabilityFault(
        "sqlite-integrity-failure",
        `sqlite schema row for ${database} has an unreadable table list`
      )
    }
    const schema: DurabilitySchema = { version: Number(raw.version), tables }
    const rows: Record<string, Record<string, unknown>> = {}
    for (const table of tables) rows[table] = {}
    state.dbs[database] = { schema, rows }
  }
  for (const raw of db
    .prepare(`SELECT database, table_name, row_key, value, value_codec FROM ${SQLITE_ROWS_TABLE}`)
    .all() as Array<Record<string, unknown>>) {
    const entry = state.dbs[String(raw.database)]
    if (!entry) continue
    const tableName = String(raw.table_name)
    const key = String(raw.row_key)
    // A store written before `listTouchedTables` may hold rows of a table
    // its schema row never listed. List it, as the journal does, so a
    // restart re-declares it and the checkpoint writer keeps its rows.
    if (!entry.rows[tableName] && !entry.schema.tables.includes(tableName)) {
      entry.schema.tables = [...entry.schema.tables, tableName].sort()
    }
    const table = (entry.rows[tableName] ??= {})
    let value: unknown
    try {
      value = JSON.parse(String(raw.value))
    } catch {
      throw new DurabilityFault(
        "sqlite-integrity-failure",
        `sqlite row ${String(raw.database)}.${tableName} holds unreadable JSON`
      )
    }
    const codec = Number(raw.value_codec)
    if (codec !== VALUE_CODEC) {
      throw new DurabilityFault(
        "sqlite-integrity-failure",
        `sqlite row ${String(raw.database)}.${tableName} uses unsupported value codec ${codec}`
      )
    }
    table[key] = value
  }
  return state
}

/** Read the SQLite store without chmod or a write-capable handle. */
export function readSqliteState(root: string): DurabilityState {
  const db = new DatabaseSync(sqliteFile(root), { readOnly: true }) as unknown as SqliteDatabaseLike
  try {
    db.exec("BEGIN")
    assertIntegrity(db)
    const exists = (name: string) =>
      db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name) as
        { type: string } | undefined
    const meta = exists("durability_meta")
      ? (db.prepare("SELECT value FROM durability_meta WHERE key = 'sequence'").get() as
          { value: string } | undefined)
      : undefined
    if (exists(SQLITE_ROWS_TABLE)?.type !== "table") {
      throw new DurabilityFault(
        "sqlite-integrity-failure",
        "sqlite store has no readable rows table"
      )
    }
    return materializeSqlite(db, Number(meta?.value ?? 0))
  } finally {
    db.close()
  }
}

function checkpointWal(db: SqliteDatabaseLike): Omit<SqliteMaintenanceResult, "prunedBinaries"> {
  const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy: number
    log: number
    checkpointed: number
  }
  return { busy: result.busy !== 0, logFrames: result.log, checkpointedFrames: result.checkpointed }
}

/** Explicit offline VACUUM: routine maintenance only checkpoints and collects binaries. */
export function compactSqlite(root: string): { bytesBefore: number; bytesAfter: number } {
  const file = sqliteFile(root)
  if (!fs.existsSync(file))
    throw new DurabilityFault("sqlite-integrity-failure", "no SQLite store exists to compact")
  const release = acquireWriterLease(root, "sqlite")
  let db: SqliteDatabaseLike | undefined
  try {
    db = new DatabaseSync(file) as unknown as SqliteDatabaseLike
    assertIntegrity(db)
    if (checkpointWal(db).busy)
      throw new DurabilityFault(
        "writer-busy",
        "SQLite WAL checkpoint busy; close readers before compaction"
      )
    const bytesBefore = fs.statSync(file).size
    db.exec("VACUUM")
    if (checkpointWal(db).busy)
      throw new DurabilityFault("writer-busy", "SQLite WAL checkpoint busy after VACUUM")
    assertIntegrity(db)
    return { bytesBefore, bytesAfter: fs.statSync(file).size }
  } finally {
    try {
      db?.close()
    } finally {
      release()
    }
  }
}
