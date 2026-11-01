/**
 * Immutable checkpoint generations — the `snapshot-v3` rung, re-cut as an
 * append-only generation store.
 *
 * Layout under `<root>/generations/`:
 *
 * ```
 * gen-0001/
 *   checkpoint.json               { checkpointFormat, generation, createdAt, sequence, valueCodec, dbs }
 *   <db>--<table>.rows.json       { "<encodedKey>": <row>, ... }
 * ```
 *
 * A generation is written to `gen-XXXX.staging/`, `fsync`ed, then renamed into
 * place; a crash mid-write leaves the staging directory and never a half-written
 * generation. **Nothing here ever deletes a generation** — compaction, migration
 * and recovery all add. `durability finalize` is the only caller that prunes,
 * and it prunes strictly below the reported rollback watermark.
 */
import fs from "node:fs"
import path from "node:path"

import { canonicalJson } from "./canonical"
import { LegacyValueReport, normalizeLegacyValue, VALUE_CODEC } from "./value-codec"
import {
  DurabilityFault,
  type DurabilitySchema,
  type DurabilityState,
  emptyDurabilityState,
} from "./types"

/**
 * Checkpoint envelope format. Bumped only on a breaking layout change.
 *
 * Format 4 holds value-codec-1 rows. The bump is what makes codec-1 data
 * unreadable to a build that predates it: such a build refuses any format but
 * 3, so after a downgrade it fails at boot instead of handing Dexie envelope
 * objects as row values and writing them back as plain data. Format 3 (always
 * codec 0) stays readable here and is normalised on read.
 */
export const CHECKPOINT_FORMAT = 4 as const
/** The last format written before value codec 1. */
export const LEGACY_CHECKPOINT_FORMAT = 3 as const

interface CheckpointManifest {
  checkpointFormat: typeof CHECKPOINT_FORMAT | typeof LEGACY_CHECKPOINT_FORMAT
  generation: string
  createdAt: number
  /** Commit sequence the checkpoint content corresponds to. */
  sequence: number
  /**
   * How row values are encoded (`value-codec.ts`): 1 in format 4, which must
   * say so; 0 for a format-3 generation, whose rows {@link readCheckpoint}
   * normalises.
   */
  valueCodec: 0 | typeof VALUE_CODEC
  dbs: Record<string, DurabilitySchema>
}

const GENERATION_PATTERN = /^gen-(\d{4,})$/

export function generationsDir(root: string): string {
  return path.join(root, "generations")
}

export function generationDir(root: string, generation: string): string {
  return path.join(generationsDir(root), generation)
}

export function formatGeneration(index: number): string {
  return `gen-${String(index).padStart(4, "0")}`
}

export function parseGeneration(generation: string): number | null {
  const match = GENERATION_PATTERN.exec(generation)
  return match ? Number(match[1]) : null
}

/** Every complete generation on disk, oldest first. Staging dirs are ignored. */
export function listGenerations(root: string): string[] {
  const dir = generationsDir(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => parseGeneration(name) !== null)
    .filter((name) => fs.existsSync(path.join(dir, name, "checkpoint.json")))
    .sort((a, b) => (parseGeneration(a) ?? 0) - (parseGeneration(b) ?? 0))
}

export function latestGeneration(root: string): string | null {
  const all = listGenerations(root)
  return all.length > 0 ? all[all.length - 1] : null
}

export function nextGeneration(root: string): string {
  const latest = latestGeneration(root)
  return formatGeneration(latest ? (parseGeneration(latest) ?? 0) + 1 : 1)
}

function rowsFileName(database: string, table: string): string {
  return `${encodeURIComponent(database)}--${encodeURIComponent(table)}.rows.json`
}

function writeSyncedFile(file: string, data: string): void {
  const descriptor = fs.openSync(file, "w", 0o600)
  try {
    fs.writeFileSync(descriptor, data, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function syncDirectory(dir: string): void {
  if (process.platform === "win32") return
  const descriptor = fs.openSync(dir, "r")
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

/**
 * Write `state` as a new immutable generation and return its id.
 *
 * The caller picks the id (so migration can pre-reserve one); it must not
 * already exist as a complete generation.
 */
export function writeCheckpoint(root: string, generation: string, state: DurabilityState): string {
  const target = generationDir(root, generation)
  if (fs.existsSync(path.join(target, "checkpoint.json"))) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      `refusing to overwrite the existing generation ${generation}`
    )
  }
  const staging = `${target}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 })

  const dbs: Record<string, DurabilitySchema> = {}
  for (const [database, entry] of Object.entries(state.dbs)) {
    dbs[database] = { version: entry.schema.version, tables: [...entry.schema.tables].sort() }
    for (const table of dbs[database].tables) {
      writeSyncedFile(
        path.join(staging, rowsFileName(database, table)),
        canonicalJson(entry.rows[table] ?? {})
      )
    }
  }
  const manifest: CheckpointManifest = {
    checkpointFormat: CHECKPOINT_FORMAT,
    generation,
    createdAt: Date.now(),
    sequence: state.sequence,
    valueCodec: VALUE_CODEC,
    dbs,
  }
  writeSyncedFile(path.join(staging, "checkpoint.json"), canonicalJson(manifest))
  syncDirectory(staging)
  fs.renameSync(staging, target)
  syncDirectory(generationsDir(root))
  return generation
}

function parseManifest(text: string): CheckpointManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new DurabilityFault("checkpoint-corrupt", "checkpoint manifest is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DurabilityFault("checkpoint-corrupt", "checkpoint manifest is not an object")
  }
  const root = parsed as Record<string, unknown>
  if (
    root.checkpointFormat !== CHECKPOINT_FORMAT &&
    root.checkpointFormat !== LEGACY_CHECKPOINT_FORMAT
  ) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      `unsupported checkpoint format ${String(root.checkpointFormat)}`
    )
  }
  const legacy = root.checkpointFormat === LEGACY_CHECKPOINT_FORMAT
  if (typeof root.sequence !== "number" || !Number.isInteger(root.sequence) || root.sequence < 0) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      "checkpoint sequence is not a non-negative integer"
    )
  }
  if (legacy ? root.valueCodec !== undefined : root.valueCodec !== VALUE_CODEC) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      `checkpoint format ${String(root.checkpointFormat)} cannot hold value codec ${String(root.valueCodec)}`
    )
  }
  if (!root.dbs || typeof root.dbs !== "object" || Array.isArray(root.dbs)) {
    throw new DurabilityFault("checkpoint-corrupt", "checkpoint dbs is not an object")
  }
  const dbs: Record<string, DurabilitySchema> = {}
  for (const [name, raw] of Object.entries(root.dbs as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DurabilityFault("checkpoint-corrupt", `checkpoint entry for ${name} is malformed`)
    }
    const entry = raw as Record<string, unknown>
    if (typeof entry.version !== "number" || !Number.isFinite(entry.version)) {
      throw new DurabilityFault(
        "checkpoint-corrupt",
        `checkpoint version for ${name} is not a number`
      )
    }
    if (!Array.isArray(entry.tables) || entry.tables.some((t) => typeof t !== "string")) {
      throw new DurabilityFault("checkpoint-corrupt", `checkpoint tables for ${name} are malformed`)
    }
    dbs[name] = { version: entry.version, tables: entry.tables as string[] }
  }
  return {
    checkpointFormat: legacy ? LEGACY_CHECKPOINT_FORMAT : CHECKPOINT_FORMAT,
    generation: typeof root.generation === "string" ? root.generation : "",
    createdAt: typeof root.createdAt === "number" ? root.createdAt : 0,
    sequence: root.sequence,
    valueCodec: legacy ? 0 : VALUE_CODEC,
    dbs,
  }
}

/**
 * Read one generation back into a {@link DurabilityState}, with every row value
 * in codec-1 form. A generation written before codec 1 is normalised on read,
 * what looks like lost binary data goes into `report`, and the state carries
 * `legacyValueCodec` so the journal never appends codec-1 lines to it.
 */
export function readCheckpoint(
  root: string,
  generation: string,
  report: LegacyValueReport = new LegacyValueReport()
): DurabilityState {
  const dir = generationDir(root, generation)
  const manifestFile = path.join(dir, "checkpoint.json")
  if (!fs.existsSync(manifestFile)) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      `generation ${generation} has no checkpoint.json`
    )
  }
  const manifest = parseManifest(fs.readFileSync(manifestFile, "utf8"))
  const state: DurabilityState = { sequence: manifest.sequence, dbs: {} }
  if (manifest.valueCodec === 0) state.legacyValueCodec = true
  for (const [database, schema] of Object.entries(manifest.dbs)) {
    const rows: Record<string, Record<string, unknown>> = {}
    for (const table of schema.tables) {
      const file = path.join(dir, rowsFileName(database, table))
      let parsed: unknown
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"))
      } catch {
        throw new DurabilityFault(
          "checkpoint-corrupt",
          `generation ${generation} is missing or corrupt rows for ${database}.${table}`
        )
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new DurabilityFault(
          "checkpoint-corrupt",
          `generation ${generation} rows for ${database}.${table} are not an object`
        )
      }
      const tableRows = parsed as Record<string, unknown>
      if (manifest.valueCodec === 0) {
        for (const [key, value] of Object.entries(tableRows)) {
          tableRows[key] = normalizeLegacyValue(value, { database, table, key, report })
        }
      }
      rows[table] = tableRows
    }
    state.dbs[database] = { schema, rows }
  }
  return state
}

/** Read the newest generation, or an empty state when none exists yet. */
export function readLatestCheckpoint(
  root: string,
  report?: LegacyValueReport
): {
  generation: string | null
  state: DurabilityState
} {
  const generation = latestGeneration(root)
  if (!generation) return { generation: null, state: emptyDurabilityState() }
  return { generation, state: readCheckpoint(root, generation, report) }
}
