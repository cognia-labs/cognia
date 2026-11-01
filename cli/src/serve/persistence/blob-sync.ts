/**
 * Read a `Blob`'s bytes synchronously.
 *
 * The durability capture runs on the Dexie transaction's `complete` listener,
 * which cannot await (see `capture.ts`), and Node exposes a Blob's bytes only
 * through promises. A helper worker reads the Blob while this thread blocks on
 * `Atomics.wait` over a shared buffer the worker fills, so the commit record
 * still holds the bytes before the transaction resolves to its caller.
 *
 * Node allows `Atomics.wait` on the main thread. The worker is created on first
 * use and unref'd, so an idle brain does not keep it alive on its account.
 */
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads"

/** Waiting longer than this means the worker is gone; the commit must fail loudly. */
export const BLOB_READ_TIMEOUT_MS = 60_000

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads")
parentPort.on("message", async ({ blob, shared, reply }) => {
  const state = new Int32Array(shared, 0, 1)
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.byteLength !== shared.byteLength - 8) {
      throw new Error("blob size changed while it was read: expected " + (shared.byteLength - 8) + ", read " + bytes.byteLength)
    }
    new Uint8Array(shared, 8).set(bytes)
    Atomics.store(state, 0, 1)
  } catch (error) {
    reply.postMessage(String(error && error.message ? error.message : error))
    Atomics.store(state, 0, 2)
  } finally {
    reply.close()
    Atomics.notify(state, 0)
  }
})
`

let worker: Worker | null = null

function blobWorker(): Worker {
  if (worker) return worker
  const created = new Worker(WORKER_SOURCE, { eval: true })
  created.unref()
  created.on("error", () => {
    if (worker === created) worker = null
  })
  created.on("exit", () => {
    if (worker === created) worker = null
  })
  worker = created
  return created
}

/** The bytes of `blob`, read without returning to the event loop. */
export function readBlobBytesSync(blob: Blob, timeoutMs = BLOB_READ_TIMEOUT_MS): Uint8Array {
  if (blob.size === 0) return new Uint8Array(0)
  // Eight header bytes: an Int32 state word (0 pending, 1 done, 2 failed), padded.
  const shared = new SharedArrayBuffer(8 + blob.size)
  const state = new Int32Array(shared, 0, 1)
  const { port1, port2 } = new MessageChannel()
  try {
    blobWorker().postMessage({ blob, shared, reply: port2 }, [port2 as MessagePort])
    const outcome = Atomics.wait(state, 0, 0, timeoutMs)
    if (outcome === "timed-out") {
      throw new Error(`reading a ${blob.size}-byte Blob for the durability journal timed out`)
    }
    if (Atomics.load(state, 0) === 2) {
      const message = receiveMessageOnPort(port1)?.message
      throw new Error(`reading a Blob for the durability journal failed: ${String(message)}`)
    }
    // Copy out of the shared buffer: callers keep the bytes, not the SAB.
    return new Uint8Array(shared, 8).slice()
  } finally {
    port1.close()
  }
}

/** Stop the helper worker (tests, shutdown). Safe to call when none runs. */
export async function stopBlobReader(): Promise<void> {
  const running = worker
  worker = null
  await running?.terminate()
}
