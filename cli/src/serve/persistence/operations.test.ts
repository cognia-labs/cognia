import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { binaryDir } from "./binary-store"
import { openSqliteBackend, SQLITE_ROWS_TABLE, sqliteFile } from "./sqlite"
import { verifyDurability } from "./operations"
import type { DurabilityCommit, DurabilityState } from "./types"
import { encodeDurableValue } from "./value-codec"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ops-"))
}

function state(sequence = 0, rows: Record<string, unknown> = {}): DurabilityState {
  return {
    sequence,
    dbs: {
      CogniaDB: { schema: { version: 141, tables: ["sessions"] }, rows: { sessions: rows } },
    },
  }
}

function commit(sequence: number, key: string, value: unknown): DurabilityCommit {
  return {
    sequence,
    committedAt: sequence,
    mutations: [{ database: "CogniaDB", table: "sessions", key, value }],
  }
}

async function seedSqlite(root: string, seed: DurabilityState, commits: DurabilityCommit[] = []) {
  const backend = openSqliteBackend({ root })
  try {
    await backend.compact(seed)
    for (const c of commits) backend.commitSync(c)
  } finally {
    await backend.close()
  }
}

/** Every file under `root` with its content hash, so a test can prove nothing changed. */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else
        out[path.relative(root, full)] = createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex")
    }
  }
  walk(root)
  return out
}

describe("verifyDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("reports a healthy store's sequence with no faults", async () => {
    await seedSqlite(root, state(0, { "s:a": { id: "a" } }), [
      commit(1, "s:b", { id: "b" }),
      commit(2, "s:a", null),
    ])
    expect(await verifyDurability(root)).toEqual({
      root,
      backend: "sqlite-v5",
      sqlitePresent: true,
      sqliteSequence: 2,
      faults: [],
    })
  })

  it("never changes a byte of a closed store, nor adds WAL/SHM files", async () => {
    await seedSqlite(root, state(0, { "s:a": { id: "a" } }), [commit(1, "s:b", { id: "b" })])
    const before = fingerprint(root)
    expect((await verifyDurability(root)).faults).toEqual([])
    expect(fingerprint(root)).toEqual(before)
  })

  it("reads commits still in the WAL of a live writer without touching its files", async () => {
    const backend = openSqliteBackend({ root })
    try {
      await backend.compact(state(0))
      backend.commitSync(commit(1, "s:a", { id: "a" }))
      backend.commitSync(commit(2, "s:b", { id: "b" }))
      expect(fs.statSync(`${sqliteFile(root)}-wal`).size).toBeGreaterThan(0)
      const before = fingerprint(root)
      const status = await verifyDurability(root)
      expect(status.faults).toEqual([])
      expect(status.sqliteSequence).toBe(2)
      expect(fingerprint(root)).toEqual(before)
    } finally {
      await backend.close()
    }
  })

  it("verifies a disposable copy and removes it afterwards", async () => {
    await seedSqlite(root, state(0, { "s:a": 1 }))
    const mkdtemp = fs.mkdtempSync.bind(fs)
    const created: string[] = []
    const spy = jest.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      const dir = mkdtemp(prefix)
      created.push(dir)
      return dir
    }) as typeof fs.mkdtempSync)
    try {
      expect((await verifyDurability(root)).faults).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(created).toHaveLength(1)
    expect(created[0].startsWith(root)).toBe(false)
    expect(fs.existsSync(created[0])).toBe(false)
  })

  it("faults on a nonexistent root without creating it", async () => {
    const missing = path.join(root, "missing")
    const status = await verifyDurability(missing)
    expect(status).toMatchObject({ sqlitePresent: false, sqliteSequence: null })
    expect(status.faults).toEqual([
      expect.objectContaining({
        code: "store-corrupt",
        message: expect.stringContaining("not a directory"),
      }),
    ])
    expect(fs.existsSync(missing)).toBe(false)
  })

  it("faults on a root that is a file", async () => {
    const file = path.join(root, "not-a-dir")
    fs.writeFileSync(file, "x")
    expect((await verifyDurability(file)).faults).toEqual([
      expect.objectContaining({ code: "store-corrupt" }),
    ])
  })

  it("faults on a root that holds no SQLite store, without creating one", async () => {
    const status = await verifyDurability(root)
    expect(status).toMatchObject({ sqlitePresent: false, sqliteSequence: null })
    expect(status.faults).toEqual([
      expect.objectContaining({
        code: "store-corrupt",
        message: expect.stringContaining("no SQLite store"),
      }),
    ])
    expect(fs.readdirSync(root)).toEqual([])
  })

  it("faults on a file that is not a SQLite database", async () => {
    fs.mkdirSync(path.dirname(sqliteFile(root)), { recursive: true })
    fs.writeFileSync(sqliteFile(root), "this is not a database, just some bytes".repeat(200))
    const status = await verifyDurability(root)
    expect(status.sqlitePresent).toBe(true)
    expect(status.sqliteSequence).toBeNull()
    expect(status.faults).toHaveLength(1)
  })

  it("faults on a SQLite store without the codec-1 rows table, without changing its hash", async () => {
    const file = sqliteFile(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE durability_schema (database TEXT PRIMARY KEY, version INTEGER, tables TEXT);
      INSERT INTO durability_schema VALUES ('CogniaDB', 141, '["sessions"]');
      CREATE TABLE durability_rows (database TEXT, table_name TEXT, row_key TEXT, value TEXT);
      INSERT INTO durability_rows VALUES ('CogniaDB', 'sessions', 's:a', '{"id":"a"}');
    `)
    db.close()
    const before = fingerprint(root)
    expect((await verifyDurability(root)).faults).toEqual([
      expect.objectContaining({
        code: "sqlite-integrity-failure",
        message: expect.stringContaining("no readable rows table"),
      }),
    ])
    expect(fingerprint(root)).toEqual(before)
  })

  it("faults on a row in an unsupported value codec", async () => {
    await seedSqlite(root, state(0, { "s:a": 1 }))
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE ${SQLITE_ROWS_TABLE} SET value_codec = 2`).run()
    db.close()
    expect((await verifyDurability(root)).faults).toEqual([
      expect.objectContaining({
        code: "sqlite-integrity-failure",
        message: expect.stringContaining("unsupported value codec 2"),
      }),
    ])
  })

  it("faults on a row whose table its schema row does not list", async () => {
    await seedSqlite(root, state(0, { "s:a": 1 }))
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE durability_schema SET tables = '[]'`).run()
    db.close()
    expect((await verifyDurability(root)).faults).toEqual([
      expect.objectContaining({
        code: "sqlite-integrity-failure",
        message: expect.stringContaining("does not list"),
      }),
    ])
  })

  it("faults on a row holding unreadable JSON", async () => {
    await seedSqlite(root, state(0, { "s:a": 1 }))
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE ${SQLITE_ROWS_TABLE} SET value = '{oops'`).run()
    db.close()
    expect((await verifyDurability(root)).faults).toEqual([
      expect.objectContaining({ code: "sqlite-integrity-failure" }),
    ])
  })

  it("reports a missing content-addressed binary", async () => {
    const value = encodeDurableValue(new Uint8Array(65536).fill(1), root)
    await seedSqlite(root, state(0, { "s:a": value }))
    expect((await verifyDurability(root)).faults).toEqual([])
    fs.rmSync(binaryDir(root), { recursive: true })
    expect((await verifyDurability(root)).faults).toEqual([
      expect.objectContaining({
        code: "store-corrupt",
        message: expect.stringContaining("is missing"),
      }),
    ])
  })

  it("reports a binary side file whose content no longer matches its hash", async () => {
    const value = encodeDurableValue(new Uint8Array(65536).fill(2), root)
    await seedSqlite(root, state(0, { "s:a": value }))
    const [name] = fs.readdirSync(binaryDir(root))
    const file = path.join(binaryDir(root), name)
    fs.chmodSync(file, 0o600)
    fs.writeFileSync(file, new Uint8Array(65536).fill(3))
    expect((await verifyDurability(root)).faults).toEqual([
      expect.objectContaining({ message: expect.stringContaining("does not match") }),
    ])
  })
})
