/**
 * @jest-environment node
 */
import {
  encodeSnapshotRows,
  encodeSnapshotValueSync,
  decodeSnapshotRows,
  decodeSnapshotRowsAsync,
  parseMultiSnapshot,
  restoreMultiSnapshot,
  restoreSnapshot,
  selectSnapshotRestoreTables,
  serializeDb,
  serializeSnapshot,
  serializeSources,
  type DbLike,
} from "./snapshot"

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

describe("selectSnapshotRestoreTables", () => {
  it("keeps available authoritative targets in caller order, including installed plugin tables", () => {
    const names = [
      "messages",
      "petConversation",
      "sessionList",
      "uninstalled-plugin:records",
      "installed-plugin:records",
      "goals",
      "messages",
    ]
    const originalNames = [...names]
    const schema = new Set(["goals", "sessionList", "messages", "installed-plugin:records"])
    expect(selectSnapshotRestoreTables(names, schema)).toEqual([
      "messages",
      "installed-plugin:records",
      "goals",
      "messages",
    ])
    expect(names).toEqual(originalNames)
    expect([...schema]).toEqual(["goals", "sessionList", "messages", "installed-plugin:records"])
    expect(selectSnapshotRestoreTables([], schema)).toEqual([])
    expect(selectSnapshotRestoreTables(names, new Set())).toEqual([])
  })
})

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
    const text = serializeSnapshot({ snapshotFormat: 3, dbs: { CogniaDB: snapshot } })
    const parsed = parseMultiSnapshot(text)
    expect(parsed.kind).toBe("valid")
    if (parsed.kind !== "valid") throw new Error("snapshot must parse")
    table.rows = []
    await restoreSnapshot(fakeDb([table]), parsed.snapshot.dbs.CogniaDB)
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
    expect(
      parseMultiSnapshot(JSON.stringify({ snapshotFormat: 3, dbs: { CogniaDB: snapshot } })).kind
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

  it("keeps schema order and seeds while skipping dropped, unavailable and derived tables", async () => {
    const messages = new FakeTable("messages", [{ id: "seed-message" }])
    const goals = new FakeTable("goals", [{ id: "seed-goal" }])
    const seeded = new FakeTable("characters", [{ id: "builtin" }])
    const derived = new FakeTable("sessionList", [{ id: "derived" }])
    const clears: string[] = []
    for (const table of [messages, goals, seeded, derived]) {
      jest.spyOn(table, "clear").mockImplementation(async () => {
        clears.push(table.name)
        table.rows = []
      })
    }
    const snapshot = {
      version: 219,
      tables: {
        goals: [],
        petConversation: [{ id: "legacy" }],
        "uninstalled-plugin:records": [{ id: "plugin-row" }],
        sessionList: [null],
        messages: [{ id: "restored-message" }],
      },
    }
    const before = JSON.stringify(snapshot)
    await restoreSnapshot(fakeDb([messages, goals, seeded, derived], 250), snapshot)
    expect(clears).toEqual(["messages", "goals"])
    expect(messages.rows).toEqual([{ id: "restored-message" }])
    expect(goals.rows).toEqual([])
    expect(seeded.rows).toEqual([{ id: "builtin" }])
    expect(derived.rows).toEqual([{ id: "derived" }])
    expect(JSON.stringify(snapshot)).toBe(before)
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

describe("serializeSnapshot", () => {
  it("round-trips through parseMultiSnapshot", () => {
    const snap = {
      snapshotFormat: 3 as const,
      dbs: { CogniaDB: { version: 82, tables: { goals: [{ id: "g" }] } } },
    }
    expect(parseMultiSnapshot(serializeSnapshot(snap))).toEqual({ kind: "valid", snapshot: snap })
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
  it("parses a multi-database envelope", () => {
    const text = JSON.stringify({
      snapshotFormat: 3,
      dbs: { CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } } },
    })
    expect(parseMultiSnapshot(text)).toEqual({
      kind: "valid",
      snapshot: {
        snapshotFormat: 3,
        dbs: { CogniaSchedulerDB: { version: 2, tables: { tasks: [{ id: "t" }] } } },
      },
    })
  })

  it("round-trips serializeSources output", async () => {
    const snap = await serializeSources([
      { name: "CogniaDB", db: fakeDb([new FakeTable("goals")]) },
    ])
    expect(parseMultiSnapshot(serializeSnapshot(snap))).toEqual({
      kind: "valid",
      snapshot: snap,
    })
  })

  it("distinguishes absent from corrupt and rejects unknown formats", () => {
    expect(parseMultiSnapshot(null)).toEqual({ kind: "absent" })
    expect(parseMultiSnapshot(undefined)).toEqual({ kind: "absent" })
    expect(parseMultiSnapshot("not json")).toMatchObject({ kind: "corrupt" })
    expect(parseMultiSnapshot("[1,2]")).toMatchObject({ kind: "corrupt" })
    // A single-database file and the older envelope formats are not read.
    expect(parseMultiSnapshot('{"version":82,"tables":{"goals":[]}}')).toMatchObject({
      kind: "corrupt",
      reason: "unsupported snapshot format undefined",
    })
    for (const format of [1, 2]) {
      expect(parseMultiSnapshot(`{"snapshotFormat":${format},"dbs":{}}`)).toMatchObject({
        kind: "corrupt",
        reason: `unsupported snapshot format ${format}`,
      })
    }
    // A newer build's file is not damage, and must not read as such.
    expect(parseMultiSnapshot('{"snapshotFormat":4,"dbs":{}}')).toEqual({
      kind: "newer",
      reason:
        "snapshot format 4 was written by a newer version of Cognia (this version reads up to 3)",
    })
    expect(parseMultiSnapshot('{"snapshotFormat":3,"dbs":[]}')).toMatchObject({
      kind: "corrupt",
      reason: "snapshot dbs are not an object",
    })
  })

  it("rejects a malformed per-database entry and says which one", () => {
    const cases = [
      '{"snapshotFormat":3,"dbs":{"X":null}}',
      '{"snapshotFormat":3,"dbs":{"X":[]}}',
      '{"snapshotFormat":3,"dbs":{"X":{"tables":{}}}}',
      '{"snapshotFormat":3,"dbs":{"X":{"version":1}}}',
      '{"snapshotFormat":3,"dbs":{"X":{"version":1,"tables":[]}}}',
      '{"snapshotFormat":3,"dbs":{"X":{"version":1,"tables":{"t":"nope"}}}}',
    ]
    for (const text of cases) {
      expect(parseMultiSnapshot(text)).toEqual({
        kind: "corrupt",
        reason: "snapshot for database X is malformed",
      })
    }
  })
})

it("omits derived session lists and their readiness from snapshots and restore", async () => {
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
