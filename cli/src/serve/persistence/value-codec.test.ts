import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { stopBlobReader } from "./blob-sync"
import {
  LegacyValueReport,
  decodeDurableValue,
  encodeDurableValue,
  formatLegacyValueFinding,
  legacyValueReportPath,
  normalizeLegacyValue,
  readLegacyValueReport,
  recordLegacyValueFindings,
  VALUE_CODEC,
} from "./value-codec"

afterAll(async () => {
  await stopBlobReader()
})

const tag = (value: unknown) => Object.prototype.toString.call(value)
/** What a backend stores and hands back: JSON text. */
const throughJson = (value: unknown) => JSON.parse(JSON.stringify(encodeDurableValue(value)))

describe("encodeDurableValue / decodeDurableValue", () => {
  it("is codec 1", () => {
    expect(VALUE_CODEC).toBe(1)
  })

  it("round-trips a Blob with its bytes and media type", async () => {
    const decoded = decodeDurableValue(
      throughJson(new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/ogg" }))
    ) as Blob
    expect(decoded).toBeInstanceOf(Blob)
    expect(decoded.type).toBe("audio/ogg")
    expect(Array.from(new Uint8Array(await decoded.arrayBuffer()))).toEqual([1, 2, 3])
  })

  it("round-trips every typed-array kind, DataView and ArrayBuffer", () => {
    const cases: Array<[unknown, string, number[]]> = [
      [Int8Array.from([-1, 2]), "[object Int8Array]", [-1, 2]],
      [Uint8ClampedArray.from([0, 255]), "[object Uint8ClampedArray]", [0, 255]],
      [Int16Array.from([-300, 300]), "[object Int16Array]", [-300, 300]],
      [Uint16Array.from([65535]), "[object Uint16Array]", [65535]],
      [Int32Array.from([-70000]), "[object Int32Array]", [-70000]],
      [Uint32Array.from([4_000_000_000]), "[object Uint32Array]", [4_000_000_000]],
      [Float32Array.from([0.5]), "[object Float32Array]", [0.5]],
      [Float64Array.from([Math.PI]), "[object Float64Array]", [Math.PI]],
    ]
    for (const [value, expectedTag, items] of cases) {
      const decoded = decodeDurableValue(throughJson(value))
      expect(tag(decoded)).toBe(expectedTag)
      expect(Array.from(decoded as ArrayLike<number>)).toEqual(items)
    }
    const big = decodeDurableValue(throughJson(BigInt64Array.from([BigInt("-5")]))) as BigInt64Array
    expect(tag(big)).toBe("[object BigInt64Array]")
    expect(big[0]).toBe(BigInt("-5"))
    const view = decodeDurableValue(throughJson(new DataView(Uint8Array.from([7, 8]).buffer)))
    expect(tag(view)).toBe("[object DataView]")
    expect((view as DataView).getUint8(1)).toBe(8)
    const buffer = decodeDurableValue(throughJson(Uint8Array.from([5]).buffer))
    expect(tag(buffer)).toBe("[object ArrayBuffer]")
  })

  it("encodes only the bytes a view covers", () => {
    const backing = Int16Array.from([1, 2, 3, 4])
    const decoded = decodeDurableValue(throughJson(backing.subarray(1, 3))) as Int16Array
    expect(Array.from(decoded)).toEqual([2, 3])
  })

  it("round-trips Date (including an invalid one), Map, Set and bigint", () => {
    const decoded = decodeDurableValue(
      throughJson({
        at: new Date(1_700_000_000_000),
        bad: new Date(Number.NaN),
        map: new Map<unknown, unknown>([["k", new Date(0)]]),
        set: new Set([1, "two"]),
        big: BigInt("12345678901234567890"),
      })
    ) as Record<string, unknown>
    expect(tag(decoded.at)).toBe("[object Date]")
    expect((decoded.at as Date).getTime()).toBe(1_700_000_000_000)
    expect(Number.isNaN((decoded.bad as Date).getTime())).toBe(true)
    expect(tag(decoded.map)).toBe("[object Map]")
    expect(((decoded.map as Map<string, Date>).get("k") as Date).getTime()).toBe(0)
    expect([...(decoded.set as Set<unknown>)]).toEqual([1, "two"])
    expect(decoded.big).toBe(BigInt("12345678901234567890"))
  })

  it("keeps the numbers JSON cannot spell: NaN, ±Infinity and -0", () => {
    const decoded = decodeDurableValue(
      throughJson({ a: Number.NaN, b: Infinity, c: -Infinity, d: -0, e: 0, f: 1.5 })
    ) as Record<string, number>
    expect(decoded.a).toBeNaN()
    expect(decoded.b).toBe(Infinity)
    expect(decoded.c).toBe(-Infinity)
    expect(Object.is(decoded.d, -0)).toBe(true)
    expect(Object.is(decoded.e, 0)).toBe(true)
    expect(decoded.f).toBe(1.5)
  })

  it("keeps undefined values and array holes", () => {
    const sparse = [1, , 3]
    const decoded = decodeDurableValue(
      throughJson({ gone: undefined, list: [undefined, 2], sparse })
    ) as Record<string, unknown[]>
    expect(Object.hasOwn(decoded, "gone")).toBe(true)
    expect(decoded.gone).toBeUndefined()
    expect(decoded.list).toHaveLength(2)
    expect(Object.hasOwn(decoded.list, 0)).toBe(true)
    expect(decoded.list[0]).toBeUndefined()
    expect(decoded.sparse).toHaveLength(3)
    expect(Object.hasOwn(decoded.sparse, 1)).toBe(false)
    expect(decoded.sparse[2]).toBe(3)
  })

  it("keeps a File's name and lastModified", async () => {
    const decoded = decodeDurableValue(
      throughJson(
        new File([Uint8Array.from([9])], "a.txt", { type: "text/plain", lastModified: 5 })
      )
    ) as File
    expect(tag(decoded)).toBe("[object File]")
    expect([decoded.name, decoded.lastModified, decoded.type]).toEqual(["a.txt", 5, "text/plain"])
    expect(Array.from(new Uint8Array(await decoded.arrayBuffer()))).toEqual([9])
  })

  it("keeps a Float16Array where the runtime has one", () => {
    const Float16 = (globalThis as { Float16Array?: new (items: number[]) => ArrayLike<number> })
      .Float16Array
    if (!Float16) return
    const decoded = decodeDurableValue(throughJson(new Float16([1.5, 2])))
    expect(tag(decoded)).toBe("[object Float16Array]")
    expect(Array.from(decoded as ArrayLike<number>)).toEqual([1.5, 2])
  })

  it("keeps RegExp, Error (with its cause) and boxed primitives", () => {
    const decoded = decodeDurableValue(
      throughJson({
        pattern: /ab+/gi,
        failure: new RangeError("boom", { cause: { code: 7 } }),
        custom: Object.assign(new Error("odd"), { name: "MyError" }),
        text: Object("x"),
        flag: Object(false),
        count: Object(-0),
        big: Object(BigInt(3)),
      })
    ) as Record<string, unknown>
    expect(tag(decoded.pattern)).toBe("[object RegExp]")
    expect(String(decoded.pattern)).toBe("/ab+/gi")
    const failure = decoded.failure as Error
    expect(tag(failure)).toBe("[object Error]")
    expect([failure.name, failure.message]).toEqual(["RangeError", "boom"])
    expect(failure.cause).toEqual({ code: 7 })
    expect(failure.stack).toMatch(/boom/)
    // structuredClone restores an unknown error name as Error; so does the codec.
    expect((decoded.custom as Error).name).toBe("Error")
    expect(tag(decoded.text)).toBe("[object String]")
    expect((decoded.text as string).valueOf()).toBe("x")
    expect((decoded.flag as boolean).valueOf()).toBe(false)
    expect(Object.is((decoded.count as number).valueOf(), -0)).toBe(true)
    expect((decoded.big as bigint).valueOf()).toBe(BigInt(3))
  })

  it("copies a class instance as its own properties, as structuredClone does", () => {
    class Point {
      constructor(
        public x: number,
        public y: number
      ) {}
      get [Symbol.toStringTag]() {
        return "Point"
      }
    }
    expect(decodeDurableValue(throughJson({ at: new Point(1, 2) }))).toEqual({
      at: { x: 1, y: 2 },
    })
  })

  it("refuses a built-in it does not know rather than writing {}", () => {
    expect(() => encodeDurableValue({ weak: new WeakMap() })).toThrow(/WeakMap value/)
    expect(() => encodeDurableValue({ shared: new SharedArrayBuffer(4) })).toThrow(
      /SharedArrayBuffer value/
    )
    expect(() => encodeDurableValue({ run: () => 1 })).toThrow(/a function/)
    // An Error subclass to `instanceof`, but structuredClone keeps it a DOMException.
    expect(() => encodeDurableValue({ abort: new DOMException("stop", "AbortError") })).toThrow(
      /DOMException value/
    )
  })

  it("refuses an envelope carrying a key its type never writes", () => {
    const envelope = (data: Record<string, unknown>) => ({
      $cogniaSnapshotValue: { version: 1, ...data },
    })
    for (const bad of [
      envelope({ type: "undefined", value: 5 }),
      envelope({ type: "hole", extra: 1 }),
      envelope({ type: "number", value: "NaN", sign: 1 }),
      envelope({ type: "blob", byteLength: 0, chunks: [], mediaType: "", name: "x" }),
      envelope({ type: "uint8array", byteLength: 0, chunks: [], mediaType: "x" }),
    ]) {
      expect(() => decodeDurableValue(bad)).toThrow(/unexpected/)
    }
  })

  it("keeps user objects that use the codec's property names as plain data", () => {
    const user = {
      $cogniaSnapshotValue: { version: 1, type: "blob", byteLength: 3, chunks: [] },
      __date: "2026-11-01T00:00:00.000Z",
    }
    expect(decodeDurableValue(throughJson(user))).toEqual(user)
    expect(decodeDurableValue(throughJson({ __date: "2026-11-01T00:00:00.000Z" }))).toEqual({
      __date: "2026-11-01T00:00:00.000Z",
    })
  })

  it("leaves plain JSON unchanged", () => {
    const plain = { a: [1, "x", null, { b: true }], c: {} }
    expect(encodeDurableValue(plain)).toEqual(plain)
    expect(decodeDurableValue(plain)).toEqual(plain)
  })

  it("refuses a cyclic value instead of writing a partial row", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => encodeDurableValue(cyclic)).toThrow(/cyclic/)
  })
})

describe("normalizeLegacyValue", () => {
  const address = (report: LegacyValueReport, key = "n:+1") => ({
    database: "CogniaDB",
    table: "petMediaPacks",
    key,
    report,
  })

  it("lifts codec-0 {__date} back to a Date", () => {
    const report = new LegacyValueReport()
    const lifted = normalizeLegacyValue(
      { at: { __date: "2026-11-01T00:00:00.000Z" }, keep: { __date: "not a date" } },
      address(report)
    )
    const decoded = decodeDurableValue(lifted) as Record<string, unknown>
    expect(tag(decoded.at)).toBe("[object Date]")
    expect((decoded.at as Date).toISOString()).toBe("2026-11-01T00:00:00.000Z")
    expect(decoded.keep).toEqual({ __date: "not a date" })
    expect(report.findings()).toEqual([])
  })

  it("escapes, and reports, codec-0 data that holds the envelope key", () => {
    const report = new LegacyValueReport()
    const user = { $cogniaSnapshotValue: { version: 1, type: "date", time: 0 } }
    expect(decodeDurableValue(normalizeLegacyValue({ at: user }, address(report)))).toEqual({
      at: user,
    })
    // User data, or codec-1 data an older build wrote back undecoded: either
    // way it stays as written, and verify names it.
    expect(report.findings()).toEqual([
      expect.objectContaining({ path: "at", shape: "envelope-key-object", count: 1 }),
    ])
    expect(formatLegacyValueFinding(report.findings()[0])).toMatch(/envelope key/)
  })

  it("reports, and keeps, the shapes codec 0 left where binary data was", () => {
    const report = new LegacyValueReport()
    const lossy = {
      blob: {},
      frames: [{ pixels: { "0": 1, "1": 2 } }, { pixels: { "0": 3 } }],
      notBytes: { "0": "a" },
      sparse: { "1": 4 },
    }
    expect(normalizeLegacyValue(lossy, address(report, "s:a"))).toEqual(lossy)
    normalizeLegacyValue({ blob: {} }, address(report, "s:b"))
    expect(report.findings()).toEqual([
      {
        database: "CogniaDB",
        table: "petMediaPacks",
        path: "blob",
        shape: "empty-object",
        count: 2,
        sampleKeys: ["s:a", "s:b"],
      },
      {
        database: "CogniaDB",
        table: "petMediaPacks",
        path: "frames[].pixels",
        shape: "index-keyed-object",
        count: 2,
        sampleKeys: ["s:a"],
      },
    ])
  })

  it("caps sample keys at three", () => {
    const report = new LegacyValueReport()
    for (const key of ["a", "b", "c", "d"]) normalizeLegacyValue({}, address(report, key))
    expect(report.findings()[0]).toMatchObject({ path: "", count: 4, sampleKeys: ["a", "b", "c"] })
  })
})

describe("the persisted report", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-value-report-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const finding = (count: number, sampleKeys: string[]) => ({
    database: "CogniaDB",
    table: "petMediaPacks",
    path: "blob",
    shape: "empty-object" as const,
    count,
    sampleKeys,
  })

  it("writes nothing when there is nothing to report", () => {
    expect(recordLegacyValueFindings(root, [])).toBeNull()
    expect(recordLegacyValueFindings(root, undefined)).toBeNull()
    expect(fs.existsSync(legacyValueReportPath(root))).toBe(false)
    expect(readLegacyValueReport(root)).toBeNull()
  })

  it("merges later sightings: highest count, unioned samples, first sighting kept", () => {
    recordLegacyValueFindings(root, [finding(3, ["a"])], () => 10)
    const report = recordLegacyValueFindings(root, [finding(2, ["b", "a"])], () => 20)
    expect(report).toEqual({
      reportFormat: 1,
      firstSeenAt: 10,
      updatedAt: 20,
      findings: [finding(3, ["a", "b"])],
    })
    expect(readLegacyValueReport(root)).toEqual(report)
    expect(fs.statSync(legacyValueReportPath(root)).mode & 0o777).toBe(0o600)
  })

  it("refuses a file that is not a report", () => {
    fs.writeFileSync(legacyValueReportPath(root), JSON.stringify({ findings: "x" }))
    expect(() => readLegacyValueReport(root)).toThrow(/not a value-loss report/)
  })

  it("formats a finding with what it means", () => {
    expect(formatLegacyValueFinding(finding(2, ["s:a"]))).toMatch(
      /^CogniaDB\.petMediaPacks\.blob: 2 row\(s\) read back as \{\}.*e\.g\. s:a$/
    )
    expect(
      formatLegacyValueFinding({ ...finding(1, ["k"]), path: "", shape: "index-keyed-object" })
    ).toMatch(/^CogniaDB\.petMediaPacks: 1 row\(s\) read back as an index-keyed object/)
  })
})
