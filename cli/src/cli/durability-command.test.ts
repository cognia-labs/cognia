import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { openSqliteBackend, SQLITE_ROWS_TABLE, sqliteFile } from "../serve/persistence/sqlite"
import type { DurabilityCommit, DurabilityState } from "../serve/persistence/types"
import { encodeDurableValue } from "../serve/persistence/value-codec"
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

/** A closed SQLite store at the account root, seeded and then advanced by `commits`. */
async function seed(
  root: string,
  commits: DurabilityCommit[] = [],
  seedState = state(0)
): Promise<string> {
  const backend = openSqliteBackend({ root })
  try {
    await backend.compact(seedState)
    for (const c of commits) backend.commitSync(c)
  } finally {
    await backend.close()
  }
  return root
}

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

function run(argv: string[], out: OutputSink, home: string): Promise<number> {
  return durabilityCommand(parseArgv(["durability", ...argv, "--home", home]), {
    out,
    env: {},
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
    expect(out.out.join("")).toBe(DURABILITY_HELP)
  })

  it("lists only verify and compact in its help", () => {
    expect(DURABILITY_HELP).toContain("durability verify")
    expect(DURABILITY_HELP).toContain("durability compact")
    for (const verb of ["migrate", "recover", "rollback", "finalize"]) {
      expect(DURABILITY_HELP).not.toContain(`durability ${verb}`)
    }
  })

  it("requires --account", async () => {
    const out = sink()
    const code = await durabilityCommand(parseArgv(["durability", "verify"]), { out, env: {} })
    expect(code).toBe(2)
    expect(out.err.join("")).toContain("--account <id> is required")
  })

  it.each(["frobnicate", "migrate", "recover", "rollback", "finalize"])(
    "rejects the unknown verb %s",
    async (verb) => {
      const out = sink()
      expect(await run([verb, "--account", "acct"], out, home)).toBe(2)
      expect(out.err.join("")).toContain(`unknown subcommand "${verb}"`)
      expect(out.out.join("")).toBe(DURABILITY_HELP)
    }
  )

  it("refuses an explicit root for compact", async () => {
    const out = sink()
    expect(
      await durabilityCommand(
        parseArgv(["durability", "compact", "--root", home, "--account", "acct"]),
        { out }
      )
    ).toBe(2)
    expect(out.err.join("")).toContain("--root is only supported by verify")
  })

  it("refuses --root without a path", async () => {
    const out = sink()
    expect(await durabilityCommand(parseArgv(["durability", "verify", "--root"]), { out })).toBe(2)
    expect(out.err.join("")).toContain("requires <path>")
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
    const root = await seed(path.join(home, "staged"), [commit(1, "s:a", { id: "a" })])
    const before = treeBytes(root)
    const { code, out } = await verifyRoot(root)
    expect(code).toBe(0)
    expect(out.records).toEqual([
      {
        ok: true,
        root,
        backend: "sqlite-v5",
        sqlitePresent: true,
        sqliteSequence: 1,
        faults: [],
      },
    ])
    expect(treeBytes(root)).toEqual(before)
    expect(fs.existsSync(path.join(home, "unused"))).toBe(false)
  })

  it("keeps every file byte-identical when verifying a good root with side files", async () => {
    const root = accountRoot(home)
    const value = encodeDurableValue(new Uint8Array(20000), root)
    await seed(root, [], state(0, { "s:attachment": value }))
    const before = treeBytes(root)
    expect((await verifyRoot(root)).code).toBe(0)
    expect(treeBytes(root)).toEqual(before)
  })

  it("reads pending SQLite WAL without changing any source file", async () => {
    const root = accountRoot(home)
    const backend = openSqliteBackend({ root })
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

  it("summarises a healthy account", async () => {
    const root = await seed(accountRoot(home), [commit(1, "s:a", { id: "a" })])
    const out = sink()
    expect(await run(["verify", "--account", "acct"], out, home)).toBe(0)
    expect(out.out.join("")).toBe(
      `root:            ${root}\n` +
        "backend:         sqlite-v5\n" +
        "sqlite:          present (sequence 1)\n"
    )
    expect(out.err).toEqual([])
  })

  it("fails verification for a nonexistent account", async () => {
    const out = sink()
    expect(await run(["verify", "--account", "brand-new"], out, home)).toBe(1)
    const text = out.out.join("")
    expect(text).toContain("backend:         sqlite-v5")
    expect(text).toContain("sqlite:          absent")
    expect(out.err.join("")).toMatch(/^fault store-corrupt: /)
    expect(fs.existsSync(accountRoot(home, "brand-new"))).toBe(false)
    const json = sink()
    expect(await run(["verify", "--account", "brand-new", "--json"], json, home)).toBe(1)
    expect(json.records[0]).toMatchObject({
      ok: false,
      sqlitePresent: false,
      sqliteSequence: null,
      faults: [expect.objectContaining({ code: "store-corrupt", sequence: null })],
    })
  })

  it("exits non-zero and prints the fault when the store is damaged", async () => {
    const root = await seed(accountRoot(home), [commit(1, "s:a", { id: "a" })])
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE ${SQLITE_ROWS_TABLE} SET value_codec = 7`).run()
    db.close()
    const out = sink()
    expect(await run(["verify", "--account", "acct"], out, home)).toBe(1)
    expect(out.out.join("")).toContain("sqlite:          present (sequence -)")
    expect(out.err.join("")).toContain("fault sqlite-integrity-failure: ")
    expect(out.err.join("")).toContain("unsupported value codec 7")

    const json = sink()
    expect(await run(["verify", "--account", "acct", "--json"], json, home)).toBe(1)
    expect(json.records).toHaveLength(1)
    expect(json.records[0]).toMatchObject({
      ok: false,
      faults: [expect.objectContaining({ code: "sqlite-integrity-failure" })],
    })
  })

  it("reports a missing side file", async () => {
    const root = accountRoot(home)
    const value = encodeDurableValue(new Uint8Array(65536).fill(1), root)
    await seed(root, [], state(0, { "s:a": value }))
    fs.rmSync(path.join(root, "binary"), { recursive: true })
    const out = sink()
    expect(await run(["verify", "--account", "acct"], out, home)).toBe(1)
    expect(out.err.join("")).toContain("is missing")
  })

  it("falls back to the real env when deps omit it", async () => {
    await seed(accountRoot(home))
    const out = sink()
    const code = await durabilityCommand(
      parseArgv(["durability", "verify", "--account", "acct", "--home", home]),
      { out }
    )
    expect(code).toBe(0)
  })

  it("falls back to the default home when --home is omitted", async () => {
    await seed(accountRoot(path.join(home, ".cognia", "serve")))
    const homedir = jest.spyOn(os, "homedir").mockReturnValue(home)
    const out = sink()
    try {
      const code = await durabilityCommand(
        parseArgv(["durability", "verify", "--account", "acct"]),
        { out, env: { COGNIA_HOME: path.join(home, "cli") } }
      )
      expect(code).toBe(0)
      expect(out.out.join("")).toContain(path.join(home, ".cognia", "serve", "durability", "acct"))
    } finally {
      homedir.mockRestore()
    }
  })

  it("uses the serve data directory ahead of COGNIA_HOME", async () => {
    const root = await seed(accountRoot(path.join(home, "data", "serve")), [], state(42))
    const out = sink()
    expect(
      await durabilityCommand(parseArgv(["durability", "verify", "--account", "acct", "--json"]), {
        out,
        env: { COGNIA_HOME: path.join(home, "cli"), COGNIA_DATA_DIR: path.join(home, "data") },
      })
    ).toBe(0)
    expect(out.records[0]).toMatchObject({ ok: true, root, sqliteSequence: 42 })
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
    const sqlite = openSqliteBackend({ root })
    await sqlite.compact(state(0))
    sqlite.commitSync(commit(1, "s:large", { text: "x".repeat(4 * 1024 * 1024) }))
    sqlite.maintain()
    sqlite.commitSync(commit(2, "s:large", null))
    sqlite.maintain()
    await sqlite.close()
    const out = sink()
    expect(await run(["compact", "--account", "acct", "--json"], out, home)).toBe(0)
    const result = out.records[0] as { ok: boolean; bytesBefore: number; bytesAfter: number }
    expect(result.ok).toBe(true)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
    const reopened = openSqliteBackend({ root })
    try {
      expect((await reopened.load()).sequence).toBe(2)
    } finally {
      await reopened.close()
    }
    const human = sink()
    expect(await run(["compact", "--account", "acct"], human, home)).toBe(0)
    expect(human.out.join("")).toContain("bytes before:")
    expect(human.out.join("")).toContain("bytes after:")
  })

  it("refuses while a SQLite writer owns the store", async () => {
    const writer = openSqliteBackend({ root: accountRoot(home) })
    try {
      await writer.compact(state(1))
      const out = sink()
      expect(await run(["compact", "--account", "acct", "--json"], out, home)).toBe(1)
      expect(out.records[0]).toMatchObject({
        ok: false,
        code: "writer-busy",
        message: expect.stringContaining("writer"),
      })
      writer.commitSync(commit(2, "s:a", 1))
    } finally {
      await writer.close()
    }
  })

  it("fails when the account has no store", async () => {
    const json = sink()
    expect(await run(["compact", "--account", "acct", "--json"], json, home)).toBe(1)
    expect(json.records[0]).toMatchObject({ ok: false, code: "sqlite-integrity-failure" })
    const human = sink()
    expect(await run(["compact", "--account", "acct"], human, home)).toBe(1)
    expect(human.err.join("")).toContain("durability: no SQLite store exists to compact")
  })
})
