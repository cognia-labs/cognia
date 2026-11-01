/**
 * @jest-environment node
 */
import {
  encodeSnapshotRows,
  encodeSnapshotValueSync,
  decodeSnapshotRows,
  decodeSnapshotRowsAsync,
  parseMultiSnapshot,
  parseSnapshot,
  reportLegacySnapshotRows,
  restoreMultiSnapshot,
  restoreSnapshot,
  serializeDb,
  serializeSnapshot,
  serializeSources,
  type DbLike,
} from "./snapshot"
import { encodeKey } from "../serve/persistence/canonical"

class FakeTable {
  rows: unknown[]
  constructor(
    public name: string,
    rows: unknown[] = []
  ) {
    this.rows = [...rows]
  }
  async toArray() {
    return this.rows
  }
  async clear() {
    this.rows = []
  }
  async bulkPut(rows: unknown[]) {
    this.rows.push(...rows)
  }
}

function fakeDb(tables: FakeTable[], verno = 82): DbLike {
  return { verno, tables }
}

describe("serializeDb", () => {
  it("persists v250 connection and attempt metadata across a snapshot restart", async () => {
    const tables = [
      new FakeTable("authConnections", [{ id: "ref", credentialRevision: 2 }]),
      new FakeTable("authAttempts", [{ state: "state", expiresAt: 1234 }]),
    ]
    const snapshot = await serializeDb(fakeDb(tables, 250))
    expect(Object.keys(snapshot.tables)).toEqual(["authConnections", "authAttempts"])
    const restored = [new FakeTable("authConnections"), new FakeTable("authAttempts")]
    await restoreSnapshot(fakeDb(restored, 250), JSON.parse(serializeSnapshot(snapshot)))
    expect(restored.map((table) => table.rows)).toEqual(tables.map((table) => table.rows))
  })
  it("preserves original media, thumbnails, and typed byte slices through JSON and restore", async () => {
    const bytes = Uint8Array.from({ length: 150_000 }, (_, index) => index % 251)
    const original = new Blob([bytes], { type: "video/mp4" })
    const thumbnail = new Blob(["preview"], { type: "image/png" })
    const backing = new Uint8Array([99, 1, 2, 3, 99])
    const table = new FakeTable("messageMedia", [
      {
        hash: "media",
        blob: original,
        thumb: thumbnail,
        raw: backing.subarray(1, 4),
        nested: { original: new Blob([]) },
      },
    ])
    const snapshot = await serializeDb(fakeDb([table]))
    const text = serializeSnapshot(snapshot)
    const parsed = parseSnapshot(text)
    expect(parsed.kind).toBe("valid")
    if (parsed.kind !== "valid") throw new Error("snapshot must parse")
    table.rows = []
    await restoreSnapshot(fakeDb([table]), parsed.snapshot)
    const row = table.rows[0] as {
      blob: Blob
      thumb: Blob
      raw: Uint8Array
      nested: { original: Blob }
    }
    expect(row.blob.type).toBe("video/mp4")
    expect(new Uint8Array(await row.blob.arrayBuffer())).toEqual(bytes)
    expect(await row.thumb.text()).toBe("preview")
    expect(row.raw).toBeInstanceOf(Uint8Array)
    expect([...row.raw]).toEqual([1, 2, 3])
    expect(row.nested.original.size).toBe(0)
    expect(original.size).toBe(bytes.length)
  })

  it("reads each Blob in bounded chunks instead of allocating another full source buffer", async () => {
    const blob = new Blob([new Uint8Array(200_000)])
    const read = jest.spyOn(blob, "arrayBuffer")
    const slice = jest.spyOn(blob, "slice")
    await encodeSnapshotRows([{ blob }])
    expect(read).not.toHaveBeenCalled()
    expect(slice).toHaveBeenCalledTimes(4)
    expect(slice.mock.calls.every(([start, end]) => end! - start! <= 65_536)).toBe(true)
  })

  it("restores sidecar ArrayBuffers without leaking pooled Buffer backing bytes", async () => {
    const source = new Uint8Array([1, 2, 3]).buffer
    const reference = "a".repeat(64)
    const encoded = await encodeSnapshotRows([{ source }], { write: async () => reference })
    const pooled = Buffer.from([99, 1, 2, 3, 99]).subarray(1, 4)
    const result = decodeSnapshotRows(encoded, { read: () => pooled })[0] as { source: ArrayBuffer }
    expect(result.source.byteLength).toBe(3)
    expect([...new Uint8Array(result.source)]).toEqual([1, 2, 3])
  })

  it("escapes user records that happen to use the binary envelope property", async () => {
    const rows = [
      {
        content: {
          $cogniaSnapshotValue: {
            version: 1,
            type: "blob",
            byteLength: 0,
            mediaType: "text/plain",
            chunks: [],
          },
        },
      },
    ]
    expect(decodeSnapshotRows(JSON.parse(JSON.stringify(await encodeSnapshotRows(rows))))).toEqual(
      rows
    )
    expect(
      decodeSnapshotRows([{ bytes: new Uint8Array([1]), original: new Blob(["a"]) }])[0]
    ).toMatchObject({ bytes: new Uint8Array([1]) })
  })

  it("keeps asynchronously hydrated Blobs lazy while materializing typed byte fields", async () => {
    const blob = new Blob(["original"], { type: "text/plain" })
    const read = jest.spyOn(blob, "arrayBuffer")
    const encoded = await encodeSnapshotRows(
      [{ nested: { blob }, bytes: new Uint8Array([1, 2]) }],
      {
        write: async (value) => (value instanceof Blob ? "a" : "b").repeat(64),
      }
    )
    const readBlob = jest.fn(async () => blob)
    const rows = (await decodeSnapshotRowsAsync(encoded, {
      readBlob,
      read: () => new Uint8Array([1, 2]),
    })) as Array<{ nested: { blob: Blob }; bytes: Uint8Array }>
    expect(rows[0]!.nested.blob).toBe(blob)
    expect(read).not.toHaveBeenCalled()
    expect([...rows[0]!.bytes]).toEqual([1, 2])
    expect(readBlob).toHaveBeenCalledWith("a".repeat(64), 8, "text/plain")
  })

  it("validates all async envelopes before opening source files and rejects mismatched Blobs", async () => {
    const encoded = await encodeSnapshotRows([{ blob: new Blob(["source"]) }], {
      write: async () => "a".repeat(64),
    })
    const readBlob = jest.fn(async () => new Blob(["wrong"]))
    await expect(decodeSnapshotRowsAsync(encoded, { readBlob })).rejects.toThrow(
      "metadata mismatch"
    )
    readBlob.mockClear()
    await expect(
      decodeSnapshotRowsAsync([...encoded, { $cogniaSnapshotValue: { version: 8 } }], { readBlob })
    ).rejects.toThrow("unsupported")
    expect(readBlob).not.toHaveBeenCalled()
  })

  it("rejects corrupt binary payloads before clearing any stored rows", async () => {
    const encoded = await encodeSnapshotRows([{ blob: new Blob(["original"]) }])
    const corrupt = JSON.parse(JSON.stringify(encoded))
    corrupt[0].blob.$cogniaSnapshotValue.chunks[0] = "@@@="
    const table = new FakeTable("messageMedia", [{ id: "keep" }])
    const snapshot = { version: 82, tables: { messageMedia: corrupt } }
    expect(parseSnapshot(JSON.stringify(snapshot)).kind).toBe("corrupt")
    expect(
      parseMultiSnapshot(
        JSON.stringify({ snapshotFormat: 2, dbs: { CogniaDB: snapshot } }),
        "CogniaDB"
      ).kind
    ).toBe("corrupt")
    await expect(restoreSnapshot(fakeDb([table]), snapshot)).rejects.toThrow(
      "invalid snapshot binary chunk"
    )
    expect(table.rows).toEqual([{ id: "keep" }])
  })

  it("dumps every table keyed by name with the db version", async () => {
    const db = fakeDb([new FakeTable("goals", [{ id: "g1" }]), new FakeTable("sessions", [])])
    const snap = await serializeDb(db)
    expect(snap.version).toBe(82)
    expect(snap.tables.goals).toEqual([{ id: "g1" }])
    expect(snap.tables.sessions).toEqual([])
  })
})

describe("restoreSnapshot", () => {
  it("clears and refills tables present in the snapshot, leaving others (seeds) intact", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const characters = new FakeTable("characters", [{ id: "builtin" }])
    const db = fakeDb([goals, characters])
    await restoreSnapshot(db, { version: 82, tables: { goals: [{ id: "g1" }, { id: "g2" }] } })
    expect(goals.rows).toEqual([{ id: "g1" }, { id: "g2" }])
    // characters is absent from the snapshot → seed row preserved.
    expect(characters.rows).toEqual([{ id: "builtin" }])
  })

  it("ignores snapshot tables that no longer exist in the schema", async () => {
    const goals = new FakeTable("goals", [])
    const db = fakeDb([goals])
    await restoreSnapshot(db, {
      version: 82,
      tables: { goals: [{ id: "g" }], gone: [{ id: "x" }] },
    })
    expect(goals.rows).toEqual([{ id: "g" }])
  })

  it("restores an older snapshot as an ordinary forward move", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db = fakeDb([goals], 82)

    await restoreSnapshot(db, { version: 81, tables: { goals: [{ id: "old" }] } })
    expect(goals.rows).toEqual([{ id: "old" }])
  })

  it("refuses to restore a snapshot written by a newer schema version", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const db = fakeDb([goals], 82)

    await expect(
      restoreSnapshot(db, { version: 83, tables: { goals: [{ id: "old" }] } })
    ).rejects.toThrow("schema version 83 is newer than database schema version 82")
    expect(goals.rows).toEqual([{ id: "seed" }])
  })
})

describe("parseSnapshot", () => {
  it("parses a valid snapshot", () => {
    expect(parseSnapshot('{"version":82,"tables":{"goals":[]}}')).toEqual({
      kind: "valid",
      snapshot: {
        version: 82,
        tables: { goals: [] },
      },
    })
  })

  it("distinguishes an absent snapshot from corrupt content", () => {
    expect(parseSnapshot(null)).toEqual({ kind: "absent" })
    expect(parseSnapshot(undefined)).toEqual({ kind: "absent" })
    expect(parseSnapshot("")).toMatchObject({ kind: "corrupt" })
    expect(parseSnapshot("not json")).toMatchObject({ kind: "corrupt" })
    expect(parseSnapshot("[1,2,3]")).toMatchObject({ kind: "corrupt" })
    expect(parseSnapshot('{"version":1}')).toMatchObject({ kind: "corrupt" })
  })
})

describe("serializeSnapshot", () => {
  it("round-trips through parseSnapshot", () => {
    const snap = { version: 82, tables: { goals: [{ id: "g" }] } }
    expect(parseSnapshot(serializeSnapshot(snap))).toEqual({ kind: "valid", snapshot: snap })
  })
})

describe("serializeDb — excludeTables", () => {
  it("omits excluded tables entirely rather than writing them empty", async () => {
    const db = fakeDb([new FakeTable("tasks", [{ id: "t" }]), new FakeTable("executions", [{}])])
    const snap = await serializeDb(db, { excludeTables: ["executions"] })
    expect(snap.tables.tasks).toEqual([{ id: "t" }])
    expect(snap.tables).not.toHaveProperty("executions")
  })
})

describe("serializeSources", () => {
  it("keys each database by name and honours its own exclusions", async () => {
    const goals = new FakeTable("goals", [{ id: "g" }])
    const tasks = new FakeTable("tasks", [{ id: "t" }])
    const executions = new FakeTable("executions", [{ id: "run" }])
    const snap = await serializeSources([
      { name: "CogniaDB", db: fakeDb([goals]) },
      {
        name: "CogniaSchedulerDB",
        db: fakeDb([tasks, executions], 2),
        excludeTables: ["executions"],
      },
    ])
    expect(snap.snapshotFormat).toBe(3)
    expect(snap.dbs.CogniaDB).toEqual({ version: 82, tables: { goals: [{ id: "g" }] } })
    expect(snap.dbs.CogniaSchedulerDB).toEqual({ version: 2, tables: { tasks: [{ id: "t" }] } })
  })
})

describe("restoreMultiSnapshot", () => {
  it("restores each source from its own key", async () => {
    const goals = new FakeTable("goals", [{ id: "seed" }])
    const tasks = new FakeTable("tasks", [])
    await restoreMultiSnapshot(
      [
        { name: "CogniaDB", db: fakeDb([goals]) },
        { name: "CogniaSchedulerDB", db: fakeDb([tasks], 2) },
      ],
      {
        snapshotFormat: 3,
        dbs: {
          CogniaDB: { version: 82, tables: { goals: [{ id: "g" }] } },
          CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } },
        },
      }
    )
    expect(goals.rows).toEqual([{ id: "g" }])
    expect(tasks.rows).toEqual([{ id: "t" }])
  })

  it("skips a database the envelope omits, leaving its rows untouched", async () => {
    const tasks = new FakeTable("tasks", [{ id: "kept" }])
    await restoreMultiSnapshot([{ name: "CogniaSchedulerDB", db: fakeDb([tasks], 2) }], {
      snapshotFormat: 3,
      dbs: { CogniaDB: { version: 82, tables: {} } },
    })
    expect(tasks.rows).toEqual([{ id: "kept" }])
  })

  it("names the database in a per-db version mismatch", async () => {
    const tasks = new FakeTable("tasks", [])
    await expect(
      restoreMultiSnapshot([{ name: "CogniaSchedulerDB", db: fakeDb([tasks], 2) }], {
        snapshotFormat: 3,
        dbs: { CogniaSchedulerDB: { version: 3, tables: { tasks: [] } } },
      })
    ).rejects.toThrow("database CogniaSchedulerDB")
  })
})

describe("parseMultiSnapshot", () => {
  it("normalises a legacy single-database snapshot onto the primary name", () => {
    expect(parseMultiSnapshot('{"version":82,"tables":{"goals":[]}}', "CogniaDB")).toEqual({
      kind: "valid",
      snapshot: {
        snapshotFormat: 3,
        dbs: { CogniaDB: { version: 82, tables: { goals: [] } } },
        legacyValueCodec: true,
      },
    })
  })

  it("parses a multi-database envelope", () => {
    const text = JSON.stringify({
      snapshotFormat: 2,
      dbs: { CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } } },
    })
    // Format 2 is still read, and normalised to the current envelope.
    expect(parseMultiSnapshot(text, "CogniaDB")).toEqual({
      kind: "valid",
      snapshot: {
        snapshotFormat: 3,
        dbs: { CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } } },
        legacyValueCodec: true,
      },
    })
  })

  it("round-trips serializeSources output", async () => {
    const snap = await serializeSources([
      { name: "CogniaDB", db: fakeDb([new FakeTable("goals")]) },
    ])
    expect(parseMultiSnapshot(serializeSnapshot(snap), "CogniaDB")).toEqual({
      kind: "valid",
      snapshot: snap,
    })
  })

  it("distinguishes absent from corrupt and rejects unknown formats", () => {
    expect(parseMultiSnapshot(null, "CogniaDB")).toEqual({ kind: "absent" })
    expect(parseMultiSnapshot(undefined, "CogniaDB")).toEqual({ kind: "absent" })
    expect(parseMultiSnapshot("not json", "CogniaDB")).toMatchObject({ kind: "corrupt" })
    expect(parseMultiSnapshot("[1,2]", "CogniaDB")).toMatchObject({ kind: "corrupt" })
    // Legacy path still validated by parseSnapshot's rules.
    expect(parseMultiSnapshot('{"version":1}', "CogniaDB")).toMatchObject({ kind: "corrupt" })
    expect(parseMultiSnapshot('{"snapshotFormat":1,"dbs":{}}', "CogniaDB")).toMatchObject({
      kind: "corrupt",
      reason: "unsupported snapshot format 1",
    })
    // A newer build's file is not damage, and must not read as such.
    expect(parseMultiSnapshot('{"snapshotFormat":4,"dbs":{}}', "CogniaDB")).toEqual({
      kind: "newer",
      reason:
        "snapshot format 4 was written by a newer version of Cognia (this version reads up to 3)",
    })
    expect(parseMultiSnapshot('{"snapshotFormat":2,"dbs":[]}', "CogniaDB")).toMatchObject({
      kind: "corrupt",
      reason: "snapshot dbs are not an object",
    })
  })

  it("rejects a malformed per-database entry and says which one", () => {
    const cases = [
      '{"snapshotFormat":2,"dbs":{"X":null}}',
      '{"snapshotFormat":2,"dbs":{"X":[]}}',
      '{"snapshotFormat":2,"dbs":{"X":{"tables":{}}}}',
      '{"snapshotFormat":2,"dbs":{"X":{"version":1}}}',
      '{"snapshotFormat":2,"dbs":{"X":{"version":1,"tables":[]}}}',
      '{"snapshotFormat":2,"dbs":{"X":{"version":1,"tables":{"t":"nope"}}}}',
    ]
    for (const text of cases) {
      expect(parseMultiSnapshot(text, "CogniaDB")).toEqual({
        kind: "corrupt",
        reason: "snapshot for database X is malformed",
      })
    }
  })
})

describe("what a pre-codec-1 snapshot may have lost", () => {
  type Finding = [string, string, string, string, string]
  const collect = () => {
    const found: Finding[] = []
    return {
      found,
      report: (database: string, table: string, key: string, path: string, shape: string) => {
        found.push([database, table, key, path, shape])
      },
    }
  }

  // Exactly what the pre-codec-1 encoder wrote for each value it could not keep.
  const legacyRow = {
    id: "r1",
    createdAt: "2026-10-01T08:00:00.000Z",
    tags: {},
    floats: { "0": 1.5, "1": null },
    attachment: {
      $cogniaSnapshotValue: {
        version: 1,
        type: "blob",
        mediaType: "text/plain",
        byteLength: 0,
        chunks: [],
      },
    },
    bytes: { $cogniaSnapshotValue: { version: 1, type: "uint8array", byteLength: 0, chunks: [] } },
    nested: { history: [{ at: "2026-10-02T09:30:00.000Z", note: "plain text" }] },
    escaped: {
      $cogniaSnapshotValue: { version: 1, type: "record", entries: [["meta", {}]] },
    },
    title: "2026-10-01",
  }

  it("names each lossy shape by row and field path, and leaves the rows alone", () => {
    const { found, report } = collect()
    const rows = [legacyRow, { name: "no id", lookup: {} }]
    const before = JSON.stringify(rows)
    reportLegacySnapshotRows(rows, "CogniaDB", "items", report)
    expect(JSON.stringify(rows)).toBe(before)
    const r1 = encodeKey("r1")
    expect(found).toEqual([
      ["CogniaDB", "items", r1, "createdAt", "iso-date-string"],
      ["CogniaDB", "items", r1, "tags", "empty-object"],
      ["CogniaDB", "items", r1, "floats", "index-keyed-object"],
      ["CogniaDB", "items", r1, "attachment", "legacy-blob"],
      ["CogniaDB", "items", r1, "nested.history[].at", "iso-date-string"],
      ["CogniaDB", "items", r1, "escaped.meta", "empty-object"],
      ["CogniaDB", "items", "#1", "lookup", "empty-object"],
    ])
  })

  it("reports a legacy file's rows during restore, and a current file's never", async () => {
    for (const [text, expected] of [
      [
        JSON.stringify({
          snapshotFormat: 2,
          dbs: { CogniaDB: { version: 82, tables: { items: [legacyRow] } } },
        }),
        6,
      ],
      [JSON.stringify({ version: 82, tables: { items: [legacyRow] } }), 6],
      [
        JSON.stringify({
          snapshotFormat: 3,
          dbs: { CogniaDB: { version: 82, tables: { items: [legacyRow] } } },
        }),
        0,
      ],
    ] as const) {
      const parsed = parseMultiSnapshot(text, "CogniaDB")
      if (parsed.kind !== "valid") throw new Error(parsed.kind)
      const table = new FakeTable("items")
      const { found, report } = collect()
      await restoreMultiSnapshot(
        [{ name: "CogniaDB", db: fakeDb([table]) }],
        parsed.snapshot,
        report
      )
      expect(found).toHaveLength(expected)
      // Restored exactly as before: reporting changes nothing.
      expect((table.rows[0] as { createdAt: unknown }).createdAt).toBe("2026-10-01T08:00:00.000Z")
    }
  })

  it("reports only the tables restore actually restores", async () => {
    const lossy = { id: "x", at: "2026-10-01T08:00:00.000Z" }
    const parsed = parseMultiSnapshot(
      JSON.stringify({
        snapshotFormat: 2,
        dbs: {
          CogniaDB: {
            version: 82,
            tables: {
              items: [lossy],
              // Derived (regenerated, never restored) and absent from the live schema.
              sessionList: [lossy],
              droppedTable: [lossy],
              // The derived readiness row is filtered out of restore.
              storageLayout: [{ id: "session-list-v241", at: "2026-10-01T08:00:00.000Z" }],
            },
          },
        },
      }),
      "CogniaDB"
    )
    if (parsed.kind !== "valid") throw new Error(parsed.kind)
    const { found, report } = collect()
    const db = fakeDb([
      new FakeTable("items"),
      new FakeTable("sessionList"),
      new FakeTable("storageLayout"),
    ])
    await restoreMultiSnapshot([{ name: "CogniaDB", db }], parsed.snapshot, report)
    expect(found.map((finding) => finding[1])).toEqual(["items"])
  })
})

it("omits derived session lists and their readiness from snapshots and legacy restore", async () => {
  const marker = { id: "singleton", layout: "single-database" }
  const readiness = { id: "session-list-v241", version: 1 }
  const sessions = new FakeTable("sessions", [{ id: "s", title: "Source" }])
  const projection = new FakeTable("sessionList", [{ id: "s", title: "Current" }])
  const layout = new FakeTable("storageLayout", [marker, readiness])
  const db = fakeDb([sessions, projection, layout], 241)
  expect((await serializeDb(db)).tables).toEqual({
    sessions: sessions.rows,
    storageLayout: [marker],
  })
  await restoreSnapshot(db, {
    version: 241,
    tables: {
      sessions: [{ id: "s", title: "Restored source" }],
      sessionList: [{ id: "s", title: "Stale" }],
      storageLayout: [marker, readiness],
    },
  })
  expect(sessions.rows).toEqual([{ id: "s", title: "Restored source" }])
  expect(projection.rows).toEqual([{ id: "s", title: "Current" }])
  expect(layout.rows).toEqual([marker])
})

describe("encodeSnapshotValueSync", () => {
  const readBlob = () => Uint8Array.from([1, 2, 3])
  const tag = (value: unknown) => Object.prototype.toString.call(value)

  it("writes the async encoder's envelope for the types both encode", async () => {
    const value = { u8: Uint8Array.from([4, 5]), buffer: Uint8Array.from([6]).buffer }
    expect(encodeSnapshotValueSync(value, { readBlob })).toEqual(
      (await encodeSnapshotRows([value]))[0]
    )
    const blob = new Blob([Uint8Array.from([1, 2, 3])], { type: "text/plain" })
    expect(encodeSnapshotValueSync({ blob }, { readBlob })).toEqual(
      (await encodeSnapshotRows([{ blob }]))[0]
    )
  })

  it("keeps what the async encoder flattens: typed arrays, Date, Map, Set, bigint", () => {
    const decoded = decodeSnapshotRows(
      JSON.parse(
        JSON.stringify([
          encodeSnapshotValueSync(
            {
              f64: Float64Array.from([2.5]),
              at: new Date(5),
              map: new Map([[1, "a"]]),
              set: new Set(["x"]),
              big: BigInt("-7"),
            },
            { readBlob }
          ),
        ])
      )
    )[0] as Record<string, unknown>
    expect(tag(decoded.f64)).toBe("[object Float64Array]")
    expect((decoded.at as Date).getTime()).toBe(5)
    expect((decoded.map as Map<number, string>).get(1)).toBe("a")
    expect((decoded.set as Set<string>).has("x")).toBe(true)
    expect(decoded.big).toBe(BigInt("-7"))
  })

  it("reads a value's type from its internal slots, not from Symbol.toStringTag", () => {
    const roundTrip = (value: unknown) =>
      decodeSnapshotRows(
        JSON.parse(JSON.stringify([encodeSnapshotValueSync(value, { readBlob })]))
      )[0]
    // A Map subclass, whatever its tag, is a Map (what structuredClone keeps).
    class Lru extends Map<string, number> {
      get [Symbol.toStringTag]() {
        return "Lru"
      }
    }
    const lru = roundTrip(new Lru([["k", 1]])) as Map<string, number>
    expect(tag(lru)).toBe("[object Map]")
    expect(lru.get("k")).toBe(1)
    // An object that only claims a built-in type is an ordinary object.
    const claims = (name: string) => ({ own: 1, [Symbol.toStringTag]: name })
    for (const name of ["Map", "Date", "ArrayBuffer", "Uint16Array", "Error"]) {
      expect(roundTrip(claims(name))).toEqual({ own: 1 })
    }
    // A Blob or File that only claims to be one (a jsdom or polyfill Blob)
    // has no bytes this codec can read: refused, never stored as `{}`.
    expect(() => encodeSnapshotValueSync(claims("Blob"), { readBlob })).toThrow(
      "Cannot durably encode a Blob value"
    )
    // A real platform type the codec does not know is still refused.
    expect(() => encodeSnapshotValueSync(new WeakMap(), { readBlob })).toThrow(
      "Cannot durably encode a WeakMap value"
    )
  })

  it("refuses a function, which no IndexedDB row can hold", () => {
    expect(() => encodeSnapshotValueSync({ toJSON: () => ({ key: "x" }) }, { readBlob })).toThrow(
      /function/
    )
  })

  it("uses readBlob for Blob bytes", () => {
    const encoded = encodeSnapshotValueSync(new Blob(["ignored"], { type: "a/b" }), { readBlob })
    expect(encoded).toEqual({
      $cogniaSnapshotValue: {
        version: 1,
        type: "blob",
        byteLength: 3,
        mediaType: "a/b",
        chunks: ["AQID"],
      },
    })
  })
})

describe("decoding the codec-1 envelope types", () => {
  const envelope = (data: Record<string, unknown>) => [
    { $cogniaSnapshotValue: { version: 1, ...data } },
  ]

  it("rejects malformed dates, bigints, maps and sets", () => {
    expect(() => decodeSnapshotRows(envelope({ type: "date", time: "x" }))).toThrow(/date/)
    expect(() => decodeSnapshotRows(envelope({ type: "date", time: Infinity }))).toThrow(/date/)
    expect(() => decodeSnapshotRows(envelope({ type: "bigint", value: "1.5" }))).toThrow(/bigint/)
    expect(() => decodeSnapshotRows(envelope({ type: "map", entries: [[1]] }))).toThrow(/map/)
    expect(() => decodeSnapshotRows(envelope({ type: "set", values: {} }))).toThrow(/set/)
  })

  it("rejects a typed array whose byte length is not a whole number of elements", () => {
    expect(() =>
      decodeSnapshotRows(envelope({ type: "int16array", byteLength: 3, chunks: ["AQID"] }))
    ).toThrow(/binary metadata/)
  })

  it("rejects an envelope type it does not know", () => {
    expect(() =>
      decodeSnapshotRows(envelope({ type: "constructor", byteLength: 0, chunks: [] }))
    ).toThrow(/binary metadata/)
  })
})
