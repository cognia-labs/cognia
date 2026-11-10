import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { openBackend, resolveBackend } from "./backend"
import { BINARY_PRUNE_GRACE_MS, binaryDir, writeBinarySync } from "./binary-store"
import { generationDir, listGenerations, readCheckpoint, writeCheckpoint } from "./checkpoint"
import { encodeCommitLine, journalFile } from "./journal"
import { manifestFile, readManifest, writeManifest } from "./manifest"
import { openSqliteBackend, sqliteFile } from "./sqlite"
import {
  finalizeDurability,
  firstGeneration,
  listRollbackBundles,
  migrateDurability,
  parseBackendArgument,
  readJournalState,
  recoverDurability,
  rollbackDurability,
  verifyDurability,
  writeRollbackBundle,
} from "./operations"
import type { DurabilityCommit, DurabilityState } from "./types"
import { decodeDurableValue, encodeDurableValue, readLegacyValueReport } from "./value-codec"
import { hasLiveWriter } from "./writer-lock"

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

async function seedJournal(root: string, commits: DurabilityCommit[]): Promise<void> {
  writeCheckpoint(root, "gen-0001", state(0))
  const backend = openBackend("journal-v4", root)
  await backend.load()
  for (const c of commits) backend.commitSync(c)
  await backend.close()
}

describe("verifyDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it.each(["petConversation", "uninstalled-plugin:records"])(
    "skips %s in v219 single-file and format-4 snapshots without reporting a fault",
    async (skippedTable) => {
      const snapshot = path.join(root, "db-account.json")
      const rows = {
        messages: [{ id: "message-1" }],
        [skippedTable]: [{ id: "legacy", value: {} }],
      }
      const bytes = JSON.stringify({ version: 219, tables: rows })
      fs.writeFileSync(snapshot, bytes)
      const tables = `${snapshot}.tables`
      fs.mkdirSync(tables)
      const manifest = JSON.stringify({
        snapshotFormat: 4,
        dbs: { CogniaDB: { version: 219, tables: Object.keys(rows) } },
      })
      fs.writeFileSync(path.join(tables, "manifest.json"), manifest)
      for (const [table, values] of Object.entries(rows)) {
        fs.writeFileSync(
          path.join(tables, `CogniaDB--${encodeURIComponent(table)}.json`),
          JSON.stringify(values)
        )
      }
      const skippedFile = path.join(tables, `CogniaDB--${encodeURIComponent(skippedTable)}.json`)
      // Restore never reads a skipped table, even when its file is absent or corrupt.
      for (const skippedRows of [JSON.stringify(rows[skippedTable]), "{broken", null]) {
        if (skippedRows === null) fs.rmSync(skippedFile)
        else fs.writeFileSync(skippedFile, skippedRows)
        for (const target of [snapshot, tables]) {
          const status = await verifyDurability(target)
          expect(status.faults).toEqual([])
          expect(status).toMatchObject({
            skippedSnapshotTables: [{ database: "CogniaDB", table: skippedTable }],
            legacyValueLoss: [],
          })
        }
        expect(fs.readFileSync(snapshot, "utf8")).toBe(bytes)
        expect(fs.readFileSync(path.join(tables, "manifest.json"), "utf8")).toBe(manifest)
        expect(fs.existsSync(skippedFile)).toBe(skippedRows !== null)
        if (skippedRows !== null) expect(fs.readFileSync(skippedFile, "utf8")).toBe(skippedRows)
      }
    }
  )

  it("fails a snapshot whose every table restore would skip", async () => {
    const rows = {
      petConversation: [{ id: "legacy" }],
      "uninstalled-plugin:records": [{ id: "plugin-row" }],
    }
    const snapshot = path.join(root, "db-account.json")
    fs.writeFileSync(snapshot, JSON.stringify({ version: 219, tables: rows }))
    const tables = `${snapshot}.tables`
    fs.mkdirSync(tables)
    // Missing table files: restore would never read them, so nothing here is restorable.
    fs.writeFileSync(
      path.join(tables, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 4,
        dbs: { CogniaDB: { version: 219, tables: Object.keys(rows) } },
      })
    )
    for (const target of [snapshot, tables]) {
      expect((await verifyDurability(target)).faults).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("restore would load none of them"),
        }),
      ])
    }
  })

  it("skips derived table files before decoding while still checking authoritative tables", async () => {
    const tables = path.join(root, "db-account.json.tables")
    fs.mkdirSync(tables)
    fs.writeFileSync(
      path.join(tables, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 4,
        dbs: { CogniaDB: { version: 241, tables: ["sessionList", "messages"] } },
      })
    )
    const messages = path.join(tables, "CogniaDB--messages.json")
    fs.writeFileSync(messages, '[{"id":"message-1"}]')
    expect(await verifyDurability(tables)).toMatchObject({
      faults: [],
      skippedSnapshotTables: [{ database: "CogniaDB", table: "sessionList" }],
    })
    fs.writeFileSync(messages, "[{}]")
    expect((await verifyDurability(tables)).faults).toEqual([
      expect.objectContaining({ message: expect.stringContaining("messages") }),
    ])
  })

  it.each<[string, unknown[]]>([
    ["messages", [null]],
    ["messages", [{}]],
    ["messages", [{ id: true }]],
    ["messages", [{ id: {} }]],
    ["accountSyncOutbox", [{ table: "messages" }]],
    ["accountSyncOutbox", [{ table: "messages", rowId: null }]],
    ["github-delivery:repos", [{ id: "wrong-key-path" }]],
    [
      "github-delivery:audit",
      [
        { runId: "run", stepId: "step", at: 1 },
        { runId: "run", stepId: "step", at: 1 },
      ],
    ],
  ])("rejects unrestorable snapshot rows in %s: %j", async (table, rows) => {
    const snapshot = path.join(root, "db-account.json")
    fs.writeFileSync(snapshot, JSON.stringify({ version: 1, tables: { [table]: rows } }))
    const tables = `${snapshot}.tables`
    fs.mkdirSync(tables)
    fs.writeFileSync(
      path.join(tables, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 4,
        dbs: { "cognia-account-test": { version: 1, tables: [table] } },
      })
    )
    const file = path.join(tables, `cognia-account-test--${encodeURIComponent(table)}.json`)
    fs.writeFileSync(file, JSON.stringify(rows))
    for (const target of [tables, snapshot]) {
      const before = fs.readFileSync(target === snapshot ? snapshot : file, "utf8")
      const status = await verifyDurability(target)
      expect(status.faults).toEqual([
        expect.objectContaining({ message: expect.stringContaining(table) }),
      ])
      expect(fs.readFileSync(target === snapshot ? snapshot : file, "utf8")).toBe(before)
    }
  })

  it("restores compound, non-id and auto-increment primary keys from the production schemas", async () => {
    const snapshot = path.join(root, "db-account.json")
    const rows = {
      accountSyncOutbox: [{ table: "messages", rowId: "row-1" }],
      "github-delivery:repos": [{ fullName: "owner/repo" }],
      "github-delivery:workOrders": [{ status: "new" }],
    }
    fs.writeFileSync(snapshot, JSON.stringify({ version: 1, tables: rows }))
    expect((await verifyDurability(snapshot)).faults).toEqual([])
    const tables = `${snapshot}.tables`
    fs.mkdirSync(tables)
    fs.writeFileSync(
      path.join(tables, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 4,
        dbs: { CogniaDB: { version: 1, tables: Object.keys(rows) } },
      })
    )
    for (const [table, values] of Object.entries(rows)) {
      fs.writeFileSync(
        path.join(tables, `CogniaDB--${encodeURIComponent(table)}.json`),
        JSON.stringify(values)
      )
    }
    expect((await verifyDurability(tables)).faults).toEqual([])
  })

  it.each([3, 4])(
    "verifies format-%s table stores with the shared binary codec",
    async (format) => {
      const tables = path.join(root, "db-legacy.json.tables")
      const value = encodeDurableValue(new Uint8Array(20000), tables)
      const manifest = path.join(tables, "manifest.json")
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          snapshotFormat: format,
          dbs: { "db /": { version: 1, tables: ["github-delivery:repos"] } },
        })
      )
      const rows = path.join(tables, "db%20%2F--github-delivery%3Arepos.json")
      fs.writeFileSync(rows, JSON.stringify([{ fullName: "owner/repo", value }]))
      expect((await verifyDurability(tables)).faults).toEqual([])
      fs.rmSync(binaryDir(tables), { recursive: true })
      expect((await verifyDurability(tables)).faults).toEqual([
        expect.objectContaining({ message: expect.stringContaining("is missing") }),
      ])
      fs.writeFileSync(rows, "{}")
      expect((await verifyDurability(tables)).faults).toEqual([
        expect.objectContaining({ message: expect.stringContaining("not an array") }),
      ])
      fs.writeFileSync(manifest, "{broken")
      expect((await verifyDurability(tables)).faults).not.toEqual([])
    }
  )

  it("checks the table store selected by an active snapshot manifest", async () => {
    const ledger = path.join(root, "durability", "legacy%20account")
    const tables = path.join(root, "db-legacy account.json.tables")
    fs.mkdirSync(tables, { recursive: true })
    fs.writeFileSync(
      path.join(tables, "manifest.json"),
      JSON.stringify({
        snapshotFormat: 4,
        dbs: { CogniaDB: { version: 1, tables: ["sessions"] } },
      })
    )
    const rows = path.join(tables, "CogniaDB--sessions.json")
    fs.writeFileSync(rows, "[]")
    writeManifest(ledger, { ...readManifest(ledger), activeBackend: "snapshot-v3" })
    expect((await verifyDurability(ledger)).faults).toEqual([])
    fs.rmSync(rows)
    expect((await verifyDurability(ledger)).faults).not.toEqual([])
  })

  it("checks a single-file snapshot selected by an active snapshot manifest read-only", async () => {
    const ledger = path.join(root, "durability", "legacy%20account")
    const file = path.join(root, "db-legacy account.json")
    const bytes = JSON.stringify({ version: 1, tables: { messages: [{ id: "message-1" }] } })
    fs.writeFileSync(file, bytes)
    writeManifest(ledger, { ...readManifest(ledger), activeBackend: "snapshot-v3" })
    expect((await verifyDurability(ledger)).faults).toEqual([])
    expect(fs.readFileSync(file, "utf8")).toBe(bytes)
    fs.writeFileSync(file, "{broken")
    expect((await verifyDurability(ledger)).faults).toEqual([
      expect.objectContaining({ message: expect.stringContaining("invalid JSON") }),
    ])
  })

  it("reports an empty account with no faults", async () => {
    const status = await verifyDurability(root)
    expect(status.faults).toEqual([])
    expect(status.generations).toEqual([])
    expect(status.sqlitePresent).toBe(false)
  })

  it("faults on a nonexistent root without creating it", async () => {
    const missing = path.join(root, "missing")
    expect((await verifyDurability(missing)).faults).not.toEqual([])
    expect(fs.existsSync(missing)).toBe(false)
  })

  it.each([
    ["sqlite-v5", null],
    ["journal-v4", "sqlite-v5"],
    ["sqlite-v5", "journal-v4"],
  ] as const)(
    "faults when a manifest names an absent backend (%s / %s)",
    async (activeBackend, shadowBackend) => {
      if (activeBackend === "journal-v4" || shadowBackend === null)
        writeCheckpoint(root, "gen-0001", state(1))
      else {
        const sqlite = openBackend("sqlite-v5", root)
        await sqlite.compact(state(1))
        await sqlite.close()
      }
      writeManifest(root, { ...readManifest(root), activeBackend, shadowBackend })
      expect((await verifyDurability(root)).faults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("missing") }),
        ])
      )
    }
  )

  it("faults on the same unpinned journal/SQLite ambiguity boot refuses", async () => {
    writeCheckpoint(root, "gen-0001", state(1))
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(1))
    await sqlite.close()
    expect((await verifyDurability(root)).faults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "manifest-corrupt",
          message: expect.stringContaining("both journal and sqlite"),
        }),
      ])
    )
  })

  it("reports both missing stores instead of stopping at the first", async () => {
    writeManifest(root, {
      ...readManifest(root),
      activeBackend: "journal-v4",
      shadowBackend: "sqlite-v5",
    })
    expect((await verifyDurability(root)).faults.map((fault) => fault.message)).toEqual([
      "manifest backend journal-v4 is missing",
      "manifest backend sqlite-v5 is missing",
    ])
  })

  it.each(["journal-v4", "sqlite-v5"] as const)(
    "reports a missing content-addressed binary in %s",
    async (id) => {
      const value = encodeDurableValue(new Uint8Array(65536), root)
      if (id === "journal-v4") writeCheckpoint(root, "gen-0001", state(1, { "s:a": value }))
      else {
        const sqlite = openBackend(id, root)
        try {
          await sqlite.compact(state(1, { "s:a": value }))
        } finally {
          await sqlite.close()
        }
      }
      fs.rmSync(binaryDir(root), { recursive: true })
      expect((await verifyDurability(root)).faults).toEqual([
        expect.objectContaining({ message: expect.stringContaining("is missing") }),
      ])
    }
  )

  it("inspects legacy SQLite without migrating it or changing its hash", async () => {
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
    const hash = () => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    const before = hash()
    expect((await verifyDurability(root)).faults).toEqual([])
    expect(hash()).toBe(before)
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      expect(
        reader.prepare("SELECT type FROM sqlite_master WHERE name='durability_rows'").get()
      ).toEqual({ type: "table" })
      expect(
        reader.prepare("SELECT name FROM sqlite_master WHERE name='durability_rows_codec1'").get()
      ).toBeUndefined()
    } finally {
      reader.close()
    }
  })

  it("does not compare SQLite with a deliberately detached journal", async () => {
    writeCheckpoint(root, "gen-0001", state(1))
    const sqlite = openBackend("sqlite-v5", root)
    try {
      await sqlite.compact(state(1))
      writeManifest(root, {
        ...readManifest(root),
        activeBackend: "sqlite-v5",
        shadowBackend: "journal-v4",
      })
      finalizeDurability(root, "gen-0001", { confirm: true })
      sqlite.commitSync(commit(2, "s:a", { id: "a" }))
    } finally {
      await sqlite.close()
    }
    const status = await verifyDurability(root)
    expect(status.parity).toBeNull()
    expect(status.faults).toEqual([])
  })

  it("reports generations, checkpoint and journal sequences", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    const status = await verifyDurability(root)
    expect(status.generations).toEqual(["gen-0001"])
    expect(status.checkpointSequence).toBe(0)
    expect(status.journalCommits).toBe(2)
    expect(status.journalSequence).toBe(2)
    expect(status.faults).toEqual([])
  })

  it("reports the torn trailing bytes it discarded", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    fs.appendFileSync(journalFile(root, "gen-0001"), '{"sequence":2,"mut')
    const status = await verifyDurability(root)
    expect(status.journalDiscardedBytes).toBeGreaterThan(0)
    expect(status.faults).toEqual([])
  })

  it("surfaces a checksum fault without hiding the rest of the report", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"id":"a"', '"id":"z"'))
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["journal-checksum-mismatch"])
    expect(status.generations).toEqual(["gen-0001"])
  })

  it("surfaces a sequence gap", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    fs.writeFileSync(
      journalFile(root, "gen-0001"),
      encodeCommitLine(commit(1, "s:a", 1)) + encodeCommitLine(commit(3, "s:c", 3))
    )
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["journal-sequence-gap"])
  })

  it("reports a parity mismatch between the journal and sqlite", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(1, { "s:a": { id: "DIFFERENT" } }))
    await sqlite.close()
    const status = await verifyDurability(root)
    expect(status.parity?.ok).toBe(false)
    expect(status.faults.map((f) => f.code)).toContain("parity-mismatch")
  })

  it.each([
    ["a row that stays", [{ id: "k" }]],
    ["a row then deleted", [{ id: "k" }, null]],
    ["only a delete", [null]],
  ])(
    "finds the journal and sqlite in parity after %s in a table added since the checkpoint",
    async (_case, values) => {
      const commits: DurabilityCommit[] = values.map((value, index) => ({
        sequence: index + 1,
        committedAt: index + 1,
        mutations: [{ database: "CogniaDB", table: "added", key: "s:k", value }],
      }))
      await seedJournal(root, commits)
      const sqlite = openBackend("sqlite-v5", root)
      await sqlite.compact(state(0))
      for (const late of commits) sqlite.commitSync(late)
      await sqlite.close()
      writeManifest(root, { ...readManifest(root), shadowBackend: "sqlite-v5" })
      const status = await verifyDurability(root)
      // Both list a table from its first commit; before, the journal dropped it and sqlite left it unlisted.
      expect(status.parity).toMatchObject({ ok: true, mismatches: [] })
      expect(status.faults).toEqual([])
    }
  )

  it("tolerates a corrupt manifest rather than refusing to report", async () => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "backend-manifest.json"), "{oops")
    const status = await verifyDurability(root)
    expect(status.manifest.activeBackend).toBe("journal-v4")
    expect(status.faults).toEqual([expect.objectContaining({ code: "manifest-corrupt" })])
  })

  it("records a non-fault error as a manifest-corrupt entry", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    // A directory where the journal file should be: `readFileSync` throws a
    // plain EISDIR Error, not a DurabilityFault.
    fs.mkdirSync(journalFile(root, "gen-0001"), { recursive: true })
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["manifest-corrupt"])
  })

  it("surfaces a corrupt checkpoint", async () => {
    writeCheckpoint(root, "gen-0001", state(0))
    fs.writeFileSync(path.join(generationDir(root, "gen-0001"), "checkpoint.json"), "{oops")
    const status = await verifyDurability(root)
    expect(status.faults.map((f) => f.code)).toEqual(["checkpoint-corrupt"])
  })
})

describe("readJournalState", () => {
  it("returns an empty state when nothing exists", () => {
    const root = tempRoot()
    try {
      expect(readJournalState(root)).toEqual({ sequence: 0, dbs: {} })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("rollback bundles", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
    writeCheckpoint(root, "gen-0001", state(4))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("freezes the manifest and generation, numbered monotonically", () => {
    const first = writeRollbackBundle(root, "one", () => 1)
    const second = writeRollbackBundle(root, "two", () => 2)
    expect([first.id, second.id]).toEqual(["bundle-0001", "bundle-0002"])
    expect(first.generation).toBe("gen-0001")
    expect(first.sequence).toBe(4)
    expect(listRollbackBundles(root).map((b) => b.reason)).toEqual(["one", "two"])
  })

  it("writes bundles read-only so they cannot be edited in place", () => {
    const bundle = writeRollbackBundle(root, "one")
    if (process.platform === "win32") return
    const file = path.join(root, "rollback", `${bundle.id}.json`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o400)
  })

  it("lists nothing when no bundle was ever written", () => {
    expect(listRollbackBundles(tempRoot())).toEqual([])
  })
})

describe("migrateDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("preserves an unpinned SQLite store on SQLite self-migration", async () => {
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(42, { "s:a": { id: "a" } }))
    await sqlite.close()
    expect(fs.existsSync(manifestFile(root))).toBe(false)
    const before = fs.readFileSync(sqliteFile(root))
    await expect(migrateDurability(root, "sqlite-v5")).rejects.toThrow(/already on sqlite-v5/)
    expect(fs.readFileSync(sqliteFile(root))).toEqual(before)
    const reopened = openBackend("sqlite-v5", root)
    try {
      expect(await reopened.load()).toEqual(state(42, { "s:a": { id: "a" } }))
    } finally {
      await reopened.close()
    }
  })

  it("uses the unpinned SQLite inventory when migrating to journal", async () => {
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(42, { "s:a": { id: "a" } }))
    await sqlite.close()
    expect((await migrateDurability(root, "journal-v4")).from).toBe("sqlite-v5")
    expect(readJournalState(root)).toEqual(state(42, { "s:a": { id: "a" } }))
  })

  it("copies the journal into sqlite, verifies parity, and promotes", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    const result = await migrateDurability(root, "sqlite-v5", { now: () => 100 })
    expect(result.promoted).toBe(true)
    expect(result.parity.ok).toBe(true)
    expect(readManifest(root)).toMatchObject({
      activeBackend: "sqlite-v5",
      shadowBackend: "journal-v4",
    })

    const sqlite = openBackend("sqlite-v5", root)
    const migrated = await sqlite.load()
    await sqlite.close()
    expect(migrated.sequence).toBe(2)
    expect(migrated.dbs.CogniaDB.rows.sessions).toEqual({
      "s:a": { id: "a" },
      "s:b": { id: "b" },
    })
  })

  it("writes a rollback bundle before touching anything", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    const result = await migrateDurability(root, "sqlite-v5")
    expect(listRollbackBundles(root)).toHaveLength(1)
    expect(result.bundle.manifest.activeBackend).toBe("journal-v4")
  })

  it("pins the manifest when the account has never been opted in", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    const result = await migrateDurability(root, "journal-v4", { now: () => 7 })
    expect(result.promoted).toBe(true)
    expect(readManifest(root).activeBackend).toBe("journal-v4")
    expect(listRollbackBundles(root).map((b) => b.reason)).toEqual(["pin journal-v4"])
  })

  it("refuses a second migration onto the already-pinned backend", async () => {
    await seedJournal(root, [])
    await migrateDurability(root, "journal-v4")
    await expect(migrateDurability(root, "journal-v4")).rejects.toThrow(/already on journal-v4/)
  })

  it("leaves the incumbent active when parity fails", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const result = await migrateDurability(root, "sqlite-v5", {
      verify: () => ({
        ok: false,
        comparedRows: 1,
        mismatches: [
          {
            kind: "content-hash",
            database: "CogniaDB",
            table: "sessions",
            expected: "a",
            actual: "b",
          },
        ],
      }),
    })
    expect(result.promoted).toBe(false)
    expect(readManifest(root).activeBackend).toBe("journal-v4")
    expect(readManifest(root).shadowBackend).toBeNull()
  })
})

describe("recoverDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("pins candidate binaries while an online writer deletes the last reference before publication", async () => {
    const bytes = new Uint8Array(65536).fill(17)
    const encoded = encodeDurableValue(bytes, root)
    const writer = openSqliteBackend({ root })
    await writer.compact(state(1, { "s:binary": encoded }))
    writeManifest(root, { ...readManifest(root), activeBackend: "sqlite-v5" })
    const file = path.join(binaryDir(root), createHash("sha256").update(bytes).digest("hex"))
    const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
    fs.utimesSync(file, old, old)
    try {
      // Candidate collection runs before recover's first await continuation.
      const recovery = recoverDurability(root, "sqlite")
      writer.commitSync(commit(2, "s:binary", null))
      const maintenance = writer.maintain()
      const result = await recovery
      expect(maintenance.prunedBinaries).toEqual([])
      expect(result).toMatchObject({ activated: false, parity: { ok: true }, sequence: 1 })
      const staged = readCheckpoint(root, result.generation)
      expect(decodeDurableValue(staged.dbs.CogniaDB.rows.sessions["s:binary"], root)).toEqual(bytes)
      expect(hasLiveWriter(root, "binary")).toBe(false)
      expect(writer.maintain().prunedBinaries).toEqual([])
    } finally {
      await writer.close()
    }
  })

  it("rejects a staged checkpoint whose binary disappears during publication", async () => {
    const value = encodeDurableValue(new Uint8Array(65536), root)
    writeCheckpoint(root, "gen-0001", state(1, { "s:binary": value }))
    const rename = fs.renameSync.bind(fs)
    const fault = jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === generationDir(root, "gen-0002"))
        fs.rmSync(binaryDir(root), { recursive: true })
    })
    try {
      await expect(recoverDurability(root, "snapshot")).rejects.toThrow(/binary.*missing/)
      expect(hasLiveWriter(root, "binary")).toBe(false)
    } finally {
      fault.mockRestore()
    }
  })

  it("activates through one pointer without deleting a staged marker", async () => {
    writeCheckpoint(root, "gen-0001", state(1))
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(42, { "s:kept": 42 }))
    await sqlite.close()
    writeManifest(root, { ...readManifest(root), activeBackend: "sqlite-v5", shadowBackend: null })
    const rm = fs.rmSync.bind(fs)
    const fault = jest.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      if (String(file).endsWith("/staged"))
        throw Object.assign(new Error("injected EIO"), { code: "EIO" })
      rm(file, options)
    })
    try {
      expect((await recoverDurability(root, "sqlite", { activate: true })).activated).toBe(true)
      expect(readJournalState(root)).toEqual(state(42, { "s:kept": 42 }))
    } finally {
      fault.mockRestore()
    }
  })

  it.each([
    "open",
    "write",
    "file-fsync",
    "file-close",
    "rename",
    "rename-after",
    "directory-open",
    "directory-fsync",
    "directory-close",
  ])("boots complete old or new state after activation %s fails", async (step) => {
    writeCheckpoint(root, "gen-0001", state(1))
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(42, { "s:kept": 42 }))
    await sqlite.close()
    writeManifest(root, { ...readManifest(root), activeBackend: "sqlite-v5", shadowBackend: null })
    const descriptors = new Map<number, string>()
    const isManifestStaging = (file: string | undefined) =>
      file?.startsWith(`${manifestFile(root)}.staging`) === true
    const injected = () => Object.assign(new Error(`injected ${step} EIO`), { code: "EIO" })
    const open = fs.openSync.bind(fs)
    const write = fs.writeFileSync.bind(fs)
    const sync = fs.fsyncSync.bind(fs)
    const rename = fs.renameSync.bind(fs)
    const close = fs.closeSync.bind(fs)
    const openSpy = jest.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (step === "open" && isManifestStaging(String(file))) throw injected()
      if (step === "directory-open" && String(file) === root) throw injected()
      const fd = open(file, flags, mode)
      descriptors.set(fd, String(file))
      return fd
    })
    const writeSpy = jest.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (step === "write" && typeof file === "number" && isManifestStaging(descriptors.get(file)))
        throw injected()
      write(file, data, options)
    })
    const syncSpy = jest.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (
        (step === "file-fsync" && isManifestStaging(descriptors.get(fd))) ||
        (step === "directory-fsync" && descriptors.get(fd) === root)
      )
        throw injected()
      sync(fd)
    })
    const renameSpy = jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (step === "rename" && isManifestStaging(String(from))) throw injected()
      rename(from, to)
      if (step === "rename-after" && isManifestStaging(String(from))) throw injected()
    })
    const closeSpy = jest.spyOn(fs, "closeSync").mockImplementation((fd) => {
      close(fd)
      if (
        (step === "file-close" && isManifestStaging(descriptors.get(fd))) ||
        (step === "directory-close" && descriptors.get(fd) === root)
      )
        throw injected()
    })
    try {
      await expect(recoverDurability(root, "sqlite", { activate: true })).rejects.toThrow(
        /injected .* EIO/
      )
    } finally {
      closeSpy.mockRestore()
      renameSpy.mockRestore()
      syncSpy.mockRestore()
      writeSpy.mockRestore()
      openSpy.mockRestore()
    }
    const reopened = await resolveBackend({ root })
    try {
      expect(reopened.state).toEqual(state(42, { "s:kept": 42 }))
    } finally {
      await reopened.backend.close()
    }
  })

  it("advances the atomic journal head on compaction after recovery", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    await recoverDurability(root, "journal", { activate: true })
    const writer = openBackend("journal-v4", root)
    try {
      await writer.load()
      writer.commitSync(commit(2, "s:b", 2))
      await writer.compact(await writer.load())
      writer.commitSync(commit(3, "s:c", 3))
    } finally {
      await writer.close()
    }
    expect(readJournalState(root)).toEqual(state(3, { "s:a": 1, "s:b": 2, "s:c": 3 }))
  })

  it("keeps a staged checkpoint rollback out of the next boot", async () => {
    await seedJournal(root, [commit(1, "s:a", 1), commit(2, "s:b", 2)])
    const staged = await recoverDurability(root, "snapshot")
    expect(staged.activated).toBe(false)
    expect(staged.sequence).toBe(0)
    const reopened = openBackend("journal-v4", root)
    try {
      expect((await reopened.load()).sequence).toBe(2)
      expect(readCheckpoint(root, staged.generation).sequence).toBe(0)
    } finally {
      await reopened.close()
    }
  })

  it("keeps an unpinned SQLite account on SQLite when staging without activation", async () => {
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(42, { "s:kept": 42 }))
    await sqlite.close()
    const recovered = await recoverDurability(root, "sqlite")
    expect(recovered.activated).toBe(false)
    const reopened = await resolveBackend({ root, seed: state(0) })
    try {
      expect(reopened.backend.id).toBe("sqlite-v5")
      expect(reopened.state).toEqual(state(42, { "s:kept": 42 }))
    } finally {
      await reopened.backend.close()
    }
  })

  it.each(["journal-v4", "sqlite-v5"] as const)(
    "refuses recovery activation beside a live %s writer",
    async (id) => {
      writeCheckpoint(root, "gen-0001", state(1))
      const writer = openBackend(id, root)
      try {
        if (id === "sqlite-v5") await writer.compact(state(1))
        else await writer.load()
        await expect(recoverDurability(root, "auto", { activate: true })).rejects.toThrow(
          /live writer/
        )
        expect(listGenerations(root)).toEqual(["gen-0001"])
        writer.commitSync(commit(2, "s:a", 2))
      } finally {
        await writer.close()
      }
    }
  )

  it("does not recover a generation with a missing binary even if its journal later deletes the row", async () => {
    writeCheckpoint(root, "gen-0001", state(1))
    const value = encodeDurableValue(new Uint8Array(65536), root)
    writeCheckpoint(root, "gen-0002", state(2, { "s:b": value }))
    const journal = openBackend("journal-v4", root)
    try {
      await journal.load()
      journal.commitSync(commit(3, "s:b", null))
    } finally {
      await journal.close()
    }
    fs.rmSync(binaryDir(root), { recursive: true })
    expect((await recoverDurability(root, "auto")).sequence).toBe(1)
  })

  it.each(["manifest", "binary"])(
    "auto recovery skips a newest generation with broken %s",
    async (broken) => {
      writeCheckpoint(root, "gen-0001", state(1, { "s:a": 1 }))
      const value = encodeDurableValue(new Uint8Array(65536), root)
      writeCheckpoint(root, "gen-0002", state(2, { "s:b": value }))
      if (broken === "manifest") {
        fs.writeFileSync(path.join(generationDir(root, "gen-0002"), "checkpoint.json"), "bad json")
      } else {
        fs.rmSync(binaryDir(root), { recursive: true })
      }
      const recovered = await recoverDurability(root, "auto", { activate: true })
      expect(recovered).toMatchObject({ sequence: 1, activated: true })
      const reopened = openBackend("journal-v4", root)
      try {
        expect(await reopened.load()).toEqual(state(1, { "s:a": 1 }))
      } finally {
        await reopened.close()
      }
      finalizeDurability(root, recovered.generation, { confirm: true })
      expect(readCheckpoint(root, recovered.generation)).toEqual(state(1, { "s:a": 1 }))
    }
  )

  it("stages the journal into a new generation without activating", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const result = await recoverDurability(root, "journal")
    expect(result).toMatchObject({ source: "journal", generation: "gen-0002", sequence: 1 })
    expect(result.activated).toBe(false)
    expect(listGenerations(root)).toEqual(["gen-0001", "gen-0002"])
    expect(readCheckpoint(root, "gen-0002").dbs.CogniaDB.rows.sessions).toEqual({
      "s:a": { id: "a" },
    })
  })

  it("never overwrites the generation it recovered from", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const before = readCheckpoint(root, "gen-0001")
    await recoverDurability(root, "auto")
    expect(readCheckpoint(root, "gen-0001")).toEqual(before)
  })

  it("auto-selects the source with the highest verified sequence", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(1, { "s:a": { id: "a" } }))
    await sqlite.close()
    const result = await recoverDurability(root, "auto")
    expect(result.source).toBe("journal")
    expect(result.sequence).toBe(2)
  })

  it("recovers from sqlite when explicitly asked", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(9, { "s:only": { id: "only" } }))
    await sqlite.close()
    const result = await recoverDurability(root, "sqlite")
    expect(result.source).toBe("sqlite")
    expect(readCheckpoint(root, result.generation).dbs.CogniaDB.rows.sessions).toEqual({
      "s:only": { id: "only" },
    })
  })

  it("activates and records a bundle when --activate is passed", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "sqlite-v5",
      shadowBackend: "journal-v4",
      rollbackWatermark: null,
      updatedAt: 0,
    })
    const result = await recoverDurability(root, "journal", { activate: true, now: () => 5 })
    expect(result.activated).toBe(true)
    expect(readManifest(root)).toMatchObject({
      activeBackend: "journal-v4",
      shadowBackend: null,
    })
    expect(listRollbackBundles(root)).toHaveLength(1)
  })

  it("throws when the explicitly named journal source holds nothing", async () => {
    await expect(recoverDurability(root, "journal")).rejects.toThrow(/no readable recovery source/)
  })

  it("propagates a sqlite fault when sqlite is the named source", async () => {
    await seedJournal(root, [])
    fs.mkdirSync(path.join(root, "sqlite"), { recursive: true })
    fs.writeFileSync(path.join(root, "sqlite", "store.sqlite"), "definitely not a database")
    await expect(recoverDurability(root, "sqlite")).rejects.toThrow()
  })

  it("throws when there is nothing to recover from", async () => {
    await expect(recoverDurability(root, "auto")).rejects.toThrow(/no readable recovery source/)
  })

  it("propagates a fault when the explicitly named source is broken", async () => {
    await seedJournal(root, [commit(1, "s:a", 1)])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("s:a", "s:z"))
    await expect(recoverDurability(root, "journal")).rejects.toThrow(
      expect.objectContaining({ code: "journal-checksum-mismatch" })
    )
  })

  it("falls back to a healthy source under auto when one is broken", async () => {
    await seedJournal(root, [commit(1, "s:a", { id: "a" })])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"id":"a"', '"id":"z"'))
    const result = await recoverDurability(root, "auto")
    expect(result.source).toBe("snapshot")
  })
})

describe("rollbackDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("refuses a live journal writer instead of silently staging its rollback", async () => {
    writeCheckpoint(root, "gen-0001", state(1))
    const writer = openBackend("journal-v4", root)
    try {
      await writer.load()
      expect(() => rollbackDurability(root, "gen-0001")).toThrow(/live writer/)
      expect(listGenerations(root)).toEqual(["gen-0001"])
    } finally {
      await writer.close()
    }
  })

  it("re-cuts an older generation as the newest and keeps everything", async () => {
    writeCheckpoint(root, "gen-0001", state(1, { "s:old": 1 }))
    writeCheckpoint(root, "gen-0002", state(9, { "s:new": 1 }))
    const result = rollbackDurability(root, "gen-0001", () => 3)
    expect(result.generation).toBe("gen-0003")
    expect(result.sequence).toBe(1)
    expect(listGenerations(root)).toEqual(["gen-0001", "gen-0002", "gen-0003"])
    expect(readCheckpoint(root, "gen-0003").dbs.CogniaDB.rows.sessions).toEqual({ "s:old": 1 })
    expect(readManifest(root).activeBackend).toBe("journal-v4")
  })

  it("keeps the value-loss report of a target from before codec 1 that it re-cuts", async () => {
    writeCheckpoint(root, "gen-0001", state(1, { "s:old": { id: "old", cover: {} } }))
    const manifestFile = path.join(generationDir(root, "gen-0001"), "checkpoint.json")
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    delete manifest.valueCodec
    manifest.checkpointFormat = 3
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))
    writeCheckpoint(root, "gen-0002", state(9, { "s:new": 1 }))

    rollbackDurability(root, "gen-0001", () => 3)
    // The re-cut gen-0003 is codec 1 and says nothing of the loss; the
    // persisted report does, and survives finalize pruning gen-0001.
    expect(readLegacyValueReport(root)?.findings).toEqual([
      expect.objectContaining({ table: "sessions", path: "cover", shape: "empty-object" }),
    ])
    expect((await verifyDurability(root)).legacyValueLoss).toEqual([
      expect.objectContaining({ path: "cover", sampleKeys: ["s:old"] }),
    ])
  })

  it("records a rollback bundle", () => {
    writeCheckpoint(root, "gen-0001", state(1))
    rollbackDurability(root, "gen-0001")
    expect(listRollbackBundles(root)).toHaveLength(1)
  })

  it("rejects a non-generation id", () => {
    expect(() => rollbackDurability(root, "latest")).toThrow(/is not a generation id/)
  })

  it("rejects a generation that is not on disk", () => {
    expect(() => rollbackDurability(root, "gen-0007")).toThrow(/is not on disk/)
  })
})

describe("finalizeDurability", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
    writeCheckpoint(root, "gen-0001", state(1))
    writeCheckpoint(root, "gen-0002", state(2))
    writeCheckpoint(root, "gen-0003", state(3))
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "sqlite-v5",
      shadowBackend: "journal-v4",
      rollbackWatermark: null,
      updatedAt: 0,
    })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it.each(["backend manifest", "checkpoint", "binary"])(
    "deletes nothing when the retained %s is broken",
    (broken) => {
      if (broken === "backend manifest") fs.writeFileSync(manifestFile(root), "bad json")
      else if (broken === "checkpoint") {
        fs.writeFileSync(path.join(generationDir(root, "gen-0002"), "checkpoint.json"), "bad json")
      } else {
        fs.rmSync(generationDir(root, "gen-0002"), { recursive: true })
        const value = encodeDurableValue(new Uint8Array(65536), root)
        writeCheckpoint(root, "gen-0002", state(2, { "s:a": value }))
        fs.rmSync(binaryDir(root), { recursive: true })
      }
      const abandoned = generationDir(root, "gen-0004")
      fs.mkdirSync(abandoned)
      fs.mkdirSync(`${abandoned}.staging-interrupted`)
      fs.writeFileSync(path.join(`${abandoned}.staging-interrupted`, "rows.json"), "partial rows")
      const before = fs.readdirSync(root, { recursive: true }).map(String).sort()
      expect(() => finalizeDurability(root, "gen-0002", { confirm: true })).toThrow()
      expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before)
      expect(listGenerations(root)).toEqual(["gen-0001", "gen-0002", "gen-0003"])
    }
  )

  it("reclaims interrupted checkpoint files only after validating the retained generations", () => {
    const abandoned = generationDir(root, "gen-0004")
    fs.mkdirSync(abandoned)
    fs.mkdirSync(`${abandoned}.staging-interrupted`)
    fs.writeFileSync(path.join(`${abandoned}.staging-interrupted`, "rows.json"), "partial rows")
    finalizeDurability(root, "gen-0002", { confirm: true })
    expect(fs.readdirSync(path.join(root, "generations"))).toEqual(["gen-0002", "gen-0003"])
  })

  it("refuses a live writer and preserves every accepted sequence after reopen", async () => {
    fs.rmSync(generationDir(root, "gen-0001"), { recursive: true })
    writeCheckpoint(root, "gen-0001", state(2))
    fs.rmSync(generationDir(root, "gen-0002"), { recursive: true })
    fs.rmSync(generationDir(root, "gen-0003"), { recursive: true })
    const writer = openBackend("journal-v4", root)
    try {
      await writer.load()
      writeCheckpoint(root, "gen-0002", state(2))
      writer.commitSync(commit(3, "s:a", 3))
      expect(() => finalizeDurability(root, "gen-0002", { confirm: true })).toThrow(/writer/)
      writer.commitSync(commit(4, "s:a", 4))
    } finally {
      await writer.close()
    }
    const reopened = openBackend("journal-v4", root)
    try {
      expect((await reopened.load()).sequence).toBe(4)
    } finally {
      await reopened.close()
    }
  })

  it("requires --confirm", () => {
    expect(() => finalizeDurability(root, "gen-0002", { confirm: false })).toThrow(/--confirm/)
    expect(listGenerations(root)).toHaveLength(3)
  })

  it("prunes strictly below the watermark and keeps the named generation", () => {
    const result = finalizeDurability(root, "gen-0002", { confirm: true, now: () => 9 })
    expect(result.prunedGenerations).toEqual(["gen-0001"])
    expect(result.keptGenerations).toEqual(["gen-0002", "gen-0003"])
    expect(result.rollbackWatermark).toBe("gen-0002")
  })

  it("clears the shadow backend so the compatibility window ends", () => {
    const result = finalizeDurability(root, "gen-0003", { confirm: true })
    expect(result.manifest.shadowBackend).toBeNull()
    expect(readManifest(root).shadowBackend).toBeNull()
    expect(readManifest(root).activeBackend).toBe("sqlite-v5")
  })

  it("also removes the pruned generations' journal files", () => {
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    fs.writeFileSync(journalFile(root, "gen-0001"), encodeCommitLine(commit(2, "s:a", 1)))
    finalizeDurability(root, "gen-0002", { confirm: true })
    expect(fs.existsSync(journalFile(root, "gen-0001"))).toBe(false)
  })

  it("removes side files no kept generation, journal or SQLite row names, sparing young ones", async () => {
    const ref = (bytes: number[]) => writeBinarySync(root, Uint8Array.from(bytes))
    const envelope = (fileRef: string) => ({
      $cogniaSnapshotValue: { version: 1, type: "uint8array", byteLength: 1, fileRef },
    })
    const onlyPruned = ref([1])
    const inCheckpoint = ref([2])
    const inJournal = ref([3])
    const inSqlite = ref([4])
    const young = ref([5])
    fs.rmSync(generationDir(root, "gen-0001"), { recursive: true })
    writeCheckpoint(root, "gen-0001", state(1, { "s:a": { bytes: envelope(onlyPruned) } }))
    fs.rmSync(generationDir(root, "gen-0003"), { recursive: true })
    writeCheckpoint(root, "gen-0003", state(3, { "s:a": { bytes: envelope(inCheckpoint) } }))
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    fs.writeFileSync(
      journalFile(root, "gen-0003"),
      encodeCommitLine(commit(4, "s:b", { bytes: envelope(inJournal) }))
    )
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(4, { "s:c": { bytes: envelope(inSqlite) } }))
    await sqlite.close()
    const old = new Date(Date.now() - 2 * BINARY_PRUNE_GRACE_MS)
    for (const name of [onlyPruned, inCheckpoint, inJournal, inSqlite])
      fs.utimesSync(path.join(binaryDir(root), name), old, old)

    const result = finalizeDurability(root, "gen-0002", { confirm: true })
    expect(result.prunedBinaries).toEqual([onlyPruned])
    expect(fs.readdirSync(binaryDir(root)).sort()).toEqual(
      [inCheckpoint, inJournal, inSqlite, young].sort()
    )
  })

  it("rejects a generation that is not on disk", () => {
    expect(() => finalizeDurability(root, "gen-0009", { confirm: true })).toThrow(/is not on disk/)
  })

  it("rejects a non-generation id", () => {
    expect(() => finalizeDurability(root, "newest", { confirm: true })).toThrow(
      /is not a generation id/
    )
  })
})

describe("argument helpers", () => {
  it("accepts the three known backend ids", () => {
    expect(parseBackendArgument("sqlite-v5")).toBe("sqlite-v5")
  })

  it("rejects anything else", () => {
    expect(() => parseBackendArgument("postgres")).toThrow(/--to must be journal or sqlite/)
    expect(() => parseBackendArgument(undefined)).toThrow(/--to must be journal or sqlite/)
    // The documented spellings resolve to the ids the manifest uses.
    expect(parseBackendArgument("journal")).toBe("journal-v4")
    expect(parseBackendArgument("sqlite")).toBe("sqlite-v5")
    expect(parseBackendArgument("snapshot")).toBe("snapshot-v3")
    expect(parseBackendArgument("sqlite-v5")).toBe("sqlite-v5")
  })

  it("names the first generation", () => {
    expect(firstGeneration()).toBe("gen-0001")
  })
})
