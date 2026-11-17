import { isErrorLike, serializeError, toJsonSafe } from "./serialize-error"

describe("serializeError", () => {
  it("keeps name, message, stack and the cause chain", () => {
    const err = new Error("outer", { cause: new TypeError("inner") })
    const out = serializeError(err)
    expect(out.name).toBe("Error")
    expect(out.message).toBe("outer")
    expect(out.stack).toContain("outer")
    expect(out.cause).toMatchObject({ name: "TypeError", message: "inner" })
    expect(out.truncated).toBeUndefined()
    // Survives a JSON round trip, unlike the raw Error ("{}").
    expect(JSON.parse(JSON.stringify(out))).toMatchObject({ message: "outer" })
  })

  it("caps the stack and the cause depth and says so", () => {
    const deep = new Error("a", { cause: new Error("b", { cause: new Error("c") }) })
    deep.stack = "x".repeat(50)
    const out = serializeError(deep, { maxStackChars: 10, maxCauseDepth: 1 })
    expect(out.stack).toBe(`${"x".repeat(10)}…`)
    expect(out.truncated).toBe(true)
    expect(out.cause).toMatchObject({ message: "b", truncated: true })
    expect((out.cause as { cause?: unknown }).cause).toBeUndefined()
  })

  it("serializes a non-Error cause and a circular cause", () => {
    const withValue = new Error("v", { cause: { code: BigInt(42) } })
    expect(serializeError(withValue).cause).toEqual({ code: "42n" })
    const loop = new Error("loop")
    ;(loop as { cause?: unknown }).cause = loop
    expect(serializeError(loop).cause).toBe("[circular cause]")
  })
})

describe("toJsonSafe", () => {
  it("turns nested errors, bigints and cycles into explicit values", () => {
    const value: Record<string, unknown> = {
      n: BigInt(1),
      err: new RangeError("bad"),
      list: [1, "a"],
    }
    value.self = value
    const out = toJsonSafe(value) as Record<string, unknown>
    expect(out.n).toBe("1n")
    expect(out.err).toMatchObject({ name: "RangeError", message: "bad" })
    expect(out.list).toEqual([1, "a"])
    expect(out.self).toBe("[circular]")
  })

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { id: 1 }
    expect(toJsonSafe([shared, shared])).toEqual([{ id: 1 }, { id: 1 }])
  })

  it("bounds depth, entries and strings", () => {
    expect(toJsonSafe({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toEqual({
      a: "[depth limit: [object Object]]",
    })
    expect(toJsonSafe([1, 2, 3], { maxEntries: 2 })).toEqual([1, 2, "[1 more items]"])
    expect(toJsonSafe("abcdef", { maxStringChars: 3 })).toBe("abc…")
  })

  it("maps values JSON cannot hold", () => {
    expect(toJsonSafe(undefined)).toBe("[undefined]")
    expect(toJsonSafe(Number.NaN)).toBe("NaN")
    expect(toJsonSafe(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z")
    expect(toJsonSafe(new Map([["k", 1]]))).toEqual({ k: 1 })
    const getterThrows = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("nope")
      },
    })
    expect(toJsonSafe(getterThrows)).toEqual({ x: "[unreadable]" })
  })
})

describe("isErrorLike", () => {
  it("accepts errors and error-shaped clones only", () => {
    expect(isErrorLike(new Error("x"))).toBe(true)
    expect(isErrorLike({ name: "Error", message: "cloned" })).toBe(true)
    expect(isErrorLike({ message: "no name or stack" })).toBe(false)
    expect(isErrorLike("Error: text")).toBe(false)
  })
})
