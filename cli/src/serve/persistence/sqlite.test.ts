import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { execFileSync } from "node:child_process"
import { BINARY_PRUNE_GRACE_MS, binaryDir } from "./binary-store"
import { encodeDurableValue, decodeDurableValue } from "./value-codec"
import { BinaryPrefetcher } from "./binary-prefetch"

import {
  assertIntegrity,
  collectSqliteBinaryReferences,
  compactSqlite,
  openSqliteBackend,
  SQLITE_ROWS_TABLE,
  sqliteFile,
} from "./sqlite"
import type { DurabilityCommit, DurabilityState } from "./types"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sqlite-"))
}

function state(sequence = 0): DurabilityState {
  return {
    sequence,
    dbs: {
      CogniaDB: {
        schema: { version: 141, tables: ["sessions", "messages"] },
        rows: {
          sessions: { "s:a": { id: "a", title: "one" } },
          messages: { "n:+00000000000000000001": { id: 1, body: "hi" } },
        },
      },
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

describe("openSqliteBackend", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("excludes cross-process binary publication while discovering GC references", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(1))
    encodeDurableValue(new Uint8Array(65536), root)
    const file = path.join(binaryDir(root), fs.readdirSync(binaryDir(root))[0])
    const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
    fs.utimesSync(file, old, old)
    const exists = fs.existsSync.bind(fs)
    let excluded = false
    // Reference discovery starts by probing the store file, under the binary lease.
    const fault = jest.spyOn(fs, "existsSync").mockImplementation(((target: fs.PathLike) => {
      if (String(target) === sqliteFile(root) && !excluded) {
        const script = `
          const loaded = await import(${JSON.stringify(path.join(__dirname, "writer-lock.ts"))});
          const { acquireWriterLease } = loaded.default ?? loaded;
          try {
            acquireWriterLease(${JSON.stringify(root)}, "binary", { shared: true })();
            console.log("acquired");
          } catch (error) {
            if (error.code !== "writer-busy") throw error;
            console.log("excluded");
          }
        `
        excluded =
          execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
            encoding: "utf8",
          }).trim() === "excluded"
      }
      return exists(target)
    }) as typeof fs.existsSync)
    try {
      expect(backend.maintain().prunedBinaries).toHaveLength(1)
      expect(excluded).toBe(true)
    } finally {
      fault.mockRestore()
      await backend.close()
    }
  })

  it("pins a worker's reused binary across GC's old stat and the durable commit", async () => {
    const backend = openSqliteBackend({ root })
    const prefetcher = new BinaryPrefetcher(root, { poolSize: 1 })
    const bytes = new Uint8Array(65536).fill(17)
    encodeDurableValue(bytes, root)
    const file = path.join(binaryDir(root), fs.readdirSync(binaryDir(root))[0])
    const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
    fs.utimesSync(file, old, old)
    const scope = {}
    const stat = fs.statSync.bind(fs)
    let reads = 0
    let reused = false
    const fault = jest.spyOn(fs, "statSync").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      const captured = stat(target, options as never)
      if (String(target) === file && ++reads === 2) {
        prefetcher.prefetch(bytes, scope)
        prefetcher.resolve(bytes, scope)
        reused = true
      }
      return captured
    }) as typeof fs.statSync)
    try {
      await backend.compact(state(0))
      backend.maintain()
      expect(reused).toBe(true)
      const encoded = encodeDurableValue(bytes, root, { prefetcher, scope })
      backend.commitSync(commit(1, "s:reused", encoded))
      expect(
        decodeDurableValue((await backend.load()).dbs.CogniaDB.rows.sessions["s:reused"], root)
      ).toEqual(bytes)
    } finally {
      fault.mockRestore()
      await prefetcher.close()
      await backend.close()
    }
  })

  it("starts empty", async () => {
    const backend = openSqliteBackend({ root })
    expect(await backend.load()).toEqual({ sequence: 0, dbs: {} })
    expect(backend.id).toBe("sqlite-v5")
    await backend.close()
  })

  it("round-trips a full state through compact", async () => {
    const backend = openSqliteBackend({ root })
    await expect(backend.compact(state(4))).resolves.toEqual({ sequence: 4 })
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(4)
    expect(loaded.dbs.CogniaDB.rows.sessions).toEqual({ "s:a": { id: "a", title: "one" } })
    expect(loaded.dbs.CogniaDB.schema.version).toBe(141)
  })

  it("persists across a reopen", async () => {
    const first = openSqliteBackend({ root })
    await first.compact(state(2))
    await first.close()

    const second = openSqliteBackend({ root })
    const loaded = await second.load()
    await second.close()
    expect(loaded.sequence).toBe(2)
    expect(Object.keys(loaded.dbs.CogniaDB.rows.messages)).toHaveLength(1)
  })

  it("applies writes and deletions from commits", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:b", { id: "b" }))
    backend.commitSync(commit(2, "s:a", null))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(2)
    expect(loaded.dbs.CogniaDB.rows.sessions).toEqual({ "s:b": { id: "b" } })
  })

  it("lists a table added after the schema row once its first row is committed", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync({
      sequence: 1,
      committedAt: 1,
      mutations: [{ database: "CogniaDB", table: "added", key: "s:k", value: { id: "k" } }],
    })
    const loaded = await backend.load()
    await backend.close()
    // A restart re-declares it from this list.
    expect(loaded.dbs.CogniaDB.schema.tables).toEqual(["added", "messages", "sessions"])
    expect(loaded.dbs.CogniaDB.rows.added).toEqual({ "s:k": { id: "k" } })
  })

  it("lists a late table even when its only commit is a delete", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync({
      sequence: 1,
      committedAt: 1,
      mutations: [{ database: "CogniaDB", table: "added", key: "s:k", value: null }],
    })
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.dbs.CogniaDB.schema.tables).toEqual(["added", "messages", "sessions"])
  })

  it("rejects redelivery of an already-applied sequence", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:b", { id: "b" }))
    expect(() => backend.commitSync(commit(1, "s:b", { id: "SHOULD-NOT-APPLY" }))).toThrow(
      expect.objectContaining({ code: "sequence-gap", sequence: 2 })
    )
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.dbs.CogniaDB.rows.sessions["s:b"]).toEqual({ id: "b" })
    expect(loaded.sequence).toBe(1)
  })

  it("rejects a sequence gap", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    expect(() => backend.commitSync(commit(3, "s:c", 1))).toThrow(
      expect.objectContaining({ code: "sequence-gap", sequence: 1 })
    )
    await backend.close()
  })

  it("refuses commits after close", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    await backend.close()
    expect(() => backend.commitSync(commit(1, "s:b", 1))).toThrow(/closed/)
  })

  it("creates the database file with restrictive permissions", async () => {
    const backend = openSqliteBackend({ root })
    await backend.close()
    if (process.platform === "win32") return
    expect(fs.statSync(sqliteFile(root)).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(sqliteFile(root))).mode & 0o777).toBe(0o700)
  })

  it("rolls the transaction back when a mutation fails mid-commit", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() =>
      backend.commitSync({
        sequence: 1,
        committedAt: 0,
        mutations: [
          { database: "CogniaDB", table: "sessions", key: "s:ok", value: { id: "ok" } },
          { database: "CogniaDB", table: "sessions", key: "s:bad", value: circular },
        ],
      })
    ).toThrow()
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(0)
    expect(loaded.dbs.CogniaDB.rows.sessions["s:ok"]).toBeUndefined()
  })

  it("rolls back a failed compaction and leaves the previous content intact", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(1))
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const broken = state(2)
    broken.dbs.CogniaDB.rows.sessions = { "s:bad": circular }
    await expect(backend.compact(broken)).rejects.toThrow()
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(1)
    expect(loaded.dbs.CogniaDB.rows.sessions).toEqual(state(1).dbs.CogniaDB.rows.sessions)
  })

  it("exposes an async commit wrapper for tooling", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    await backend.commit(commit(1, "s:z", { id: "z" }))
    expect(backend.lastSequence()).toBe(1)
    await backend.close()
  })

  it("truncates the WAL on compact and stays readable", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(3))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.sequence).toBe(3)
  })

  it("collects old orphan binaries and keeps the ones a row references", async () => {
    const backend = openSqliteBackend({ root })
    try {
      await backend.compact(state(0))
      const value = encodeDurableValue(new Uint8Array(65536).fill(1), root)
      backend.commitSync(commit(1, "s:binary", value))
      const referenced = fs.readdirSync(binaryDir(root))[0]
      encodeDurableValue(new Uint8Array(65536).fill(2), root)
      const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
      for (const name of fs.readdirSync(binaryDir(root))) {
        fs.utimesSync(path.join(binaryDir(root), name), old, old)
      }
      backend.maintain!()
      expect(fs.readdirSync(binaryDir(root))).toEqual([referenced])
      backend.commitSync(commit(2, "s:binary", null))
      backend.maintain!()
      expect(fs.readdirSync(binaryDir(root))).toEqual([])
    } finally {
      await backend.close()
    }
  })

  it("surfaces a busy WAL checkpoint while a reader retains its snapshot", async () => {
    const backend = openSqliteBackend({ root })
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {})
    let reader: DatabaseSync | undefined
    try {
      await backend.compact(state(1))
      reader = new DatabaseSync(sqliteFile(root), { readOnly: true })
      reader.exec("BEGIN")
      reader.prepare("SELECT * FROM durability_meta").all()
      backend.commitSync(commit(2, "s:large", { text: "x".repeat(1024 * 1024) }))
      const bytes = fs.statSync(`${sqliteFile(root)}-wal`).size
      expect(bytes).toBeGreaterThan(0)
      expect(backend.maintain!()).toMatchObject({ busy: true })
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("busy"))
      expect(fs.statSync(`${sqliteFile(root)}-wal`).size).toBe(bytes)
      reader.exec("ROLLBACK")
      expect(backend.maintain!()).toMatchObject({ busy: false })
      expect(fs.statSync(`${sqliteFile(root)}-wal`).size).toBe(0)
    } finally {
      reader?.close()
      await backend.close()
      warning.mockRestore()
    }
  })

  it("skips binary collection while no side file is past the grace period", async () => {
    const backend = openSqliteBackend({ root })
    try {
      await backend.compact(state(0))
      encodeDurableValue(new Uint8Array(65536).fill(4), root)
      expect(backend.maintain().prunedBinaries).toEqual([])
      expect(fs.readdirSync(binaryDir(root))).toHaveLength(1)
    } finally {
      await backend.close()
    }
  })

  it("closes idempotently", async () => {
    const backend = openSqliteBackend({ root })
    await backend.close()
    await expect(backend.close()).resolves.toBeUndefined()
  })
})

describe("collectSqliteBinaryReferences", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("references nothing when no store exists", () => {
    expect([...collectSqliteBinaryReferences(root, new Set())]).toEqual([])
  })

  it("reads the side files every stored row references", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:bin", encodeDurableValue(new Uint8Array(65536).fill(5), root)))
    await backend.close()
    const files = fs.readdirSync(binaryDir(root)).filter((name) => /^[0-9a-f]{64}$/.test(name))
    expect(files).toHaveLength(1)
    expect([...collectSqliteBinaryReferences(root, new Set())]).toEqual(files)
  })
})

describe("compactSqlite", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("refuses a root without a store", () => {
    expect(() => compactSqlite(root)).toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
  })

  it("vacuums a stopped store and keeps its content", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:big", { text: "x".repeat(256 * 1024) }))
    backend.commitSync(commit(2, "s:big", null))
    await backend.close()
    const result = compactSqlite(root)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
    const reopened = openSqliteBackend({ root })
    try {
      const loaded = await reopened.load()
      expect(loaded.sequence).toBe(2)
      expect(loaded.dbs.CogniaDB.rows.sessions).toEqual(state(0).dbs.CogniaDB.rows.sessions)
    } finally {
      await reopened.close()
    }
  })

  it("refuses while a writer holds the store", async () => {
    const backend = openSqliteBackend({ root })
    try {
      expect(() => compactSqlite(root)).toThrow(expect.objectContaining({ code: "writer-busy" }))
    } finally {
      await backend.close()
    }
  })
})

/** A `node:sqlite` stand-in that answers the backend's fixed statement set. */
function fakeDb(opts: {
  schemas?: Array<Record<string, unknown>>
  rows?: Array<Record<string, unknown>>
}): import("./sqlite").SqliteDatabaseLike {
  return {
    exec: () => {},
    close: () => {},
    prepare(sql: string) {
      return {
        run: () => {},
        get: () => undefined,
        all: () => {
          if (sql.includes("integrity_check")) return [{ integrity_check: "ok" }]
          if (sql.includes("FROM durability_schema")) return opts.schemas ?? []
          // Rows default to codec 1 so the codec branch is the one exercised.
          if (sql.includes("FROM durability_rows"))
            return (opts.rows ?? []).map((row) => ({ value_codec: 1, ...row }))
          return []
        },
      }
    },
  }
}

describe("sqlite corruption", () => {
  const root = "/unused-because-open-is-injected"

  it("faults when a stored row value is not readable JSON", async () => {
    const backend = openSqliteBackend({
      root,
      open: () =>
        fakeDb({
          schemas: [{ database: "CogniaDB", version: 141, tables: '["sessions"]' }],
          rows: [{ database: "CogniaDB", table_name: "sessions", row_key: "s:a", value: "{oops" }],
        }),
    })
    await expect(backend.load()).rejects.toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
  })

  it("faults when a schema row holds an unreadable table list", async () => {
    const backend = openSqliteBackend({
      root,
      open: () => fakeDb({ schemas: [{ database: "CogniaDB", version: 141, tables: "{oops" }] }),
    })
    await expect(backend.load()).rejects.toThrow(/unreadable table list/)
  })

  it("faults when a row's table is not listed in its schema row", async () => {
    const backend = openSqliteBackend({
      root,
      open: () =>
        fakeDb({
          schemas: [{ database: "CogniaDB", version: 141, tables: '["sessions"]' }],
          rows: [{ database: "CogniaDB", table_name: "unlisted", row_key: "s:a", value: "1" }],
        }),
    })
    await expect(backend.load()).rejects.toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
    await expect(backend.load()).rejects.toThrow(/does not list/)
  })

  it("ignores rows addressed at a database with no schema row", async () => {
    const backend = openSqliteBackend({
      root,
      open: () =>
        fakeDb({
          schemas: [],
          rows: [{ database: "Gone", table_name: "sessions", row_key: "s:a", value: "1" }],
        }),
    })
    await expect(backend.load()).resolves.toEqual({ sequence: 0, dbs: {} })
  })
})

describe("assertIntegrity", () => {
  it("passes on an ok verdict", () => {
    const db = {
      exec: () => {},
      prepare: () => ({
        run: () => {},
        get: () => undefined,
        all: () => [{ integrity_check: "ok" }],
      }),
      close: () => {},
    }
    expect(() => assertIntegrity(db)).not.toThrow()
  })

  it("faults on any other verdict", () => {
    const db = {
      exec: () => {},
      prepare: () => ({
        run: () => {},
        get: () => undefined,
        all: () => [{ integrity_check: "row 3 missing from index" }],
      }),
      close: () => {},
    }
    expect(() => assertIntegrity(db)).toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
  })

  it("faults when the pragma returns nothing", () => {
    const db = {
      exec: () => {},
      prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
      close: () => {},
    }
    expect(() => assertIntegrity(db)).toThrow(/no result/)
  })
})

describe("value codec", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("writes committed rows as codec 1", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:x", { id: "x", meta: {} }))
    await backend.close()
    const db = new DatabaseSync(sqliteFile(root))
    const row = db
      .prepare(`SELECT value_codec FROM ${SQLITE_ROWS_TABLE} WHERE row_key = 's:x'`)
      .get() as { value_codec: number }
    db.close()
    expect(row.value_codec).toBe(1)
    const reopened = openSqliteBackend({ root })
    expect((await reopened.load()).dbs.CogniaDB.rows.sessions["s:x"]).toEqual({
      id: "x",
      meta: {},
    })
    await reopened.close()
  })

  it("ignores the rows table of a store written before value codec 1", async () => {
    fs.mkdirSync(path.dirname(sqliteFile(root)), { recursive: true })
    const db = new DatabaseSync(sqliteFile(root))
    db.exec(`
      CREATE TABLE durability_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE durability_schema (database TEXT PRIMARY KEY, version INTEGER NOT NULL, tables TEXT NOT NULL) STRICT;
      CREATE TABLE durability_rows (
        database TEXT NOT NULL REFERENCES durability_schema(database) ON DELETE CASCADE,
        table_name TEXT NOT NULL, row_key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (database, table_name, row_key)
      ) STRICT, WITHOUT ROWID;
    `)
    db.prepare("INSERT INTO durability_meta VALUES ('sequence', '3')").run()
    db.prepare("INSERT INTO durability_schema VALUES ('CogniaDB', 141, '[\"media\"]')").run()
    db.prepare("INSERT INTO durability_rows VALUES ('CogniaDB', 'media', 's:a', '{}')").run()
    db.close()

    const backend = openSqliteBackend({ root })
    expect((await backend.load()).dbs.CogniaDB.rows.media).toEqual({})
    await backend.close()
  })

  it.each([0, 2])("refuses a row with value codec %s", async (codec) => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    await backend.close()
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE ${SQLITE_ROWS_TABLE} SET value_codec = ?`).run(codec)
    db.close()
    const reopened = openSqliteBackend({ root })
    await expect(reopened.load()).rejects.toThrow(`unsupported value codec ${codec}`)
    await reopened.close()
  })
})
