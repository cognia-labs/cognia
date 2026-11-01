/**
 * How row values cross the durability boundary (journal lines, checkpoint row
 * files, SQLite rows).
 *
 * The backends store JSON. Dexie rows are structured clones, so plain JSON
 * loses data: a `Blob` serialises as `{}`, a typed array as an index-keyed
 * object, an `ArrayBuffer` as `{}`, and a `Date` was written as `{__date}` and
 * never revived. Value codec 1 encodes every row with the snapshot envelope
 * (`cli/src/db/snapshot.ts`, `encodeSnapshotValueSync`) at the Dexie boundary
 * and decodes it on restore, so what a restart hands back is what was written.
 * Binary values beyond a few KiB live in content-addressed side files under the
 * durability root (`binary-store.ts`), referenced from the row.
 *
 * Data written before codec 1 ("codec 0") cannot be repaired where bytes were
 * never persisted. {@link normalizeLegacyValue} lifts what it can (`{__date}`
 * back to a Date, user objects that collide with the envelope key escaped) and
 * reports, never guesses at, the shapes that look like lost binary data.
 */
import fs from "node:fs"
import path from "node:path"

import { decodeSnapshotRows, encodeSnapshotValueSync } from "../../db/snapshot"
import { INLINE_BINARY_LIMIT, readBinarySync, writeBinarySync } from "./binary-store"
import type { BinaryPrefetcher } from "./binary-prefetch"
import { readBlobBytesSync } from "./blob-sync"

/** Wire format: written into journal lines, checkpoint manifests and SQLite rows. */
export const VALUE_CODEC = 1 as const

/** Key the snapshot codec tags its envelopes with. */
const ENVELOPE_KEY = "$cogniaSnapshotValue"

/**
 * A live Dexie row value → its codec-1 JSON form. Synchronous on purpose: it
 * runs on the commit path. With a durability `root`, binary values above
 * {@link INLINE_BINARY_LIMIT} are written to its side-file store first
 * (`binary-store.ts`); without one (parity tooling, tests) everything stays
 * inline. A `prefetched` scope whose side files a prefetcher already started
 * (`binary-prefetch.ts`; the scope is the recorded mutation, or one table
 * read) supplies them, so the encode only waits for the ones still unfinished.
 */
export function encodeDurableValue(
  value: unknown,
  root?: string,
  prefetched?: { prefetcher: BinaryPrefetcher; scope: object }
): unknown {
  return encodeSnapshotValueSync(value, {
    readBlob: readBlobBytesSync,
    ...(prefetched
      ? { prepared: (binary: object) => prefetched.prefetcher.resolve(binary, prefetched.scope) }
      : {}),
    ...(root === undefined
      ? {}
      : {
          writeBinary: (bytes: Uint8Array) => writeBinarySync(root, bytes),
          inlineLimit: INLINE_BINARY_LIMIT,
        }),
  })
}

/**
 * A codec-1 JSON value → the live value Dexie should hold. Side files are read
 * into memory (never file-backed Blobs: Node cannot hand those to the worker
 * that `encodeDurableValue` reads Blobs through).
 */
export function decodeDurableValue(value: unknown, root?: string): unknown {
  return decodeSnapshotRows(
    [value],
    root === undefined
      ? undefined
      : { read: (reference, byteLength) => readBinarySync(root, reference, byteLength) }
  )[0]
}

/** What a codec-0 value looks like where binary data was lost, or where it cannot be told apart. */
export type LegacyValueLossShape =
  /**
   * `{}`: a Blob or ArrayBuffer in the journal or SQLite store; a Map, Set,
   * RegExp or DataView in the snapshot store (or a genuinely empty object).
   */
  | "empty-object"
  /** `{"0": n, "1": n, …}`: a typed array written as its indices. */
  | "index-keyed-object"
  /**
   * An object holding the envelope key: user data, or codec-1 data an older
   * build loaded without decoding and wrote back as codec 0. Kept as user data.
   */
  | "envelope-key-object"
  /**
   * An ISO timestamp string in a pre-codec-1 snapshot store: a Date (which the
   * old encoder wrote as its `toJSON` string) or a string that was always one.
   */
  | "iso-date-string"
  /**
   * A Blob in a pre-codec-1 snapshot store: a File written then lost its name
   * and modification time and restores as a plain Blob.
   */
  | "legacy-blob"

/** One aggregated report row: same table, same field path, same shape. */
export interface LegacyValueFinding {
  database: string
  table: string
  /** Field path inside the row; `[]` stands for any array index, `""` for the row itself. */
  path: string
  shape: LegacyValueLossShape
  count: number
  /** Up to {@link SAMPLE_KEYS} encoded row keys, for `durability verify` output. */
  sampleKeys: string[]
}

const SAMPLE_KEYS = 3

/** Collects findings across many rows into one row per (database, table, path, shape). */
export class LegacyValueReport {
  private readonly rows = new Map<string, LegacyValueFinding>()

  add(
    database: string,
    table: string,
    key: string,
    path: string,
    shape: LegacyValueLossShape
  ): void {
    const id = JSON.stringify([database, table, path, shape])
    const existing = this.rows.get(id)
    if (existing) {
      existing.count += 1
      if (existing.sampleKeys.length < SAMPLE_KEYS && !existing.sampleKeys.includes(key))
        existing.sampleKeys.push(key)
      return
    }
    this.rows.set(id, { database, table, path, shape, count: 1, sampleKeys: [key] })
  }

  /** Fold in an already-aggregated finding (another report, the persisted file). */
  merge(finding: LegacyValueFinding): void {
    const id = JSON.stringify([finding.database, finding.table, finding.path, finding.shape])
    const existing = this.rows.get(id)
    if (!existing) {
      this.rows.set(id, { ...finding, sampleKeys: finding.sampleKeys.slice(0, SAMPLE_KEYS) })
      return
    }
    existing.count = Math.max(existing.count, finding.count)
    for (const key of finding.sampleKeys) {
      if (existing.sampleKeys.length >= SAMPLE_KEYS) break
      if (!existing.sampleKeys.includes(key)) existing.sampleKeys.push(key)
    }
  }

  findings(): LegacyValueFinding[] {
    return [...this.rows.values()].sort(
      (a, b) =>
        a.database.localeCompare(b.database) ||
        a.table.localeCompare(b.table) ||
        a.path.localeCompare(b.path) ||
        a.shape.localeCompare(b.shape)
    )
  }
}

/** Where a codec-0 value lives, for the report. */
export interface LegacyValueAddress {
  database: string
  table: string
  key: string
  report: LegacyValueReport
}

const ISO_DATE = /^\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

function isIndexKeyedNumbers(object: Record<string, unknown>, keys: string[]): boolean {
  if (keys.length === 0) return false
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== String(index)) return false
    const item = object[keys[index]]
    if (typeof item !== "number" && item !== null) return false
  }
  return true
}

/**
 * Lift one codec-0 value into codec-1 form.
 *
 * - `{__date: "<ISO>"}` — what codec 0 wrote for a Date — becomes a Date
 *   envelope. A user object of exactly that shape was written identically, so
 *   the two cannot be told apart; a Date is by far the likelier source.
 * - An object holding the envelope key is user data under codec 0; it is
 *   escaped so codec 1 never reads it as an envelope, and reported, because an
 *   older build that loaded codec-1 rows without decoding them and wrote them
 *   back would leave exactly this shape (the checkpoint format and SQLite
 *   layout refuse such builds now, but a store they touched earlier may hold
 *   it).
 * - `{}` and index-keyed number objects are reported and kept as they are:
 *   their bytes (or their element type) were never persisted.
 */
export function normalizeLegacyValue(value: unknown, address: LegacyValueAddress): unknown {
  return normalizeAt(value, address, "")
}

function normalizeAt(value: unknown, address: LegacyValueAddress, path: string): unknown {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) {
    const itemPath = `${path}[]`
    return value.map((item) => normalizeAt(item, address, itemPath))
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length === 0) {
    address.report.add(address.database, address.table, address.key, path, "empty-object")
    return object
  }
  if (
    keys.length === 1 &&
    keys[0] === "__date" &&
    typeof object.__date === "string" &&
    ISO_DATE.test(object.__date) &&
    !Number.isNaN(Date.parse(object.__date))
  ) {
    return { [ENVELOPE_KEY]: { version: 1, type: "date", time: Date.parse(object.__date) } }
  }
  if (isIndexKeyedNumbers(object, keys)) {
    address.report.add(address.database, address.table, address.key, path, "index-keyed-object")
    return object
  }
  const entries: [string, unknown][] = keys.map((key) => [
    key,
    normalizeAt(object[key], address, path ? `${path}.${key}` : key),
  ])
  if (!Object.hasOwn(object, ENVELOPE_KEY)) return Object.fromEntries(entries)
  address.report.add(address.database, address.table, address.key, path, "envelope-key-object")
  return { [ENVELOPE_KEY]: { version: 1, type: "record", entries } }
}

// ── The persisted report ────────────────────────────────────────────────────
//
// Findings come from codec-0 rows, and the first compaction rewrites those rows
// as codec 1, after which nothing on disk still says they were lossy. The
// report is therefore written the first time a load sees them and merged on
// every later sighting, so `durability verify` can name them for good.

export const LEGACY_VALUE_REPORT_FILE = "value-loss-report.json"

export interface LegacyValueReportFile {
  reportFormat: 1
  firstSeenAt: number
  updatedAt: number
  findings: LegacyValueFinding[]
}

export function legacyValueReportPath(root: string): string {
  return path.join(root, LEGACY_VALUE_REPORT_FILE)
}

/** The persisted report, or `null` when no load has ever seen lossy codec-0 rows. */
export function readLegacyValueReport(root: string): LegacyValueReportFile | null {
  const file = legacyValueReportPath(root)
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LegacyValueReportFile
  if (parsed?.reportFormat !== 1 || !Array.isArray(parsed.findings))
    throw new Error(`${file} is not a value-loss report`)
  return parsed
}

/**
 * Merge `findings` into the persisted report. Counts keep the highest sighting
 * (the same rows are seen again on every load until compaction rewrites them);
 * sample keys are unioned up to the cap. Returns the report as written, or
 * `null` when there was nothing to record.
 */
export function recordLegacyValueFindings(
  root: string,
  findings: readonly LegacyValueFinding[] | undefined,
  now: () => number = Date.now
): LegacyValueReportFile | null {
  if (!findings || findings.length === 0) return null
  const existing = readLegacyValueReport(root)
  const merged = new LegacyValueReport()
  for (const finding of [...(existing?.findings ?? []), ...findings]) merged.merge(finding)
  const at = now()
  const report: LegacyValueReportFile = {
    reportFormat: 1,
    firstSeenAt: existing?.firstSeenAt ?? at,
    updatedAt: at,
    findings: merged.findings(),
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const file = legacyValueReportPath(root)
  const staging = `${file}.tmp`
  const descriptor = fs.openSync(staging, "w", 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(staging, file)
  return report
}

/** One line per finding, for logs and `durability verify`. */
export function formatLegacyValueFinding(finding: LegacyValueFinding): string {
  const where = `${finding.database}.${finding.table}${finding.path ? `.${finding.path}` : ""}`
  const what =
    finding.shape === "empty-object"
      ? "read back as {} (a value written before value codec 1 that kept nothing: a Blob or ArrayBuffer in the journal or SQLite store, a Map, Set, RegExp, DataView, Blob or ArrayBuffer in the snapshot store; a genuinely empty object looks the same)"
      : finding.shape === "index-keyed-object"
        ? "read back as an index-keyed object (a typed array written before value codec 1; its element type was not kept)"
        : finding.shape === "iso-date-string"
          ? "read back as an ISO timestamp string (a Date written to the snapshot store before value codec 1 became its string; a value that was always a string looks the same)"
          : finding.shape === "legacy-blob"
            ? "read back as a Blob (a File written to the snapshot store before value codec 1 lost its name; a plain Blob looks the same)"
            : "hold the value codec's envelope key and were kept as plain data (user data, or values an older build loaded without decoding and wrote back; those were not revived)"
  return `${where}: ${finding.count} row(s) ${what}; e.g. ${finding.sampleKeys.join(", ")}`
}
