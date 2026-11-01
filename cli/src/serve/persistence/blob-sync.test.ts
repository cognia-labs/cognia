import { readBlobBytesSync, stopBlobReader } from "./blob-sync"

afterAll(async () => {
  await stopBlobReader()
})

describe("readBlobBytesSync", () => {
  it("returns a Blob's bytes without awaiting", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255])
    const read = readBlobBytesSync(new Blob([bytes, "ab"], { type: "application/octet-stream" }))
    expect(Array.from(read)).toEqual([0, 1, 2, 250, 255, 97, 98])
    expect(read.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it("returns an empty array for an empty Blob", () => {
    expect(readBlobBytesSync(new Blob([])).byteLength).toBe(0)
  })

  it("reads a Blob larger than one chunk", () => {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251)
    const read = readBlobBytesSync(new Blob([big]))
    expect(read.byteLength).toBe(big.byteLength)
    expect(read[123_457]).toBe(123_457 % 251)
  })

  it("reads again after the worker was stopped", async () => {
    await stopBlobReader()
    expect(Array.from(readBlobBytesSync(new Blob([Uint8Array.from([7])])))).toEqual([7])
  })

  it("fails loudly when the read cannot finish in time", () => {
    // Large enough that the worker cannot have copied it before the wait starts.
    const big = new Blob([new Uint8Array(64 * 1024 * 1024)])
    expect(() => readBlobBytesSync(big, 0)).toThrow(/timed out/)
  })
})
