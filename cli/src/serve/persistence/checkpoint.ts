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
 * A generation is written to `gen-XXXX.staging-<nonce>/`, `fsync`ed, then renamed into
 * place; a crash mid-write leaves the staging directory and never a half-written
 * generation. Only incomplete reservations and staging directories are reclaimed
 * here — compaction, migration and recovery all add. `durability finalize` prunes
 * and it prunes strictly below the reported rollback watermark.
 */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { canonicalJson } from "./canonical"
import { acquireWriterLease } from "./writer-lock"
import { readManifest, writeManifest, type BackendManifest } from "./manifest"
import { VALUE_CODEC } from "./value-codec"
import {
  DurabilityFault,
  type DurabilitySchema,
  type DurabilityState,
  emptyDurabilityState,
} from "./types"

/**
 * Checkpoint envelope format. Bumped only on a breaking layout change. Format 4
 * holds value-codec-1 rows; any other format is refused.
 */
export const CHECKPOINT_FORMAT = 4 as const

interface CheckpointManifest {
  checkpointFormat: typeof CHECKPOINT_FORMAT
  generation: string
  createdAt: number
  /** Commit sequence the checkpoint content corresponds to. */
  sequence: number
  /** How row values are encoded (`value-codec.ts`); format 4 must say so. */
  valueCodec: typeof VALUE_CODEC
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

export function latestGeneration(root: string, manifest = readManifest(root)): string | null {
  if (manifest.journalGeneration) return manifest.journalGeneration
  const all = listGenerations(root).filter(
    (generation) => !isStagedGeneration(root, generation, manifest)
  )
  return all.length > 0 ? all[all.length - 1] : null
}

export function nextGeneration(root: string): string {
  const dir = generationsDir(root)
  const all = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => parseGeneration(name) !== null)
        .sort((a, b) => parseGeneration(a)! - parseGeneration(b)!)
    : []
  const latest = all.at(-1)
  return formatGeneration(latest ? (parseGeneration(latest) ?? 0) + 1 : 1)
}

export function isStagedGeneration(
  root: string,
  generation: string,
  manifest: BackendManifest = readManifest(root)
): boolean {
  return (
    manifest.journalGeneration !== generation &&
    fs.existsSync(path.join(generationDir(root, generation), "staged"))
  )
}

/** Publish a verified recovery checkpoint only when activation was requested. */
export function activateGeneration(root: string, generation: string, now = Date.now): void {
  writeManifest(
    root,
    {
      ...readManifest(root),
      activeBackend: "journal-v4",
      shadowBackend: null,
      journalGeneration: generation,
    },
    now
  )
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

/** Called only while holding the checkpoint publication lease. */
function removeCheckpointStaging(root: string): string[] {
  const dir = generationsDir(root)
  if (!fs.existsSync(dir)) return []
  const removed: string[] = []
  for (const name of fs.readdirSync(dir)) {
    const staging = /^gen-\d{4,}\.staging(?:-[a-zA-Z0-9-]+)?$/.test(name)
    const reservation =
      parseGeneration(name) !== null && !fs.existsSync(path.join(dir, name, "checkpoint.json"))
    if (!staging && !reservation) continue
    fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    removed.push(name)
  }
  if (removed.length > 0) syncDirectory(dir)
  return removed
}

/** A live publisher owns all incomplete paths; defer cleanup until its kernel lease is free. */
export function cleanupCheckpointStaging(root: string): string[] {
  if (!fs.existsSync(generationsDir(root))) return []
  let release: () => void
  try {
    release = acquireWriterLease(root, "checkpoint")
  } catch (error) {
    if (error instanceof DurabilityFault && error.code === "writer-busy") return []
    throw error
  }
  try {
    return removeCheckpointStaging(root)
  } finally {
    release()
  }
}

/**
 * Write `state` as a new immutable generation and return its id.
 *
 * Null allocates an id through an atomic directory reservation. An explicit
 * id must not already be published. The kernel lease covers allocation through
 * publication, so interrupted reservations can be reclaimed without PID checks.
 */
export function writeCheckpoint(
  root: string,
  generation: string | null,
  state: DurabilityState,
  opts: { staged?: boolean; writer?: boolean } = {}
): string {
  let release: (() => void) | undefined
  let releaseCheckpoint: (() => void) | undefined
  let target: string | undefined
  let staging: string | undefined
  let staged = opts.staged === true
  if (!staged && !opts.writer) {
    try {
      release = acquireWriterLease(root, "journal")
    } catch (error) {
      if (!(error instanceof DurabilityFault) || error.code !== "writer-busy") throw error
      staged = true
    }
  }
  try {
    releaseCheckpoint = acquireWriterLease(root, "checkpoint")
    fs.mkdirSync(generationsDir(root), { recursive: true, mode: 0o700 })
    removeCheckpointStaging(root)
    let reserved = generation ?? nextGeneration(root)
    for (;;) {
      try {
        fs.mkdirSync(generationDir(root, reserved), { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (generation !== null)
          throw new DurabilityFault(
            "checkpoint-corrupt",
            `refusing to overwrite the existing generation ${generation}`
          )
        reserved = nextGeneration(root)
      }
    }
    generation = reserved
    target = generationDir(root, generation)
    staging = `${target}.staging-${randomUUID()}`
    fs.mkdirSync(staging, { mode: 0o700 })

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
    // An offline checkpoint must not displace the append target of a live writer.
    if (staged) {
      writeSyncedFile(path.join(staging, "staged"), "")
    }
    syncDirectory(staging)
    fs.renameSync(staging, target)
    syncDirectory(generationsDir(root))
    return generation
  } finally {
    try {
      if (staging) fs.rmSync(staging, { recursive: true, force: true })
      // A rename may have succeeded even when its caller received an I/O error.
      if (target && !fs.existsSync(path.join(target, "checkpoint.json")))
        fs.rmSync(target, { recursive: true, force: true })
    } finally {
      try {
        releaseCheckpoint?.()
      } finally {
        release?.()
      }
    }
  }
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
  if (root.checkpointFormat !== CHECKPOINT_FORMAT) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      `unsupported checkpoint format ${String(root.checkpointFormat)}`
    )
  }
  if (typeof root.sequence !== "number" || !Number.isInteger(root.sequence) || root.sequence < 0) {
    throw new DurabilityFault(
      "checkpoint-corrupt",
      "checkpoint sequence is not a non-negative integer"
    )
  }
  if (root.valueCodec !== VALUE_CODEC) {
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
    checkpointFormat: CHECKPOINT_FORMAT,
    generation: typeof root.generation === "string" ? root.generation : "",
    createdAt: typeof root.createdAt === "number" ? root.createdAt : 0,
    sequence: root.sequence,
    valueCodec: VALUE_CODEC,
    dbs,
  }
}

/** Read one generation back into a {@link DurabilityState}, row values in codec-1 form. */
export function readCheckpoint(root: string, generation: string): DurabilityState {
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
      rows[table] = parsed as Record<string, unknown>
    }
    state.dbs[database] = { schema, rows }
  }
  return state
}

/** Read the newest generation, or an empty state when none exists yet. */
export function readLatestCheckpoint(root: string): {
  generation: string | null
  state: DurabilityState
} {
  const generation = latestGeneration(root)
  if (!generation) return { generation: null, state: emptyDurabilityState() }
  return { generation, state: readCheckpoint(root, generation) }
}
