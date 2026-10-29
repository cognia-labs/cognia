import type { UIMessage } from "ai"

import { shareUnchangedMessages, structurallyEqual } from "./share-unchanged-messages"

const msg = (id: string, text: string, extra: Record<string, unknown> = {}): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text }], ...extra }) as UIMessage

describe("shareUnchangedMessages", () => {
  it("returns the previous array itself when a re-read changed nothing", () => {
    const previous = [msg("a", "hi"), msg("b", "there")]
    const next = [msg("a", "hi"), msg("b", "there")]
    expect(shareUnchangedMessages(previous, next)).toBe(previous)
  })

  it("keeps unchanged messages' identity and takes changed ones from the read", () => {
    const previous = [msg("a", "hi"), msg("b", "there")]
    const next = [msg("a", "hi"), msg("b", "changed")]
    const shared = shareUnchangedMessages(previous, next)
    expect(shared).not.toBe(previous)
    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).toBe(next[1])
  })

  it("reuses a tail preview's objects when the full history arrives", () => {
    const tail = [msg("c", "3"), msg("d", "4")]
    const full = [msg("a", "1"), msg("b", "2"), msg("c", "3"), msg("d", "4")]
    const shared = shareUnchangedMessages(tail, full)
    expect(shared).toHaveLength(4)
    expect(shared[2]).toBe(tail[0])
    expect(shared[3]).toBe(tail[1])
    expect(shared[0]).toBe(full[0])
  })

  it("passes the read through when there is nothing to share with", () => {
    const next = [msg("a", "hi")]
    expect(shareUnchangedMessages(undefined, next)).toBe(next)
    expect(shareUnchangedMessages([], next)).toBe(next)
  })
})

describe("structurallyEqual", () => {
  it("compares nested objects and arrays by value", () => {
    expect(structurallyEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true)
    expect(structurallyEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false)
    expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(structurallyEqual([1], { 0: 1 })).toBe(false)
  })

  it("compares dates and typed arrays by content, not by having no keys", () => {
    expect(structurallyEqual(new Date(1), new Date(1))).toBe(true)
    expect(structurallyEqual(new Date(1), new Date(2))).toBe(false)
    expect(structurallyEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(structurallyEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(structurallyEqual(new Uint8Array([1]), new Int8Array([1]))).toBe(false)
  })

  it("treats NaN as equal to itself and null as distinct from objects", () => {
    expect(structurallyEqual(Number.NaN, Number.NaN)).toBe(true)
    expect(structurallyEqual(null, {})).toBe(false)
  })
})
