import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { openBackend } from "../serve/persistence/backend"
import { writeCheckpoint } from "../serve/persistence/checkpoint"
import { encodeCommitLine, journalFile } from "../serve/persistence/journal"
import { readManifest, writeManifest } from "../serve/persistence/manifest"
import type { DurabilityCommit, DurabilityState } from "../serve/persistence/types"
import { encodeDurableValue } from "../serve/persistence/value-codec"
import { binaryDir } from "../serve/persistence/binary-store"
import { parseArgv } from "./args"
import { durabilityCommand, DURABILITY_HELP } from "./durability-command"
import type { OutputSink } from "./output"

function sink(): OutputSink & { out: string[]; err: string[]; records: unknown[] } {
  const out: string[] = []
  const err: string[] = []
  const records: unknown[] = []
  return {
    out,
    err,
    records,
    write: (text) => out.push(text),
    error: (text) => err.push(text),
    json: (obj) => records.push(obj),
  }
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-durcmd-"))
}

function accountRoot(home: string, accountId = "acct"): string {
  return path.join(home, "durability", accountId)
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

async function seed(home: string, commits: DurabilityCommit[] = []): Promise<string> {
  const root = accountRoot(home)
  fs.mkdirSync(root, { recursive: true })
  writeCheckpoint(root, "gen-0001", state(0))
  const backend = openBackend("journal-v4", root)
  await backend.load()
  for (const c of commits) backend.commitSync(c)
  await backend.close()
  return root
}

function run(argv: string[], out: OutputSink, home: string): Promise<number> {
  return durabilityCommand(parseArgv(["durability", ...argv, "--home", home]), {
    out,
    env: {},
    now: () => 42,
  })
}

describe("durabilityCommand argument handling", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("prints help and fails when no verb is given", async () => {
    const out = sink()
    expect(await run([], out, home)).toBe(2)
    expect(out.out.join("")).toBe(DURABILITY_HELP)
  })

  it("prints help and succeeds for the explicit help verb", async () => {
    const out = sink()
    expect(await run(["help"], out, home)).toBe(0)
  })

  it("requires --account", async () => {
    const out = sink()
    const code = await durabilityCommand(parseArgv(["durability", "verify"]), { out, env: {} })
    expect(code).toBe(2)
    expect(out.err.join("")).toContain("--account <id> is required")
  })

  it("rejects an unknown verb", async () => {
    const out = sink()
    expect(await run(["frobnicate", "--account", "acct"], out, home)).toBe(2)
    expect(out.err.join("")).toContain('unknown subcommand "frobnicate"')
  })
})

describe("durability verify", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  function verifyRoot(root: string, out = sink()) {
    return durabilityCommand(parseArgv(["durability", "verify", "--root", root, "--json"]), {
      out,
      env: { COGNIA_DATA_DIR: path.join(home, "unused") },
    }).then((code) => ({ code, out }))
  }

  it("verifies an explicit staged root without an account or the operator's home", async () => {
    const root = await seed(home)
    const before = fs.readdirSync(root)
    const { code, out } = await verifyRoot(root)
    expect(code).toBe(0)
    expect(out.records[0]).toMatchObject({ ok: true, root })
    expect(fs.readdirSync(root)).toEqual(before)
    expect(fs.existsSync(path.join(home, "unused"))).toBe(false)
  })

  it("verifies a ledger whose account name ends with .json.tables", async () => {
    const original = await seed(home)
    const root = `${original}.json.tables`
    fs.renameSync(original, root)
    const before = treeBytes(root)
    const { code, out } = await verifyRoot(root)
    expect(code).toBe(0)
    expect(out.records[0]).toMatchObject({ ok: true, root })
    expect(treeBytes(root)).toEqual(before)
  })

  it.each(["compact", "migrate", "recover", "rollback", "finalize"])(
    "refuses an explicit root for %s",
    async (verb) => {
      const out = sink()
      expect(
        await durabilityCommand(
          parseArgv(["durability", verb, "--root", home, "--account", "acct"]),
          { out }
        )
      ).toBe(2)
      expect(out.err.join("")).toContain("--root is only supported by verify")
    }
  )

  function treeBytes(root: string): Record<string, string> {
    return Object.fromEntries(
      fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const file = path.join(entry.parentPath, entry.name)
          return [path.relative(root, file), fs.readFileSync(file).toString("hex")]
        })
    )
  }

  it.each(["single-file", "table-store"])(
    "reports skipped historical and uninstalled plugin tables for a %s snapshot",
    async (format) => {
      const tables = {
        messages: [{ id: "message-1" }],
        petConversation: [{ id: "legacy" }],
        "uninstalled-plugin:records": [{ id: "plugin-row" }],
      }
      const root = path.join(home, format === "single-file" ? "db.json" : "db.json.tables")
      if (format === "single-file") {
        fs.writeFileSync(
          root,
          JSON.stringify({ snapshotFormat: 3, dbs: { CogniaDB: { version: 219, tables } } })
        )
      } else {
        fs.mkdirSync(root)
        fs.writeFileSync(
          path.join(root, "manifest.json"),
          JSON.stringify({
            snapshotFormat: 4,
            dbs: { CogniaDB: { version: 219, tables: Object.keys(tables) } },
          })
        )
        for (const [table, rows] of Object.entries(tables)) {
          fs.writeFileSync(
            path.join(root, `CogniaDB--${encodeURIComponent(table)}.json`),
            JSON.stringify(rows)
          )
        }
      }
      const before = treeBytes(home)
      const { code, out } = await verifyRoot(root)
      expect(code).toBe(0)
      expect(out.records[0]).toMatchObject({
        ok: true,
        faults: [],
        skippedSnapshotTables: [
          { database: "CogniaDB", table: "petConversation" },
          { database: "CogniaDB", table: "uninstalled-plugin:records" },
        ],
      })
      const text = sink()
      expect(await run(["verify", "--root", root], text, home)).toBe(0)
      expect(text.out.join("")).toContain("skipped table:   CogniaDB.petConversation")
      expect(text.out.join("")).toContain("skipped table:   CogniaDB.uninstalled-plugin:records")
      expect(text.err).toEqual([])
      expect(treeBytes(home)).toEqual(before)
    }
  )

  it("verifies a single-file snapshot read-only", async () => {
    const root = path.join(home, "db-account.json")
    const db = { version: 1, tables: { messages: [{ id: "message-1" }] } }
    fs.writeFileSync(root, JSON.stringify({ snapshotFormat: 3, dbs: { CogniaDB: db } }))
    const before = treeBytes(home)
    const { code, out } = await verifyRoot(root)
    expect(code).toBe(0)
    expect(out.records[0]).toMatchObject({ ok: true, root })
    expect(treeBytes(home)).toEqual(before)
    expect(fs.existsSync(path.join(home, "unused"))).toBe(false)
  })

  it.each([
    "{broken",
    JSON.stringify({ snapshotFormat: 99, dbs: {} }),
    JSON.stringify({ snapshotFormat: 2, dbs: {} }),
    JSON.stringify({ version: 1, tables: {} }),
  ])("rejects a corrupt or newer single-file snapshot without changing it: %s", async (text) => {
    const root = path.join(home, "db-account.json")
    fs.writeFileSync(root, text)
    const before = treeBytes(home)
    const { code, out } = await verifyRoot(root)
    expect(code).toBe(1)
    expect(out.records[0]).toMatchObject({ ok: false, faults: expect.any(Array) })
    expect(treeBytes(home)).toEqual(before)
  })

  it.each(["journal-v4", "sqlite-v5"] as const)(
    "keeps every file byte-identical when verifying a good %s root",
    async (backendId) => {
      const root = accountRoot(home)
      const value = encodeDurableValue(new Uint8Array(20000), root)
      const backend = openBackend(backendId, root)
      try {
        await backend.compact(state(0, { "s:attachment": value }))
      } finally {
        await backend.close()
      }
      const before = treeBytes(root)
      expect((await verifyRoot(root)).code).toBe(0)
      expect(treeBytes(root)).toEqual(before)
    }
  )

  it("reads pending SQLite WAL without changing any source file", async () => {
    const root = accountRoot(home)
    const backend = openBackend("sqlite-v5", root)
    try {
      await backend.compact(state(0))
      backend.commitSync(commit(1, "s:pending", { id: "pending" }))
      const before = treeBytes(root)
      const { code, out } = await verifyRoot(root)
      expect(code).toBe(0)
      expect(out.records[0]).toMatchObject({ ok: true, sqliteSequence: 1 })
      expect(treeBytes(root)).toEqual(before)
    } finally {
      await backend.close()
    }
  })

  it.each(["missing row file", "journal checksum", "journal sequence", "generation pointer"])(
    "rejects a damaged %s at an explicit root",
    async (fault) => {
      const root = await seed(home)
      if (fault === "missing row file") {
        fs.rmSync(path.join(root, "generations/gen-0001/CogniaDB--sessions.rows.json"))
      } else if (fault === "generation pointer") {
        writeManifest(root, { ...readManifest(root), journalGeneration: "gen-9999" })
      } else {
        fs.mkdirSync(path.dirname(journalFile(root, "gen-0001")), { recursive: true })
        fs.writeFileSync(
          journalFile(root, "gen-0001"),
          fault === "journal sequence"
            ? encodeCommitLine(commit(2, "s:a", { id: "a" }))
            : "{}\tinvalid-checksum\n"
        )
      }
      const before = treeBytes(root)
      const { code, out } = await verifyRoot(root)
      expect(code).toBe(1)
      expect(out.records[0]).toMatchObject({ ok: false, faults: expect.any(Array) })
      expect(treeBytes(root)).toEqual(before)
    }
  )

  it.each(["missing binary", "broken checkpoint"])(
    "rejects %s at an explicit root",
    async (fault) => {
      const root = accountRoot(home)
      const value = encodeDurableValue(new Uint8Array(20000), root)
      writeCheckpoint(root, "gen-0001", state(0, { "s:attachment": value }))
      if (fault === "missing binary") fs.rmSync(binaryDir(root), { recursive: true })
      else fs.writeFileSync(path.join(root, "generations/gen-0001/checkpoint.json"), "{broken")
      const { code, out } = await verifyRoot(root)
      expect(code).toBe(1)
      expect(out.records[0]).toMatchObject({ ok: false, faults: expect.any(Array) })
      expect(JSON.stringify(out.records)).toContain(fault === "missing binary" ? "missing" : "JSON")
    }
  )

  it("verifies a table snapshot read-only and refuses one in an older format", async () => {
    const root = path.join(home, "db-account.json.tables")
    fs.mkdirSync(root)
    const manifest = (snapshotFormat: number) =>
      fs.writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({ snapshotFormat, dbs: { "db /": { version: 1, tables: ["messages"] } } })
      )
    manifest(4)
    const rows = path.join(root, "db%20%2F--messages.json")
    fs.writeFileSync(rows, '[{"id":"a"}]')
    expect((await verifyRoot(root)).code).toBe(0)
    expect(fs.readFileSync(rows, "utf8")).toBe('[{"id":"a"}]')
    manifest(3)
    expect((await verifyRoot(root)).code).toBe(1)
    manifest(4)
    fs.rmSync(rows)
    expect((await verifyRoot(root)).code).toBe(1)
  })

  it("summarises a healthy account", async () => {
    await seed(home, [commit(1, "s:a", { id: "a" })])
    const out = sink()
    expect(await run(["verify", "--account", "acct"], out, home)).toBe(0)
    const text = out.out.join("")
    expect(text).toContain("active backend:  journal-v4")
    expect(text).toContain("generations:     gen-0001")
    expect(text).toContain("journal commits: 1 (sequence 1)")
  })

  it("exits non-zero and prints the fault when the journal is damaged", async () => {
    const root = await seed(home, [commit(1, "s:a", { id: "a" })])
    const file = journalFile(root, "gen-0001")
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"id":"a"', '"id":"z"'))
    const out = sink()
    expect(await run(["verify", "--account", "acct"], out, home)).toBe(1)
    expect(out.err.join("")).toContain("journal-checksum-mismatch")
  })

  it("fails verification for a nonexistent account", async () => {
    const out = sink()
    expect(await run(["verify", "--account", "brand-new"], out, home)).toBe(1)
    const text = out.out.join("")
    expect(text).toContain("shadow backend:  -")
    expect(text).toContain("generations:     -")
    expect(text).toContain("checkpoint seq:  -")
    expect(text).toContain("sqlite:          absent")
    expect(text).toContain("rollback mark:   -")
    const json = sink()
    expect(await run(["verify", "--account", "brand-new", "--json"], json, home)).toBe(1)
    expect(json.records[0]).toMatchObject({ ok: false })
  })

  it("reports sqlite once it exists, plus the parity verdict", async () => {
    await seed(home, [commit(1, "s:a", { id: "a" })])
    await run(["migrate", "--account", "acct", "--to", "sqlite"], sink(), home)
    const out = sink()
    expect(await run(["verify", "--account", "acct"], out, home)).toBe(0)
    const text = out.out.join("")
    expect(text).toContain("sqlite:          present (sequence 1)")
    expect(text).toContain("parity ok")
  })

  it("falls back to the real env and clock when deps omit them", async () => {
    await seed(home)
    const out = sink()
    const code = await durabilityCommand(
      parseArgv(["durability", "verify", "--account", "acct", "--home", home]),
      { out }
    )
    expect(code).toBe(0)
  })

  it("emits one machine record under --json", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    expect(await run(["verify", "--account", "acct", "--json"], out, home)).toBe(0)
    expect(out.records).toHaveLength(1)
    expect(out.records[0]).toMatchObject({ ok: true, journalCommits: 1 })
  })

  it("marks the json record not-ok and prints the faulting sequence", async () => {
    const root = await seed(home, [commit(1, "s:a", 1)])
    fs.mkdirSync(path.join(root, "journal"), { recursive: true })
    const file = journalFile(root, "gen-0001")
    const line = fs.readFileSync(file, "utf8")
    // Two records where the second claims sequence 3: a gap the replay refuses.
    fs.writeFileSync(file, line + line.replace('"sequence":1', '"sequence":3'))
    const out = sink()
    expect(await run(["verify", "--account", "acct", "--json"], out, home)).toBe(1)
    expect(out.records[0]).toMatchObject({ ok: false })

    const human = sink()
    expect(await run(["verify", "--account", "acct"], human, home)).toBe(1)
    expect(human.err.join("")).toMatch(/fault journal-\w+(-\w+)* @?\d*/)
  })

  it("falls back to the default home when --home is omitted", async () => {
    await seed(path.join(home, ".cognia", "serve"))
    const homedir = jest.spyOn(os, "homedir").mockReturnValue(home)
    const out = sink()
    try {
      const code = await durabilityCommand(
        parseArgv(["durability", "verify", "--account", "acct"]),
        {
          out,
          env: { COGNIA_HOME: path.join(home, "cli") },
          now: () => 1,
        }
      )
      expect(code).toBe(0)
      expect(out.out.join("")).toContain(path.join(home, ".cognia", "serve", "durability", "acct"))
    } finally {
      homedir.mockRestore()
    }
  })

  it("uses the serve data directory ahead of COGNIA_HOME", async () => {
    const root = await seed(path.join(home, "data", "serve"))
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(42))
    await sqlite.close()
    const { writeManifest, defaultManifest } = await import("../serve/persistence/manifest")
    writeManifest(root, { ...defaultManifest(), activeBackend: "sqlite-v5" })
    const out = sink()
    expect(
      await durabilityCommand(parseArgv(["durability", "verify", "--account", "acct", "--json"]), {
        out,
        env: { COGNIA_HOME: path.join(home, "cli"), COGNIA_DATA_DIR: path.join(home, "data") },
      })
    ).toBe(0)
    expect(out.records[0]).toMatchObject({ ok: true, root, sqliteSequence: 42 })
  })

  it("reports the discarded torn tail", async () => {
    const root = await seed(home, [commit(1, "s:a", 1)])
    fs.appendFileSync(journalFile(root, "gen-0001"), '{"sequence":2')
    const out = sink()
    await run(["verify", "--account", "acct"], out, home)
    expect(out.out.join("")).toContain("torn bytes")
  })
})

describe("durability migrate", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("migrates to sqlite and promotes it", async () => {
    await seed(home, [commit(1, "s:a", { id: "a" })])
    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "sqlite"], out, home)).toBe(0)
    expect(out.out.join("")).toContain("active backend:  sqlite-v5 (shadow journal-v4)")
    expect(readManifest(accountRoot(home)).activeBackend).toBe("sqlite-v5")
  })

  it("accepts the full backend id as well as the short name", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "sqlite-v5"], out, home)).toBe(0)
  })

  it("opts an account into the journal rung by pinning the manifest", async () => {
    const root = await seed(home, [commit(1, "s:a", 1)])
    const { resolveDurabilityBackend } = await import("../serve/durability")
    expect(resolveDurabilityBackend(home, "acct", {})).toBe("journal-v4")

    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "journal"], out, home)).toBe(0)
    expect(readManifest(root).activeBackend).toBe("journal-v4")
    expect(resolveDurabilityBackend(home, "acct", {})).toBe("journal-v4")
  })

  it("accepts the snapshot spelling", async () => {
    const root = await seed(home, [])
    const { writeManifest } = await import("../serve/persistence/manifest")
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "sqlite-v5",
      shadowBackend: null,
      rollbackWatermark: null,
      updatedAt: 0,
    })
    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "snapshot"], out, home)).toBe(0)
    expect(readManifest(root).activeBackend).toBe("snapshot-v3")
  })

  it("emits a json record on a successful migration", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "sqlite", "--json"], out, home)).toBe(
      0
    )
    expect(out.records[0]).toMatchObject({ ok: true, from: "journal-v4", to: "sqlite-v5" })
  })

  it("round-trips sqlite -> journal, preserving the sequence and rows", async () => {
    const root = await seed(home, [commit(1, "s:a", { id: "a" }), commit(2, "s:b", { id: "b" })])
    expect(await run(["migrate", "--account", "acct", "--to", "sqlite"], sink(), home)).toBe(0)
    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "journal"], out, home)).toBe(0)
    expect(readManifest(root).activeBackend).toBe("journal-v4")

    const backend = openBackend("journal-v4", root)
    const restored = await backend.load()
    await backend.close()
    expect(restored.sequence).toBe(2)
    expect(restored.dbs.CogniaDB.rows.sessions).toEqual({
      "s:a": { id: "a" },
      "s:b": { id: "b" },
    })
  })

  it("accepts the full snapshot backend id", async () => {
    const root = await seed(home, [])
    const { writeManifest } = await import("../serve/persistence/manifest")
    writeManifest(root, {
      manifestFormat: 1,
      activeBackend: "sqlite-v5",
      shadowBackend: null,
      rollbackWatermark: null,
      updatedAt: 0,
    })
    expect(await run(["migrate", "--account", "acct", "--to", "snapshot-v3"], sink(), home)).toBe(0)
  })

  it("reports a refused promotion and exits non-zero", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    const failing: Parameters<typeof durabilityCommand>[1]["migrate"] = async () => ({
      from: "journal-v4",
      to: "sqlite-v5",
      bundle: {
        id: "bundle-0001",
        createdAt: 0,
        reason: "test",
        manifest: {
          manifestFormat: 1,
          activeBackend: "journal-v4",
          shadowBackend: null,
          rollbackWatermark: null,
          updatedAt: 0,
        },
        generation: "gen-0001",
        sequence: 1,
      },
      parity: {
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
      },
      promoted: false,
    })
    const code = await durabilityCommand(
      parseArgv(["durability", "migrate", "--account", "acct", "--to", "sqlite", "--home", home]),
      { out, env: {}, now: () => 1, migrate: failing }
    )
    expect(code).toBe(1)
    expect(out.out.join("")).toContain("parity FAILED")
    expect(out.err.join("")).toContain("journal-v4 remains active")
  })

  it("reports a refused promotion as a json record", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    const code = await durabilityCommand(
      parseArgv([
        "durability",
        "migrate",
        "--account",
        "acct",
        "--to",
        "sqlite",
        "--json",
        "--home",
        home,
      ]),
      {
        out,
        env: {},
        now: () => 1,
        migrate: async (_root, to) => ({
          from: "journal-v4",
          to,
          bundle: {
            id: "bundle-0001",
            createdAt: 0,
            reason: "test",
            manifest: {
              manifestFormat: 1,
              activeBackend: "journal-v4",
              shadowBackend: null,
              rollbackWatermark: null,
              updatedAt: 0,
            },
            generation: null,
            sequence: 0,
          },
          parity: { ok: false, comparedRows: 0, mismatches: [] },
          promoted: false,
        }),
      }
    )
    expect(code).toBe(1)
    expect(out.records[0]).toMatchObject({ ok: false, promoted: false })
  })

  it("names the missing value when --to is omitted entirely", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["migrate", "--account", "acct"], out, home)).toBe(1)
    expect(out.err.join("")).toContain("got nothing")
  })

  it("prints a dash for a bundle cut before any generation existed", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    const code = await durabilityCommand(
      parseArgv(["durability", "migrate", "--account", "acct", "--to", "sqlite", "--home", home]),
      {
        out,
        env: {},
        now: () => 1,
        migrate: async (_root, to) => ({
          from: "journal-v4",
          to,
          bundle: {
            id: "bundle-0001",
            createdAt: 0,
            reason: "test",
            manifest: {
              manifestFormat: 1,
              activeBackend: "journal-v4",
              shadowBackend: null,
              rollbackWatermark: null,
              updatedAt: 0,
            },
            generation: null,
            sequence: 0,
          },
          parity: { ok: true, comparedRows: 0, mismatches: [] },
          promoted: true,
        }),
      }
    )
    expect(code).toBe(0)
    expect(out.out.join("")).toContain("rollback bundle: bundle-0001 (generation -)")
  })

  it("rejects an unknown target", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["migrate", "--account", "acct", "--to", "postgres"], out, home)).toBe(1)
    expect(out.err.join("")).toContain("--to must be journal or sqlite")
  })

  it("reports the error as a json record under --json", async () => {
    await seed(home, [])
    const out = sink()
    expect(
      await run(["migrate", "--account", "acct", "--to", "postgres", "--json"], out, home)
    ).toBe(1)
    expect(out.records[0]).toMatchObject({ ok: false, code: "manifest-corrupt" })
  })
})

describe("durability compact", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("VACUUMs SQLite and reports bytes before and after without changing rows", async () => {
    const root = accountRoot(home)
    const sqlite = openBackend("sqlite-v5", root)
    await sqlite.compact(state(0))
    sqlite.commitSync(commit(1, "s:large", { text: "x".repeat(4 * 1024 * 1024) }))
    sqlite.maintain!()
    sqlite.commitSync(commit(2, "s:large", null))
    sqlite.maintain!()
    await sqlite.close()
    const out = sink()
    expect(await run(["compact", "--account", "acct", "--json"], out, home)).toBe(0)
    const result = out.records[0] as { ok: boolean; bytesBefore: number; bytesAfter: number }
    expect(result.ok).toBe(true)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
    const reopened = openBackend("sqlite-v5", root)
    try {
      expect((await reopened.load()).sequence).toBe(2)
    } finally {
      await reopened.close()
    }
    const human = sink()
    expect(await run(["compact", "--account", "acct"], human, home)).toBe(0)
    expect(human.out.join("")).toContain("bytes before:")
    expect(human.out.join("")).toContain("bytes after:")
    expect(DURABILITY_HELP).toContain("durability compact")
  })

  it("refuses while a SQLite writer owns the store", async () => {
    const writer = openBackend("sqlite-v5", accountRoot(home))
    try {
      await writer.compact(state(1))
      const out = sink()
      expect(await run(["compact", "--account", "acct", "--json"], out, home)).toBe(1)
      expect(out.records[0]).toMatchObject({
        ok: false,
        message: expect.stringContaining("writer"),
      })
      writer.commitSync(commit(2, "s:a", 1))
    } finally {
      await writer.close()
    }
  })
})

describe("durability recover", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("stages without activating by default", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    expect(await run(["recover", "--account", "acct"], out, home)).toBe(0)
    const text = out.out.join("")
    expect(text).toContain("staged as:       gen-0002")
    expect(text).toContain("activated:       no (pass --activate)")
  })

  it("activates when asked", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    expect(await run(["recover", "--account", "acct", "--activate"], out, home)).toBe(0)
    expect(out.out.join("")).toContain("activated:       yes")
  })

  it("rejects an unknown source", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["recover", "--account", "acct", "--from", "tape"], out, home)).toBe(2)
    expect(out.err.join("")).toContain("--from must be one of")
  })

  it("emits a json record", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const out = sink()
    await run(["recover", "--account", "acct", "--from", "journal", "--json"], out, home)
    expect(out.records[0]).toMatchObject({ ok: true, source: "journal", sequence: 1 })
  })
})

describe("durability rollback", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("requires --to", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["rollback", "--account", "acct"], out, home)).toBe(2)
    expect(out.err.join("")).toContain("requires --to <generation>")
  })

  it("re-cuts the named generation", async () => {
    await seed(home, [commit(1, "s:a", 1)])
    const root = accountRoot(home)
    writeCheckpoint(root, "gen-0002", state(5, { "s:new": 1 }))
    const out = sink()
    expect(await run(["rollback", "--account", "acct", "--to", "gen-0001"], out, home)).toBe(0)
    expect(out.out.join("")).toContain("rolled back to:  gen-0001 (re-cut as gen-0003)")
  })

  it("fails on a generation that is not on disk", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["rollback", "--account", "acct", "--to", "gen-0099"], out, home)).toBe(1)
    expect(out.err.join("")).toContain("is not on disk")
  })

  it("emits a json record", async () => {
    await seed(home, [])
    const out = sink()
    await run(["rollback", "--account", "acct", "--to", "gen-0001", "--json"], out, home)
    expect(out.records[0]).toMatchObject({ ok: true, generation: "gen-0002" })
  })
})

describe("durability finalize", () => {
  let home: string
  beforeEach(() => {
    home = tempHome()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("requires --generation", async () => {
    await seed(home, [])
    const out = sink()
    expect(await run(["finalize", "--account", "acct"], out, home)).toBe(2)
    expect(out.err.join("")).toContain("requires --generation <id>")
  })

  it("refuses without --confirm", async () => {
    await seed(home, [])
    const out = sink()
    expect(
      await run(["finalize", "--account", "acct", "--generation", "gen-0001"], out, home)
    ).toBe(1)
    expect(out.err.join("")).toContain("--confirm")
  })

  it("prunes and reports the watermark", async () => {
    await seed(home, [])
    const root = accountRoot(home)
    writeCheckpoint(root, "gen-0002", state(2))
    const out = sink()
    expect(
      await run(
        ["finalize", "--account", "acct", "--generation", "gen-0002", "--confirm"],
        out,
        home
      )
    ).toBe(0)
    const text = out.out.join("")
    expect(text).toContain("pruned:          gen-0001")
    expect(text).toContain("rollback mark:   gen-0002")
    expect(readManifest(root).rollbackWatermark).toBe("gen-0002")
  })

  it("prints a dash when nothing needed pruning", async () => {
    await seed(home, [])
    const out = sink()
    expect(
      await run(
        ["finalize", "--account", "acct", "--generation", "gen-0001", "--confirm"],
        out,
        home
      )
    ).toBe(0)
    expect(out.out.join("")).toContain("pruned:          -")
  })

  it("emits a json record", async () => {
    await seed(home, [])
    const out = sink()
    await run(
      ["finalize", "--account", "acct", "--generation", "gen-0001", "--confirm", "--json"],
      out,
      home
    )
    expect(out.records[0]).toMatchObject({ ok: true, rollbackWatermark: "gen-0001" })
  })
})
