/**
 * Content-addressed side files for the binary values a durability row holds.
 *
 * A Blob or typed array of any real size does not belong in a JSON string: the
 * journal line, the SQLite `TEXT` value and above all a checkpoint's one-file
 * table dump would each have to hold its base64 — and V8 caps one string near
 * 512 MiB. Same rule as the snapshot store (`cli/src/db/bootstrap.ts`). Bytes
 * above {@link INLINE_BINARY_LIMIT} go to `<root>/binary/<sha256>` and the row
 * holds a `fileRef` envelope instead.
 *
 * Writes are synchronous and durable (temp file, `fsync`, rename, directory
 * `fsync`) because they run on the commit path, before the line or row that
 * references them. Files are immutable and shared by every backend under the
 * root; only `durability finalize` removes the ones nothing references.
 */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Binary values up to this many bytes stay inline in the row. */
export const INLINE_BINARY_LIMIT = 16 * 1024

const REFERENCE = /^[a-f0-9]{64}$/

export function binaryDir(root: string): string {
  return path.join(root, "binary")
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

/** Persist `bytes` and return their reference. Idempotent per content. */
export function writeBinarySync(root: string, bytes: Uint8Array): string {
  const reference = createHash("sha256").update(bytes).digest("hex")
  const dir = binaryDir(root)
  const file = path.join(dir, reference)
  if (fs.existsSync(file) && fs.statSync(file).size === bytes.byteLength) {
    // Re-referenced: refresh the mtime so a concurrent finalize, which spares
    // young files, cannot prune it between here and the line that names it.
    const at = new Date()
    fs.utimesSync(file, at, at)
    return reference
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staging = path.join(dir, `.tmp-${randomUUID()}`)
  const descriptor = fs.openSync(staging, "wx", 0o600)
  try {
    let written = 0
    while (written < bytes.byteLength) {
      written += fs.writeSync(descriptor, bytes, written, bytes.byteLength - written)
    }
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.renameSync(staging, file)
  } catch (error) {
    fs.rmSync(staging, { force: true })
    throw error
  }
  syncDirectory(dir)
  return reference
}

/** Read and verify one side file. Throws if it is missing, short or altered. */
export function readBinarySync(
  root: string,
  reference: string,
  byteLength: number
): Uint8Array<ArrayBuffer> {
  if (!REFERENCE.test(reference)) throw new Error("invalid durability binary reference")
  const file = path.join(binaryDir(root), reference)
  if (!fs.existsSync(file)) throw new Error(`durability binary ${reference} is missing`)
  const bytes = new Uint8Array(fs.readFileSync(file))
  if (bytes.byteLength !== byteLength)
    throw new Error(`durability binary ${reference} has the wrong length`)
  if (createHash("sha256").update(bytes).digest("hex") !== reference)
    throw new Error(`durability binary ${reference} does not match its content hash`)
  return bytes
}

/** Every `fileRef` a codec-1 value holds. */
export function collectBinaryReferences(value: unknown, into: Set<string>): Set<string> {
  if (!value || typeof value !== "object") return into
  if (Array.isArray(value)) {
    for (const item of value) collectBinaryReferences(item, into)
    return into
  }
  const object = value as Record<string, unknown>
  const envelope = object.$cogniaSnapshotValue
  if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
    const fileRef = (envelope as Record<string, unknown>).fileRef
    if (typeof fileRef === "string") into.add(fileRef)
  }
  for (const item of Object.values(object)) collectBinaryReferences(item, into)
  return into
}

/**
 * How old an unreferenced side file must be before it may go. A running brain
 * writes a side file a moment before the line that references it, and nothing
 * stops `finalize` from running beside it; a file younger than this may be one
 * of those, so it stays until a later finalize.
 */
export const BINARY_PRUNE_GRACE_MS = 60 * 60 * 1000

/**
 * Remove side files (and abandoned staging files) that `keep` does not name and
 * that are older than the grace period. Only `durability finalize` calls this,
 * after it has collected the references of every generation, journal and
 * SQLite row it keeps.
 */
export function pruneBinaries(
  root: string,
  keep: ReadonlySet<string>,
  now: number = Date.now(),
  graceMs: number = BINARY_PRUNE_GRACE_MS
): string[] {
  const dir = binaryDir(root)
  if (!fs.existsSync(dir)) return []
  const removed: string[] = []
  for (const name of fs.readdirSync(dir)) {
    if (keep.has(name)) continue
    if (!REFERENCE.test(name) && !name.startsWith(".tmp-")) continue
    const file = path.join(dir, name)
    if (now - fs.statSync(file).mtimeMs < graceMs) continue
    fs.rmSync(file, { force: true })
    removed.push(name)
  }
  if (removed.length > 0) syncDirectory(dir)
  return removed.sort()
}
