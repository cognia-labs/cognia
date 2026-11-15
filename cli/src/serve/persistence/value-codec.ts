/**
 * How row values cross the durability boundary (SQLite rows).
 *
 * The backends store JSON. Dexie rows are structured clones, so plain JSON
 * loses data: a `Blob` serialises as `{}`, a typed array as an index-keyed
 * object, an `ArrayBuffer` as `{}`, and a `Date` was written as `{__date}` and
 * never revived. Value codec 1 encodes every row with the snapshot envelope
 * (`cli/src/db/snapshot.ts`, `encodeSnapshotValueSync`) at the Dexie boundary
 * and decodes it on restore, so what a restart hands back is what was written.
 * Binary values beyond a few KiB live in content-addressed side files under the
 * durability root (`binary-store.ts`), referenced from the row.
 */
import { decodeSnapshotRows, encodeSnapshotValueSync } from "../../db/snapshot"
import { INLINE_BINARY_LIMIT, readBinarySync, writeBinarySync } from "./binary-store"
import type { BinaryPrefetcher } from "./binary-prefetch"
import { readBlobBytesSync } from "./blob-sync"

/** Wire format: written into every SQLite row (`value_codec`). */
export const VALUE_CODEC = 1 as const

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
