import fixture from "@/crates/cognia-remote-desktop/fixtures/frame-v1.json"
import {
  encodeNativeInput,
  decodeNativeFrame,
  decodeNativeFrameHeader,
  NativeFrameDecoder,
  NATIVE_FRAME_MAX_BYTES,
} from "./frames"

test("native input uses a bounded length-prefixed local control message", () => {
  const input = {
    frameId: "00112233-4455-6677-8899-aabbccddeeff",
    point: { x: 1, y: 2 },
    action: { kind: "click" as const, button: "left" as const, count: 2 },
  }
  const bytes = encodeNativeInput(input)
  expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length - 4)
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(4)))).toEqual(input)
  expect(() => encodeNativeInput({ ...input, frameId: "invalid" })).toThrow()
  expect(() =>
    encodeNativeInput({ ...input, action: { kind: "typeText", text: "x".repeat(33000) } })
  ).toThrow()
})

const vector = () => Uint8Array.from(Buffer.from(fixture.hex, "hex"))
describe("native frame decoder", () => {
  it("decodes the shared Rust header and JPEG vector", () => {
    const frame = decodeNativeFrame(vector())
    expect(frame).toMatchObject({
      frameId: fixture.frameId,
      fence: fixture.fence,
      width: fixture.width,
      height: fixture.height,
      capturedAtMs: fixture.capturedAtMs,
    })
    expect(frame.jpeg.slice(0, 2)).toEqual(new Uint8Array([255, 216]))
    expect(frame.payloadBytes + 64).toBe(vector().length)
  })
  it("decodes the shared header-only proof refresh", () => {
    const bytes = Uint8Array.from(Buffer.from(fixture.unchanged.hex, "hex"))
    const frame = decodeNativeFrame(bytes)
    expect(frame).toMatchObject({
      encoding: "unchanged",
      frameId: fixture.unchanged.frameId,
      capturedAtMs: fixture.unchanged.capturedAtMs,
      fence: fixture.fence,
      payloadBytes: 0,
    })
    expect(frame.jpeg).toHaveLength(0)
    const mixed = new NativeFrameDecoder().push(new Uint8Array([...vector(), ...bytes]))
    expect(mixed.map((frame) => frame.encoding)).toEqual(["jpeg", "unchanged"])
    bytes[5] = 1
    expect(() => decodeNativeFrame(bytes)).toThrow()
    const bad = vector()
    bad[5] = 2
    expect(() => decodeNativeFrame(bad)).toThrow()
  })
  it("reassembles split headers, 16 KiB chunks and coalesced frames", () => {
    const bytes = vector()
    const decoder = new NativeFrameDecoder()
    expect(decoder.push(bytes.slice(0, 17))).toEqual([])
    expect(decoder.push(bytes.slice(17))).toHaveLength(1)
    expect(decoder.push(new Uint8Array([...bytes, ...bytes]))).toHaveLength(2)
    decoder.finish()
    const chunked = new NativeFrameDecoder()
    const frames = []
    for (let offset = 0; offset < bytes.length; offset += 19)
      frames.push(...chunked.push(bytes.slice(offset, offset + 19)))
    expect(frames).toHaveLength(1)
  })
  it.each([0, 4, 5, 6, 20, 56])("refuses invalid header byte %i", (offset) => {
    const bytes = vector()
    bytes[offset]! ^= 1
    expect(() => decodeNativeFrame(bytes)).toThrow("remote_desktop_frame_invalid")
  })
  it("bounds payload size, integer precision and rejects truncated or non-JPEG frames", () => {
    const bytes = vector()
    new DataView(bytes.buffer).setUint32(8, NATIVE_FRAME_MAX_BYTES)
    expect(() => decodeNativeFrameHeader(bytes)).toThrow()
    const unsafe = vector()
    new DataView(unsafe.buffer).setBigUint64(24, BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))
    expect(() => decodeNativeFrameHeader(unsafe)).toThrow()
    expect(() => decodeNativeFrame(vector().slice(0, -1))).toThrow()
    const wrongJpeg = vector()
    wrongJpeg[64] = 0
    expect(() => decodeNativeFrame(wrongJpeg)).toThrow()
    const decoder = new NativeFrameDecoder()
    decoder.push(vector().slice(0, 30))
    expect(() => decoder.finish()).toThrow()
    expect(() => decoder.push(new Uint8Array(NATIVE_FRAME_MAX_BYTES + 1))).toThrow()
  })
})
