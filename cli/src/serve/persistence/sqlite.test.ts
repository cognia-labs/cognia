import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  assertIntegrity,
  asSqliteBackend,
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

  it("starts empty", async () => {
    const backend = openSqliteBackend({ root })
    expect(await backend.load()).toEqual({ sequence: 0, dbs: {} })
    expect(backend.id).toBe("sqlite-v5")
    await backend.close()
  })

  it("round-trips a full state through replaceAll", async () => {
    const backend = openSqliteBackend({ root })
    asSqliteBackend(backend)!.replaceAll(state(4))
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
    // The journal lists it the same way; a restart re-declares it from this list.
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

  it("treats an already-applied sequence as a no-op (dual-write redelivery)", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    backend.commitSync(commit(1, "s:b", { id: "b" }))
    backend.commitSync(commit(1, "s:b", { id: "SHOULD-NOT-APPLY" }))
    const loaded = await backend.load()
    await backend.close()
    expect(loaded.dbs.CogniaDB.rows.sessions["s:b"]).toEqual({ id: "b" })
    expect(loaded.sequence).toBe(1)
  })

  it("rejects a sequence gap", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    expect(() => backend.commitSync(commit(3, "s:c", 1))).toThrow(
      expect.objectContaining({ code: "journal-sequence-gap" })
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

  it("rolls back a failed replaceAll and leaves the previous content intact", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(1))
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const broken = state(2)
    broken.dbs.CogniaDB.rows.sessions = { "s:bad": circular }
    expect(() => asSqliteBackend(backend)!.replaceAll(broken)).toThrow()
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

  it("closes idempotently", async () => {
    const backend = openSqliteBackend({ root })
    await backend.close()
    await expect(backend.close()).resolves.toBeUndefined()
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

describe("asSqliteBackend", () => {
  it("narrows only the sqlite backend", async () => {
    const root = tempRoot()
    try {
      const backend = openSqliteBackend({ root })
      expect(asSqliteBackend(backend)).not.toBeNull()
      await backend.close()
      expect(asSqliteBackend({ ...backend, id: "journal-v4" })).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("value codec", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  /** A store exactly as a build before value codec 1 left it. */
  function writeLegacyStore(rows: Array<[string, unknown]>): void {
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
    for (const [key, value] of rows) {
      db.prepare("INSERT INTO durability_rows VALUES ('CogniaDB', 'media', ?, ?)").run(
        key,
        JSON.stringify(value)
      )
    }
    db.close()
  }

  it("moves an old store onto the codec-1 table, normalises its rows and reports lossy shapes", async () => {
    writeLegacyStore([
      ["s:a", { id: "a", blob: {}, at: { __date: "2026-11-01T00:00:00.000Z" } }],
      ["s:b", { id: "b", pixels: { "0": 1, "1": 2 } }],
    ])
    const backend = openSqliteBackend({ root })
    const state = await backend.load()
    expect(state.sequence).toBe(3)
    expect(state.dbs.CogniaDB.rows.media["s:a"]).toMatchObject({
      at: { $cogniaSnapshotValue: { type: "date" } },
    })
    expect(state.legacyValueFindings?.map((f) => [f.path, f.shape, f.sampleKeys])).toEqual([
      ["blob", "empty-object", ["s:a"]],
      ["pixels", "index-keyed-object", ["s:b"]],
    ])
    const inspect = new DatabaseSync(sqliteFile(root), { readOnly: true })
    expect(
      inspect.prepare("SELECT type FROM sqlite_master WHERE name = 'durability_rows'").get()
    ).toEqual({ type: "view" })
    expect(
      inspect
        .prepare(`SELECT row_key, value_codec FROM ${SQLITE_ROWS_TABLE} ORDER BY row_key`)
        .all()
    ).toEqual([
      { row_key: "s:a", value_codec: 0 },
      { row_key: "s:b", value_codec: 0 },
    ])
    inspect.close()

    // Rewritten rows are codec 1: the lossy-looking `{}` is now a real `{}`.
    await backend.compact(state)
    const reloaded = await backend.load()
    expect(reloaded.legacyValueFindings).toBeUndefined()
    expect(reloaded.dbs.CogniaDB.rows.media["s:a"]).toEqual(state.dbs.CogniaDB.rows.media["s:a"])
    await backend.close()
  })

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
    expect((await reopened.load()).legacyValueFindings).toBeUndefined()
    await reopened.close()
  })

  it("stops a build from before value codec 1 at open, before it writes anything", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    const encoded = { id: "x", at: { $cogniaSnapshotValue: { version: 1, type: "date", time: 0 } } }
    backend.commitSync(commit(1, "s:x", encoded))
    await backend.close()

    // The statements that build ran at open, in its order.
    const old = new DatabaseSync(sqliteFile(root))
    old.exec(`
      CREATE TABLE IF NOT EXISTS durability_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS durability_schema (database TEXT PRIMARY KEY, version INTEGER NOT NULL, tables TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS durability_rows (
        database TEXT NOT NULL REFERENCES durability_schema(database) ON DELETE CASCADE,
        table_name TEXT NOT NULL, row_key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (database, table_name, row_key)
      ) STRICT, WITHOUT ROWID;
    `)
    const select = old.prepare("SELECT database, table_name, row_key, value FROM durability_rows")
    expect(() =>
      old.prepare(
        "INSERT INTO durability_rows (database, table_name, row_key, value) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(database, table_name, row_key) DO UPDATE SET value = excluded.value"
      )
    ).toThrow(/because it is a view/)
    // A reader that only selects gets an error, never an undecoded value.
    expect(() => select.all()).toThrow(/malformed JSON/)
    old.close()

    const reopened = openSqliteBackend({ root })
    const reloaded = await reopened.load()
    expect(reloaded.legacyValueFindings).toBeUndefined()
    expect(reloaded.dbs.CogniaDB.rows.sessions["s:x"]).toEqual(encoded)
    await reopened.close()
  })

  it("faults instead of opening empty when the rows table behind the tombstone is gone", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(3))
    await backend.close()
    const db = new DatabaseSync(sqliteFile(root))
    db.exec("PRAGMA foreign_keys = OFF;")
    db.exec("DROP VIEW durability_rows;")
    db.exec(`DROP TABLE ${SQLITE_ROWS_TABLE};`)
    db.exec(`
      CREATE VIEW durability_rows AS SELECT 'x' AS database, 'x' AS table_name, 'x' AS row_key, 'x' AS value;
    `)
    db.close()
    expect(() => openSqliteBackend({ root })).toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
  })

  it("opens a migrated store again, from another connection, without redoing the move", async () => {
    writeLegacyStore([["s:a", { id: "a" }]])
    const first = openSqliteBackend({ root })
    const second = openSqliteBackend({ root })
    expect((await second.load()).dbs.CogniaDB.rows.media).toEqual({ "s:a": { id: "a" } })
    await first.close()
    await second.close()
  })

  it("refuses a row from an unknown future value codec", async () => {
    const backend = openSqliteBackend({ root })
    await backend.compact(state(0))
    await backend.close()
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE ${SQLITE_ROWS_TABLE} SET value_codec = 2`).run()
    db.close()
    const reopened = openSqliteBackend({ root })
    await expect(reopened.load()).rejects.toThrow(/unsupported value codec 2/)
    await reopened.close()
  })
})
