"use client"

/**
 * Feed WASM guest log lines from the desktop host into `log-buffer.ts`.
 *
 * Two channels, one buffer. The host pushes each line as a
 * `plugin-wasm://log` event, and keeps a bounded history the
 * `plugin_wasm_logs` command drains. The event is the live path. The drain
 * fills what the event path missed: a line that arrived ahead of one that
 * never did (`hasWasmLogGap`), and whatever the host recorded before anyone
 * here listened, read when the Dev Session subscribes.
 *
 * Desktop only, like the capability bridge beside it (`renderer-request-source.ts`).
 * `wasm-loader.ts` installs this before the first `plugin_wasm_load`, so a
 * guest's `init` cannot log before the listener exists. Browser and mobile
 * never run guests, and a headless host keeps its plugins' lines in its own
 * tracing pipeline.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { createSharedInstall, type SharedInstallOptions } from "@/lib/tauri/shared-install"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

import {
  getWasmLogCursor,
  hasWasmLogGap,
  ingestWasmLogDrain,
  ingestWasmLogRecord,
  parseWasmLogRecord,
  recordWasmLogDrainFailure,
  WASM_LOG_EVENT,
  WASM_LOGS_COMMAND,
  type WasmLogDrain,
} from "./log-buffer"

/** Tiny Tauri shape so the file type-checks (and tests run) in pure node. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke<T>(name: string, args: Record<string, unknown>): Promise<T>
}

export interface InstallWasmLogSourceOptions extends SharedInstallOptions {
  bridge?: TauriBridge
}

let activeBridge: TauriBridge | null = null
/** One drain in flight per plugin; a request during it runs once it ends. */
const draining = new Map<string, Promise<void>>()
const drainAgain = new Set<string>()

/**
 * Read what the host holds for one plugin past the buffer's cursor. A no-op
 * until the source is installed, which is to say until a WASM plugin loaded.
 */
export function drainWasmLogs(pluginId: string): Promise<void> {
  const bridge = activeBridge
  if (!bridge || !pluginId) return Promise.resolve()
  const running = draining.get(pluginId)
  if (running) {
    drainAgain.add(pluginId)
    return running
  }
  const run = (async () => {
    try {
      do {
        drainAgain.delete(pluginId)
        const cursor = getWasmLogCursor(pluginId)
        const drain = await bridge.invoke<WasmLogDrain>(WASM_LOGS_COMMAND, {
          pluginId,
          generation: cursor?.generation ?? null,
          afterSequence: cursor?.afterSequence ?? null,
        })
        ingestWasmLogDrain(pluginId, drain)
      } while (drainAgain.has(pluginId))
    } catch (error) {
      drainAgain.delete(pluginId)
      recordWasmLogDrainFailure(pluginId, error)
    } finally {
      draining.delete(pluginId)
    }
  })()
  draining.set(pluginId, run)
  return run
}

function handleEvent(payload: unknown): void {
  const record = parseWasmLogRecord(payload)
  if (!record) return
  ingestWasmLogRecord(record)
  if (hasWasmLogGap(record.pluginId)) void drainWasmLogs(record.pluginId)
}

/**
 * Listen for guest log lines. Shared by every caller and released by the last
 * one ({@link createSharedInstall}).
 */
export const installWasmLogSource = createSharedInstall<InstallWasmLogSourceOptions>(
  async (opts) => {
    let bridge: TauriBridge
    if (opts.bridge) {
      bridge = opts.bridge
    } else {
      try {
        bridge = { listen, invoke }
      } catch {
        return null
      }
    }
    const unlisten = await bridge.listen<unknown>(WASM_LOG_EVENT, (event) => {
      handleEvent(event.payload)
    })
    activeBridge = bridge
    return () => {
      if (activeBridge === bridge) activeBridge = null
      if (typeof unlisten === "function") safeUnlisten(unlisten)
    }
  }
)

/** Test-only: forget the installed bridge and any drain in flight. */
export function __resetWasmLogSourceForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetWasmLogSourceForTesting is test-only")
  }
  installWasmLogSource.reset()
  activeBridge = null
  draining.clear()
  drainAgain.clear()
}
