import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  BINARY_PRUNE_GRACE_MS,
  binaryDir,
  collectBinaryReferences,
  pruneBinaries,
  readBinarySync,
  writeBinarySync,
} from "./binary-store"

describe("binary side files", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-binary-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const bytes = Uint8Array.from([1, 2, 3, 4])
  const sha = createHash("sha256").update(bytes).digest("hex")

  it("writes bytes under their sha256, owner-only, and reads them back", () => {
    expect(writeBinarySync(root, bytes)).toBe(sha)
    const file = path.join(binaryDir(root), sha)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(Array.from(readBinarySync(root, sha, 4))).toEqual([1, 2, 3, 4])
    expect(fs.readdirSync(binaryDir(root))).toEqual([sha])
  })

  it("dedups identical content and refreshes its mtime", () => {
    writeBinarySync(root, bytes)
    const file = path.join(binaryDir(root), sha)
    const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
    fs.utimesSync(file, old, old)
    expect(writeBinarySync(root, Uint8Array.from(bytes))).toBe(sha)
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime())
  })

  it("refuses a missing, short, altered or malformed reference", () => {
    expect(() => readBinarySync(root, sha, 4)).toThrow(/missing/)
    writeBinarySync(root, bytes)
    expect(() => readBinarySync(root, sha, 5)).toThrow(/wrong length/)
    fs.writeFileSync(path.join(binaryDir(root), sha), Uint8Array.from([9, 9, 9, 9]))
    expect(() => readBinarySync(root, sha, 4)).toThrow(/content hash/)
    expect(() => readBinarySync(root, "../etc", 4)).toThrow(/invalid/)
  })

  it("collects every fileRef a value holds", () => {
    const refs = collectBinaryReferences(
      [
        { a: { $cogniaSnapshotValue: { version: 1, type: "blob", fileRef: "x".repeat(64) } } },
        {
          $cogniaSnapshotValue: {
            version: 1,
            type: "map",
            entries: [[1, { $cogniaSnapshotValue: { fileRef: "y" } }]],
          },
        },
        "plain",
      ],
      new Set()
    )
    expect([...refs].sort()).toEqual(["x".repeat(64), "y"])
  })

  it("prunes only unreferenced files older than the grace period", () => {
    const kept = writeBinarySync(root, Uint8Array.from([1]))
    const stale = writeBinarySync(root, Uint8Array.from([2]))
    const fresh = writeBinarySync(root, Uint8Array.from([3]))
    const staging = path.join(binaryDir(root), ".tmp-abandoned")
    fs.writeFileSync(staging, "x")
    fs.writeFileSync(path.join(binaryDir(root), "README"), "not ours")
    const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
    for (const name of [kept, stale, ".tmp-abandoned", "README"])
      fs.utimesSync(path.join(binaryDir(root), name), old, old)
    expect(pruneBinaries(root, new Set([kept]))).toEqual([".tmp-abandoned", stale].sort())
    expect(fs.readdirSync(binaryDir(root)).sort()).toEqual([kept, fresh, "README"].sort())
    expect(pruneBinaries(path.join(root, "absent"), new Set())).toEqual([])
  })
})
