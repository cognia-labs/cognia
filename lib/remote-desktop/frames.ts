/** Decoder for crates/cognia-remote-desktop/src/frames.rs, version 1.
 * The transport is a byte stream: RTC messages split a frame at 16 KiB.
 * Dimensions describe the input proof's original coordinate extent; the JPEG
 * can have fewer pixels after the Host's size-cap downscaling.
 */
import { RemoteDesktopError } from "./host-client"
import type { Point, UiAction } from "@/lib/automation/types"

/** Mirrors NativeInput in frames.rs. The lease/fence stays Host-owned. */
export type NativeUiAction = Extract<
  UiAction,
  { kind: "click" | "drag" | "scroll" | "pressKey" | "typeText" }
>
export interface NativeControlInput {
  point?: Point | null
  action: NativeUiAction
  frameId: string
}
export function encodeNativeInput(input: NativeControlInput): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.frameId))
    invalid()
  const json = new TextEncoder().encode(JSON.stringify(input))
  if (json.length === 0 || json.length > 32 * 1024) invalid()
  const bytes = new Uint8Array(4 + json.length)
  new DataView(bytes.buffer).setUint32(0, json.length)
  bytes.set(json, 4)
  return bytes
}

export const NATIVE_FRAME_HEADER_BYTES = 64
export const NATIVE_FRAME_MAX_BYTES = 1024 * 1024
export interface NativeFrameHeader {
  frameId: string
  fence: number
  width: number
  height: number
  capturedAtMs: number
  encoding: "jpeg" | "unchanged"
  payloadBytes: number
}
export interface NativeFrame extends NativeFrameHeader {
  jpeg: Uint8Array
}
function invalid(): never {
  throw new RemoteDesktopError("remote_desktop_frame_invalid")
}
function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
  return Number(value)
}
export function decodeNativeFrameHeader(bytes: Uint8Array): NativeFrameHeader {
  if (bytes.byteLength < NATIVE_FRAME_HEADER_BYTES) invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint32(0) !== 0x43474652 ||
    view.getUint8(4) !== 1 ||
    ![1, 2].includes(view.getUint8(5)) ||
    view.getUint16(6) !== NATIVE_FRAME_HEADER_BYTES ||
    view.getUint32(20) !== 0 ||
    view.getBigUint64(56) !== BigInt(0)
  )
    invalid()
  const payloadBytes = view.getUint32(8)
  const width = view.getUint32(12)
  const height = view.getUint32(16)
  const encoding = view.getUint8(5) === 1 ? "jpeg" : "unchanged"
  if (
    !width ||
    !height ||
    payloadBytes > NATIVE_FRAME_MAX_BYTES - NATIVE_FRAME_HEADER_BYTES ||
    (encoding === "jpeg" ? payloadBytes === 0 : payloadBytes !== 0)
  )
    invalid()
  const id = Array.from(bytes.subarray(40, 56), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
  return {
    frameId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    fence: safeInteger(view.getBigUint64(24)),
    capturedAtMs: safeInteger(view.getBigUint64(32)),
    width,
    height,
    payloadBytes,
    encoding,
  }
}
export function decodeNativeFrame(bytes: Uint8Array): NativeFrame {
  const header = decodeNativeFrameHeader(bytes)
  if (bytes.byteLength !== NATIVE_FRAME_HEADER_BYTES + header.payloadBytes) invalid()
  const jpeg = bytes.slice(NATIVE_FRAME_HEADER_BYTES)
  if (
    header.encoding === "jpeg" &&
    (jpeg.length < 4 ||
      jpeg[0] !== 0xff ||
      jpeg[1] !== 0xd8 ||
      jpeg.at(-2) !== 0xff ||
      jpeg.at(-1) !== 0xd9)
  )
    invalid()
  return { ...header, jpeg }
}
/** Bounded incremental parser, including split headers and coalesced frames. */
export class NativeFrameDecoder {
  private pending = new Uint8Array(0)
  push(chunk: Uint8Array): NativeFrame[] {
    if (chunk.byteLength > NATIVE_FRAME_MAX_BYTES) invalid()
    const bytes = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    bytes.set(this.pending)
    bytes.set(chunk, this.pending.byteLength)
    let offset = 0
    const frames: NativeFrame[] = []
    while (bytes.length - offset >= NATIVE_FRAME_HEADER_BYTES) {
      const remaining = bytes.subarray(offset)
      const header = decodeNativeFrameHeader(remaining)
      const size = NATIVE_FRAME_HEADER_BYTES + header.payloadBytes
      if (remaining.length < size) break
      frames.push(decodeNativeFrame(remaining.subarray(0, size)))
      offset += size
    }
    this.pending = bytes.slice(offset)
    if (this.pending.byteLength >= NATIVE_FRAME_MAX_BYTES) invalid()
    return frames
  }
  finish(): void {
    if (this.pending.byteLength) invalid()
  }
}
