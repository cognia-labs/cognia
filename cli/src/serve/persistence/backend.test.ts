import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { durabilityRoot, ensureDurabilityRoot, resolveBackend, resolveServeHome } from "./backend"
import { SQLITE_ROWS_TABLE, sqliteFile } from "./sqlite"
import type { DurabilityCommit, DurabilityState } from "./types"
import { hasLiveWriter } from "./writer-lock"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-backend-"))
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

describe("durabilityRoot", () => {
  it("shares serve's environment, default and explicit home resolution", () => {
    expect(
      resolveServeHome({ COGNIA_DATA_DIR: "/data", COGNIA_HOME: "/cli" }, undefined, "/user")
    ).toBe(path.join("/data", "serve"))
    expect(resolveServeHome({ COGNIA_HOME: "/cli" }, undefined, "/user")).toBe(
      path.join("/user", ".cognia", "serve")
    )
    expect(resolveServeHome({ COGNIA_DATA_DIR: "" }, undefined, "/user")).toBe(
      path.join("/user", ".cognia", "serve")
    )
    expect(resolveServeHome({ COGNIA_DATA_DIR: "/data" }, "/override", "/user")).toBe("/override")
  })
  it("scopes by account and escapes path-hostile ids", () => {
    expect(durabilityRoot("/home", "local")).toBe(path.join("/home", "durability", "local"))
    expect(durabilityRoot("/home", "a/b")).toBe(path.join("/home", "durability", "a%2Fb"))
  })

  it("creates the root with restrictive permissions", () => {
    const root = path.join(tempRoot(), "nested")
    try {
      ensureDurabilityRoot(root)
      expect(fs.existsSync(root)).toBe(true)
      if (process.platform !== "win32") {
        expect(fs.statSync(root).mode & 0o777).toBe(0o700)
      }
    } finally {
      fs.rmSync(path.dirname(root), { recursive: true, force: true })
    }
  })
})

describe("resolveBackend", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("creates the root and opens an empty SQLite store without a seed", async () => {
    const nested = path.join(root, "acct")
    const resolved = await resolveBackend({ root: nested })
    try {
      expect(resolved.backend.id).toBe("sqlite-v5")
      expect(resolved.state).toEqual({ sequence: 0, dbs: {} })
      expect(fs.existsSync(sqliteFile(nested))).toBe(true)
    } finally {
      await resolved.backend.close()
    }
  })

  it("seeds an empty store so its first commit has a schema to land in", async () => {
    const resolved = await resolveBackend({ root, seed: state(0, { "s:a": { id: "a" } }) })
    expect(resolved.backend.id).toBe("sqlite-v5")
    expect(resolved.state.sequence).toBe(0)
    expect(resolved.state.dbs.CogniaDB.schema).toEqual({ version: 141, tables: ["sessions"] })
    expect(resolved.state.dbs.CogniaDB.rows.sessions).toEqual({ "s:a": { id: "a" } })
    resolved.backend.commitSync(commit(1, "s:b", { id: "b" }))
    await resolved.backend.close()

    const reopened = await resolveBackend({ root, seed: state(0) })
    try {
      expect(reopened.backend.lastSequence()).toBe(1)
      expect(reopened.state.dbs.CogniaDB.rows.sessions).toEqual({
        "s:a": { id: "a" },
        "s:b": { id: "b" },
      })
    } finally {
      await reopened.backend.close()
    }
  })

  it("seeds at sequence 0 whatever sequence the seed carries", async () => {
    const resolved = await resolveBackend({ root, seed: state(7, { "s:a": 1 }) })
    try {
      expect(resolved.state.sequence).toBe(0)
      expect(resolved.backend.lastSequence()).toBe(0)
      expect(() => resolved.backend.commitSync(commit(1, "s:b", 2))).not.toThrow()
    } finally {
      await resolved.backend.close()
    }
  })

  it("never re-seeds a seeded store, even one still at sequence 0", async () => {
    const first = await resolveBackend({ root, seed: state(0, { "s:kept": 1 }) })
    await first.backend.close()
    const second = await resolveBackend({ root, seed: state(0, { "s:fresh": 1 }) })
    try {
      expect(second.state.dbs.CogniaDB.rows.sessions).toEqual({ "s:kept": 1 })
    } finally {
      await second.backend.close()
    }
  })

  it("never re-seeds a store whose commits emptied every row", async () => {
    const first = await resolveBackend({ root, seed: state(0, { "s:gone": 1 }) })
    first.backend.commitSync(commit(1, "s:gone", null))
    await first.backend.close()
    const second = await resolveBackend({ root, seed: state(0, { "s:fresh": 1 }) })
    try {
      expect(second.state.sequence).toBe(1)
      expect(second.state.dbs.CogniaDB.rows.sessions).toEqual({})
    } finally {
      await second.backend.close()
    }
  })

  it("holds the SQLite writer lease until the backend closes", async () => {
    const resolved = await resolveBackend({ root, seed: state(0) })
    expect(hasLiveWriter(root, "sqlite")).toBe(true)
    await resolved.backend.close()
    expect(hasLiveWriter(root, "sqlite")).toBe(false)
  })

  it("releases the store when its content cannot be loaded", async () => {
    const seeded = await resolveBackend({ root, seed: state(0, { "s:a": 1 }) })
    await seeded.backend.close()
    const db = new DatabaseSync(sqliteFile(root))
    db.prepare(`UPDATE ${SQLITE_ROWS_TABLE} SET value_codec = 9`).run()
    db.close()

    await expect(resolveBackend({ root, seed: state(0) })).rejects.toThrow(
      expect.objectContaining({ code: "sqlite-integrity-failure" })
    )
    expect(hasLiveWriter(root, "sqlite")).toBe(false)
  })
})
