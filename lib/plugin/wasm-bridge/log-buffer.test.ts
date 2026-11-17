import {
  __resetWasmLogBufferForTesting,
  bindWasmLogGeneration,
  clearWasmLogs,
  getWasmLogCursor,
  getWasmLogs,
  hasWasmLogGap,
  ingestWasmLogDrain,
  ingestWasmLogRecord,
  parseWasmLogRecord,
  recordWasmLogDrainFailure,
  subscribeWasmLogEntries,
  subscribeWasmLogs,
  wasmLevelToPluginLevel,
  WASM_LOG_DRAIN_FAILURE_KIND,
  WASM_LOG_LIMIT,
  type WasmLogRecord,
} from "./log-buffer"

function record(overrides: Partial<WasmLogRecord> = {}): WasmLogRecord {
  return {
    pluginId: "calc",
    generation: "host-1",
    sequence: 1,
    level: "info",
    scope: "",
    message: "hello",
    timestampMs: 1_000,
    ...overrides,
  }
}

beforeEach(() => {
  __resetWasmLogBufferForTesting()
})

describe("parseWasmLogRecord", () => {
  it("accepts the host's wire shape", () => {
    expect(parseWasmLogRecord({ ...record(), extra: true })).toEqual(record())
  })

  it.each([
    ["no plugin id", { pluginId: "" }],
    ["no generation", { generation: "" }],
    ["a zero sequence", { sequence: 0 }],
    ["a fractional sequence", { sequence: 1.5 }],
    ["an unknown level", { level: "fatal" }],
    ["a non-string message", { message: 3 }],
    ["a non-string scope", { scope: null }],
    ["a non-finite timestamp", { timestampMs: Number.NaN }],
  ])("drops a record with %s", (_label, change) => {
    expect(parseWasmLogRecord({ ...record(), ...change })).toBeNull()
  })

  it("drops non-objects", () => {
    expect(parseWasmLogRecord(null)).toBeNull()
    expect(parseWasmLogRecord("line")).toBeNull()
  })
})

describe("wasmLevelToPluginLevel", () => {
  it("reads trace as debug and keeps the rest", () => {
    expect(wasmLevelToPluginLevel("trace")).toBe("debug")
    expect(wasmLevelToPluginLevel("error")).toBe("error")
  })
})

describe("ingestWasmLogRecord", () => {
  it("normalizes a record into a runtime log entry with its scope as the kind", () => {
    ingestWasmLogRecord(record({ scope: "math", level: "warn", message: "careful" }))
    expect(getWasmLogs("calc")).toEqual([
      {
        id: "wasm-calc-host-1-1",
        pluginId: "calc",
        runtime: "wasm",
        generation: "host-1",
        level: "warn",
        message: "careful",
        timestamp: 1_000,
        kind: "math",
      },
    ])
  })

  it("redacts credential-shaped text before keeping it", () => {
    ingestWasmLogRecord(
      record({ scope: "api_key=abc123", message: "Authorization: Bearer sk-live-xyz for a@b.io" })
    )
    const [entry] = getWasmLogs("calc")
    expect(entry.message).not.toContain("sk-live-xyz")
    expect(entry.message).not.toContain("a@b.io")
    expect(entry.kind).not.toContain("abc123")
  })

  it("keeps one copy when the event and a drain both carry a line", () => {
    expect(ingestWasmLogRecord(record())).toBe(true)
    expect(ingestWasmLogRecord(record())).toBe(false)
    expect(getWasmLogs("calc")).toHaveLength(1)
  })

  it("keeps each plugin's lines apart", () => {
    ingestWasmLogRecord(record())
    ingestWasmLogRecord(record({ pluginId: "other" }))
    expect(getWasmLogs("calc")).toHaveLength(1)
    expect(getWasmLogs("other")).toHaveLength(1)
  })

  it("bounds the history and drops the oldest", () => {
    for (let sequence = 1; sequence <= WASM_LOG_LIMIT + 5; sequence += 1) {
      ingestWasmLogRecord(record({ sequence, timestampMs: sequence }))
    }
    const entries = getWasmLogs("calc")
    expect(entries).toHaveLength(WASM_LOG_LIMIT)
    expect(entries[0].id).toBe("wasm-calc-host-1-6")
  })

  it("keeps time order when a drain delivers a line after a later event", () => {
    ingestWasmLogRecord(record({ sequence: 2, timestampMs: 20, message: "second" }))
    ingestWasmLogRecord(record({ sequence: 1, timestampMs: 10, message: "first" }))
    expect(getWasmLogs("calc").map((e) => e.message)).toEqual(["first", "second"])
  })

  it("tells subscribers which plugin changed and hands the bridge each new entry", () => {
    const changed = jest.fn()
    const written = jest.fn()
    const off = subscribeWasmLogs(changed)
    const offEntries = subscribeWasmLogEntries(written)
    ingestWasmLogRecord(record())
    ingestWasmLogRecord(record())
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith("calc")
    expect(written).toHaveBeenCalledTimes(1)
    off()
    offEntries()
    ingestWasmLogRecord(record({ sequence: 2 }))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it("survives a subscriber that throws", () => {
    subscribeWasmLogs(() => {
      throw new Error("bad subscriber")
    })
    expect(() => ingestWasmLogRecord(record())).not.toThrow()
    expect(getWasmLogs("calc")).toHaveLength(1)
  })
})

describe("generations", () => {
  it("reads a line under the lifecycle generation its host generation is bound to", () => {
    bindWasmLogGeneration("calc", "host-1", 7)
    ingestWasmLogRecord(record())
    expect(getWasmLogs("calc")[0].generation).toBe("7")
  })

  it("applies a binding that arrives after the line, and says so to subscribers", () => {
    ingestWasmLogRecord(record())
    const changed = jest.fn()
    subscribeWasmLogs(changed)
    bindWasmLogGeneration("calc", "host-1", 3)
    expect(getWasmLogs("calc")[0].generation).toBe("3")
    expect(changed).toHaveBeenCalledWith("calc")
  })

  it("keeps a line of one load out of the next one's generation", () => {
    bindWasmLogGeneration("calc", "host-1", 1)
    bindWasmLogGeneration("calc", "host-2", 2)
    ingestWasmLogRecord(record({ generation: "host-1", message: "old load" }))
    ingestWasmLogRecord(record({ generation: "host-2", message: "new load", timestampMs: 2_000 }))
    const byGeneration = getWasmLogs("calc").map((e) => [e.generation, e.message])
    expect(byGeneration).toEqual([
      ["1", "old load"],
      ["2", "new load"],
    ])
  })

  it("starts a new load's sequence from nothing and moves the cursor to it", () => {
    ingestWasmLogRecord(record({ generation: "host-1", sequence: 4 }))
    ingestWasmLogRecord(record({ generation: "host-2", sequence: 1 }))
    expect(getWasmLogCursor("calc")).toEqual({ generation: "host-2", afterSequence: 1 })
  })

  it("keeps a late line from a replaced load without moving the cursor back", () => {
    ingestWasmLogRecord(record({ generation: "host-1", sequence: 1 }))
    ingestWasmLogRecord(record({ generation: "host-2", sequence: 1 }))
    expect(ingestWasmLogRecord(record({ generation: "host-1", sequence: 2 }))).toBe(true)
    expect(ingestWasmLogRecord(record({ generation: "host-1", sequence: 2 }))).toBe(false)
    expect(getWasmLogCursor("calc")).toEqual({ generation: "host-2", afterSequence: 1 })
  })
})

describe("cursor and gaps", () => {
  it("is null before the first line", () => {
    expect(getWasmLogCursor("calc")).toBeNull()
    expect(hasWasmLogGap("calc")).toBe(false)
  })

  it("reports a gap when a line arrives ahead of a missing one, until it is filled", () => {
    ingestWasmLogRecord(record({ sequence: 1 }))
    ingestWasmLogRecord(record({ sequence: 3 }))
    expect(hasWasmLogGap("calc")).toBe(true)
    expect(getWasmLogCursor("calc")).toEqual({ generation: "host-1", afterSequence: 1 })
    ingestWasmLogRecord(record({ sequence: 2 }))
    expect(hasWasmLogGap("calc")).toBe(false)
    expect(getWasmLogCursor("calc")).toEqual({ generation: "host-1", afterSequence: 3 })
  })

  it("treats a first line past 1 as a gap: init logged before anyone listened", () => {
    ingestWasmLogRecord(record({ sequence: 4 }))
    expect(hasWasmLogGap("calc")).toBe(true)
  })
})

describe("ingestWasmLogDrain", () => {
  it("keeps the drained lines and closes the gap they cover", () => {
    ingestWasmLogRecord(record({ sequence: 3, timestampMs: 30 }))
    const kept = ingestWasmLogDrain("calc", {
      generation: "host-1",
      entries: [record({ sequence: 1, timestampMs: 10 }), record({ sequence: 2, timestampMs: 20 })],
    })
    expect(kept).toBe(2)
    expect(hasWasmLogGap("calc")).toBe(false)
    expect(getWasmLogs("calc").map((e) => e.id)).toEqual([
      "wasm-calc-host-1-1",
      "wasm-calc-host-1-2",
      "wasm-calc-host-1-3",
    ])
  })

  it("treats what the host evicted as gone, not as a gap", () => {
    ingestWasmLogRecord(record({ sequence: 700 }))
    ingestWasmLogDrain("calc", {
      generation: "host-1",
      entries: [record({ sequence: 699 })],
    })
    expect(hasWasmLogGap("calc")).toBe(false)
    expect(getWasmLogCursor("calc")).toEqual({ generation: "host-1", afterSequence: 700 })
  })

  it("ignores malformed entries and entries of another plugin or generation", () => {
    const kept = ingestWasmLogDrain("calc", {
      generation: "host-1",
      entries: [
        { nope: true },
        record({ pluginId: "other" }),
        record({ generation: "host-0" }),
        record({ sequence: 1 }),
      ],
    })
    expect(kept).toBe(1)
  })

  it("does nothing for a plugin the host never loaded", () => {
    expect(ingestWasmLogDrain("calc", { generation: null, entries: [] })).toBe(0)
    expect(getWasmLogCursor("calc")).toBeNull()
  })
})

describe("clearWasmLogs", () => {
  it("empties the history and keeps cleared lines from coming back in a drain", () => {
    ingestWasmLogRecord(record({ sequence: 1 }))
    ingestWasmLogRecord(record({ sequence: 2 }))
    const changed = jest.fn()
    subscribeWasmLogs(changed)
    clearWasmLogs("calc")
    expect(getWasmLogs("calc")).toEqual([])
    expect(changed).toHaveBeenCalledWith("calc")
    ingestWasmLogDrain("calc", {
      generation: "host-1",
      entries: [record({ sequence: 1 }), record({ sequence: 2 }), record({ sequence: 3 })],
    })
    expect(getWasmLogs("calc").map((e) => e.id)).toEqual(["wasm-calc-host-1-3"])
  })
})

describe("recordWasmLogDrainFailure", () => {
  it("records the Error's message and stack through the shared serializer, in every generation", () => {
    const failure = new Error("command plugin_wasm_logs not found")
    const written = jest.fn()
    subscribeWasmLogEntries(written)
    recordWasmLogDrainFailure("calc", failure)
    const [entry] = getWasmLogs("calc")
    expect(entry).toMatchObject({
      runtime: "wasm",
      generation: null,
      level: "error",
      message: "command plugin_wasm_logs not found",
      kind: WASM_LOG_DRAIN_FAILURE_KIND,
      stack: failure.stack,
    })
    expect(written).toHaveBeenCalledWith(entry)
  })

  it("accepts a non-Error rejection, as Tauri's invoke rejects with a string", () => {
    recordWasmLogDrainFailure("calc", "plugin_id is empty")
    expect(getWasmLogs("calc")[0]).toMatchObject({ message: "plugin_id is empty" })
    expect(getWasmLogs("calc")[0].stack).toBeUndefined()
  })
})
