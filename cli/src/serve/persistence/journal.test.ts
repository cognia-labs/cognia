import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { canonicalJson, sha256Hex } from "./canonical"
import { writeCheckpoint } from "./checkpoint"
import {
  applyCommits,
  encodeCommitLine,
  journalFile,
  openJournalBackend,
  replayJournal,
  seedCheckpoint,
} from "./journal"
import { DurabilityFault, type DurabilityCommit, type DurabilityState } from "./types"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-journal-"))
}

function baseState(sequence = 0): DurabilityState {
  return {
    sequence,
    dbs: {
      CogniaDB: {
        schema: { version: 141, tables: ["sessions"] },
        rows: { sessions: {} },
      },
    },
  }
}

function commit(sequence: number, key: string, value: unknown): DurabilityCommit {
  return {
    sequence,
    committedAt: 1_000 + sequence,
    mutations: [{ database: "CogniaDB", table: "sessions", key, value }],
  }
}

describe("replayJournal", () => {
  it("returns nothing for an empty journal", () => {
    expect(replayJournal("", 0)).toEqual({ commits: [], discardedBytes: 0 })
  })

  it("replays complete records in order", () => {
    const body =
      encodeCommitLine(commit(1, "s:a", { id: "a" })) +
      encodeCommitLine(commit(2, "s:b", { id: "b" }))
    const result = replayJournal(body, 0)
    expect(result.commits.map((c) => c.sequence)).toEqual([1, 2])
    expect(result.discardedBytes).toBe(0)
  })

  it("discards an unterminated trailing record without failing", () => {
    const complete = encodeCommitLine(commit(1, "s:a", { id: "a" }))
    const torn = encodeCommitLine(commit(2, "s:b", { id: "b" })).slice(0, 20)
    const result = replayJournal(complete + torn, 0)
    expect(result.commits.map((c) => c.sequence)).toEqual([1])
    expect(result.discardedBytes).toBe(torn.length)
  })

  it("rejects a terminated record whose checksum does not match", () => {
    const line = encodeCommitLine(commit(1, "s:a", { id: "a" }))
    const tampered = line.replace('"id":"a"', '"id":"z"')
    expect(() => replayJournal(tampered, 0)).toThrow(
      expect.objectContaining({ code: "journal-checksum-mismatch" })
    )
  })

  it("rejects a sequence gap", () => {
    const body = encodeCommitLine(commit(1, "s:a", 1)) + encodeCommitLine(commit(3, "s:c", 3))
    expect(() => replayJournal(body, 0)).toThrow(
      expect.objectContaining({ code: "journal-sequence-gap", sequence: 2 })
    )
  })

  it("rejects a duplicated record rather than applying it twice", () => {
    const line = encodeCommitLine(commit(1, "s:a", 1))
    expect(() => replayJournal(line + line, 0)).toThrow(
      expect.objectContaining({ code: "journal-sequence-gap" })
    )
  })

  it("rejects a record with no checksum separator", () => {
    expect(() => replayJournal('{"sequence":1,"mutations":[]}\n', 0)).toThrow(
      expect.objectContaining({ code: "journal-torn-record" })
    )
  })

  it("rejects a record whose payload is not JSON", () => {
    const payload = "not-json"
    const line = `${payload}\t${"0".repeat(64)}\n`
    expect(() => replayJournal(line, 0)).toThrow(
      expect.objectContaining({ code: "journal-checksum-mismatch" })
    )
  })

  /** A structurally-broken record that still passes its checksum. */
  function signed(payload: unknown): string {
    const text = canonicalJson(payload)
    return `${text}\t${sha256Hex(text)}\n`
  }

  it.each([
    ["a non-object payload", [1, 2, 3]],
    ["a non-integer sequence", { sequence: 1.5, mutations: [] }],
    ["a missing mutation array", { sequence: 1 }],
    ["a non-object mutation", { sequence: 1, mutations: ["nope"] }],
    [
      "a malformed mutation address",
      { sequence: 1, mutations: [{ database: "CogniaDB", table: 5, key: "s:a", value: null }] },
    ],
  ])("rejects a well-checksummed record with %s", (_label, payload) => {
    expect(() => replayJournal(signed(payload), 0)).toThrow(
      expect.objectContaining({ code: "journal-torn-record" })
    )
  })

  it("rejects a well-checksummed record whose payload is not JSON at all", () => {
    const payload = "not-json"
    expect(() => replayJournal(`${payload}\t${sha256Hex(payload)}\n`, 0)).toThrow(
      expect.objectContaining({ code: "journal-torn-record" })
    )
  })

  it("normalises a mutation with no value member to a deletion", () => {
    const result = replayJournal(
      signed({
        sequence: 1,
        committedAt: 0,
        mutations: [{ database: "CogniaDB", table: "sessions", key: "s:a" }],
      }),
      0
    )
    expect(result.commits[0].mutations[0].value).toBeNull()
  })

  it("defaults a missing committedAt to 0", () => {
    const result = replayJournal(signed({ sequence: 1, mutations: [] }), 0)
    expect(result.commits[0].committedAt).toBe(0)
  })

  it("starts from the checkpoint sequence", () => {
    const body = encodeCommitLine(commit(9, "s:a", 1))
    expect(replayJournal(body, 8).commits).toHaveLength(1)
    expect(() => replayJournal(body, 0)).toThrow(
      expect.objectContaining({ code: "journal-sequence-gap" })
    )
  })

  it("skips blank lines", () => {
    const body = `\n${encodeCommitLine(commit(1, "s:a", 1))}\n`
    expect(replayJournal(body, 0).commits).toHaveLength(1)
  })
})

describe("applyCommits", () => {
  it("applies writes and deletions", () => {
    const state = baseState()
    applyCommits(state, [commit(1, "s:a", { id: "a" }), commit(2, "s:a", null)])
    expect(state.dbs.CogniaDB.rows.sessions).toEqual({})
    expect(state.sequence).toBe(2)
  })

  it("ignores mutations addressed at unknown databases or tables", () => {
    const state = baseState()
    applyCommits(state, [
      {
        sequence: 1,
        committedAt: 0,
        mutations: [{ database: "Gone", table: "x", key: "k", value: 1 }],
      },
      {
        sequence: 2,
        committedAt: 0,
        mutations: [{ database: "CogniaDB", table: "gone", key: "k", value: 1 }],
      },
    ])
    expect(state.dbs.CogniaDB.rows.sessions).toEqual({})
    expect(state.sequence).toBe(2)
  })
})

describe("openJournalBackend", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
    writeCheckpoint(root, "gen-0001", baseState(0))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("loads the checkpoint and survives a reopen", async () => {
    const backend = openJournalBackend({ root })
    await backend.load()
    backend.commitSync(commit(1, "s:a", { id: "a" }))
    backend.commitSync(commit(2, "s:b", { id: "b" }))
    await backend.close()

    const reopened = openJournalBackend({ root })
    const state = await reopened.load()
    await reopened.close()
    expect(state.sequence).toBe(2)
    expect(state.dbs.CogniaDB.rows.sessions).toEqual({ "s:a": { id: "a" }, "s:b": { id: "b" } })
  })

  it("refuses a commit before load establishes the sequence", () => {
    const backend = openJournalBackend({ root })
    expect(() => backend.commitSync(commit(1, "s:a", 1))).toThrow(
      expect.objectContaining({ code: "journal-sequence-gap" })
    )
  })

  it("refuses an out-of-order commit", async () => {
    const backend = openJournalBackend({ root })
    await backend.load()
    expect(() => backend.commitSync(commit(2, "s:a", 1))).toThrow(/expected sequence 1/)
    await backend.close()
  })

  it("fsyncs each record so a hard kill keeps the commit", async () => {
    const backend = openJournalBackend({ root })
    await backend.load()
    backend.commitSync(commit(1, "s:a", { id: "a" }))
    // No close(): simulate a process that died right after the commit resolved.
    const body = fs.readFileSync(journalFile(root, "gen-0001"), "utf8")
    expect(replayJournal(body, 0).commits).toHaveLength(1)
    await backend.close()
  })

  it("compacts into a new generation and keeps the previous one", async () => {
    const backend = openJournalBackend({ root })
    const state = await backend.load()
    backend.commitSync(commit(1, "s:a", { id: "a" }))
    applyCommits(state, [commit(1, "s:a", { id: "a" })])

    const result = await backend.compact(state)
    expect(result).toEqual({ generation: "gen-0002", previousGeneration: "gen-0001", sequence: 1 })
    expect(fs.existsSync(path.join(root, "generations", "gen-0001", "checkpoint.json"))).toBe(true)

    backend.commitSync(commit(2, "s:b", { id: "b" }))
    await backend.close()

    const reopened = openJournalBackend({ root })
    const reloaded = await reopened.load()
    await reopened.close()
    expect(reloaded.sequence).toBe(2)
    expect(Object.keys(reloaded.dbs.CogniaDB.rows.sessions).sort()).toEqual(["s:a", "s:b"])
  })

  it("reports lastSequence after load", async () => {
    const backend = openJournalBackend({ root })
    await backend.load()
    expect(backend.lastSequence()).toBe(0)
    await backend.commit(commit(1, "s:a", 1))
    expect(backend.lastSequence()).toBe(1)
    await backend.close()
  })

  it("returns an empty state with no checkpoint at all", async () => {
    const bare = tempRoot()
    try {
      const backend = openJournalBackend({ root: bare })
      expect(await backend.load()).toEqual({ sequence: 0, dbs: {} })
      expect(() => backend.commitSync(commit(1, "s:a", 1))).toThrow(DurabilityFault)
      await backend.close()
    } finally {
      fs.rmSync(bare, { recursive: true, force: true })
    }
  })

  it("closes idempotently", async () => {
    const backend = openJournalBackend({ root })
    await backend.load()
    await backend.close()
    await expect(backend.close()).resolves.toBeUndefined()
  })
})

describe("seedCheckpoint", () => {
  it("creates gen-0001 on a fresh root", () => {
    const root = tempRoot()
    try {
      expect(seedCheckpoint(root, baseState())).toBe("gen-0001")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("never re-seeds over an existing generation", () => {
    const root = tempRoot()
    try {
      writeCheckpoint(root, "gen-0001", baseState(5))
      expect(seedCheckpoint(root, baseState(0))).toBe("gen-0001")
      const backend = openJournalBackend({ root })
      return backend.load().then((state) => {
        expect(state.sequence).toBe(5)
        return backend.close()
      })
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

  /** A line exactly as a build before value codec 1 wrote it (no `valueCodec`). */
  function legacyLine(sequence: number, key: string, value: unknown): string {
    const payload = canonicalJson({
      sequence,
      committedAt: 1_000 + sequence,
      mutations: [{ database: "CogniaDB", table: "sessions", key, value }],
    })
    return `${payload}\t${sha256Hex(payload)}\n`
  }

  it("marks every line it writes as codec 1", () => {
    const line = encodeCommitLine(commit(1, "s:a", { id: "a" }))
    expect(JSON.parse(line.slice(0, line.lastIndexOf("\t"))).valueCodec).toBe(1)
  })

  it("normalises codec-0 lines on replay and reports lossy shapes", async () => {
    seedCheckpoint(root, baseState(0))
    fs.mkdirSync(path.dirname(journalFile(root, "gen-0001")), { recursive: true })
    fs.writeFileSync(
      journalFile(root, "gen-0001"),
      legacyLine(1, "s:a", { id: "a", at: { __date: "2026-11-01T00:00:00.000Z" }, blob: {} })
    )
    const backend = openJournalBackend({ root })
    const state = await backend.load()
    expect(state.dbs.CogniaDB.rows.sessions["s:a"]).toEqual({
      id: "a",
      at: {
        $cogniaSnapshotValue: {
          version: 1,
          type: "date",
          time: Date.parse("2026-11-01T00:00:00.000Z"),
        },
      },
      blob: {},
    })
    expect(state.legacyValueFindings).toEqual([
      {
        database: "CogniaDB",
        table: "sessions",
        path: "blob",
        shape: "empty-object",
        count: 1,
        sampleKeys: ["s:a"],
      },
    ])
    await backend.close()
  })

  it("will not append to a generation from before codec 1 until it is compacted", async () => {
    seedCheckpoint(root, baseState(0))
    const manifestFile = path.join(root, "generations", "gen-0001", "checkpoint.json")
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    delete manifest.valueCodec
    manifest.checkpointFormat = 3
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))

    const backend = openJournalBackend({ root })
    const state = await backend.load()
    expect(state.legacyValueCodec).toBe(true)
    // A build before codec 1 can still read gen-0001, and would replay this
    // line without decoding it.
    expect(() => backend.commitSync(commit(1, "s:a", { id: "a" }))).toThrow(
      expect.objectContaining({ code: "checkpoint-schema-mismatch" })
    )
    expect(fs.existsSync(journalFile(root, "gen-0001"))).toBe(false)

    const { generation } = await backend.compact(state)
    expect(generation).toBe("gen-0002")
    backend.commitSync(commit(1, "s:a", { id: "a" }))
    await backend.close()
    const reopened = openJournalBackend({ root })
    const reloaded = await reopened.load()
    expect(reloaded.legacyValueCodec).toBeUndefined()
    expect(reloaded.dbs.CogniaDB.rows.sessions["s:a"]).toEqual({ id: "a" })
    await reopened.close()
  })

  it("leaves codec-1 lines untouched, even ones whose shapes would look lossy under codec 0", () => {
    const line = encodeCommitLine(commit(1, "s:a", { id: "a", meta: {} }))
    const replay = replayJournal(line, 0)
    expect(replay.commits[0].mutations[0].value).toEqual({ id: "a", meta: {} })
  })

  it("refuses a line from an unknown future value codec", () => {
    const payload = canonicalJson({ ...commit(1, "s:a", { id: "a" }), valueCodec: 2 })
    expect(() => replayJournal(`${payload}\t${sha256Hex(payload)}\n`, 0)).toThrow(
      /unsupported value codec 2/
    )
  })
})
