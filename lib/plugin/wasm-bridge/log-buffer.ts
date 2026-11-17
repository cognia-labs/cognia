/**
 * Per-plugin history of WASM guest log lines, for the plugin Dev Session's
 * Runtime logs card and the unified log panel.
 *
 * The host half is `crates/cognia-plugin-runtime/src/wasm/capabilities/logger.rs`:
 * every guest `log` call is bounded there, kept in a per-generation history and
 * pushed as a `plugin-wasm://log` event. `log-source.ts` feeds those events and
 * the `plugin_wasm_logs` drain into this buffer.
 *
 * # Two generations
 *
 * A record carries the WASM host's generation, an opaque token minted by each
 * `plugin_wasm_load`. The workbench filters by the plugin manager's lifecycle
 * generation (a counter), which is what an activation proof names. The manager
 * binds the two once a load returns (`bindWasmLogGeneration`), and an entry is
 * read under the lifecycle generation its host generation was bound to. A
 * record whose host generation was never bound keeps the host token, which no
 * lifecycle generation equals: it is shown only when the card shows every
 * generation, never under the wrong one.
 */

import { redactCredentialText } from "@/lib/security/redact-credentials"
import { serializeError, isErrorLike } from "@/lib/error/serialize-error"
import type {
  PluginLogLevel,
  PluginRuntimeLogEntry,
} from "@/lib/plugin/devtools/runtime-log-stream"

/** Event the host emits for each guest log line. */
export const WASM_LOG_EVENT = "plugin-wasm://log"
/** Command that drains one plugin's history (`plugin_wasm_logs`). */
export const WASM_LOGS_COMMAND = "plugin_wasm_logs"
/** Records kept per plugin, the host's own bound. The oldest go first. */
export const WASM_LOG_LIMIT = 500
/** `kind` of the entry that says the host's history could not be read. */
export const WASM_LOG_DRAIN_FAILURE_KIND = "wasm-drain-failed"
/** Host-to-lifecycle generation bindings remembered per plugin. */
const GENERATION_BINDINGS_KEPT = 8

export type WasmGuestLogLevel = "trace" | "debug" | "info" | "warn" | "error"

/** One `plugin-wasm://log` payload (`WasmLogRecord` on the host). */
export interface WasmLogRecord {
  pluginId: string
  generation: string
  /** 1-based, per host generation. */
  sequence: number
  level: WasmGuestLogLevel
  scope: string
  message: string
  timestampMs: number
}

/** What `plugin_wasm_logs` answers. */
export interface WasmLogDrain {
  generation: string | null
  entries: unknown[]
}

const GUEST_LEVELS: ReadonlySet<string> = new Set(["trace", "debug", "info", "warn", "error"])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Validate one wire record. Pure. Anything malformed is dropped, not guessed at. */
export function parseWasmLogRecord(value: unknown): WasmLogRecord | null {
  if (value === null || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (!isNonEmptyString(raw.pluginId) || !isNonEmptyString(raw.generation)) return null
  if (typeof raw.sequence !== "number" || !Number.isInteger(raw.sequence) || raw.sequence < 1) {
    return null
  }
  if (typeof raw.level !== "string" || !GUEST_LEVELS.has(raw.level)) return null
  if (typeof raw.message !== "string" || typeof raw.scope !== "string") return null
  if (typeof raw.timestampMs !== "number" || !Number.isFinite(raw.timestampMs)) return null
  return {
    pluginId: raw.pluginId,
    generation: raw.generation,
    sequence: raw.sequence,
    level: raw.level as WasmGuestLogLevel,
    scope: raw.scope,
    message: raw.message,
    timestampMs: raw.timestampMs,
  }
}

/** The stream has no `trace` level; trace lines read as debug. Pure. */
export function wasmLevelToPluginLevel(level: WasmGuestLogLevel): PluginLogLevel {
  return level === "trace" ? "debug" : level
}

interface StoredEntry {
  /** `null` for an entry about the channel itself (a failed drain). */
  hostGeneration: string | null
  sequence: number
  entry: PluginRuntimeLogEntry
}

const buffers = new Map<string, StoredEntry[]>()
/** pluginId → host generation → lifecycle generation. */
const bindings = new Map<string, Map<string, number>>()

/**
 * Where a plugin's stream stands: the newest host generation seen, the highest
 * sequence below which nothing is missing (held, cleared or evicted), and the
 * sequences above it that arrived early. A non-empty `ahead` is a gap a drain
 * can fill.
 */
interface Cursor {
  generation: string
  contiguous: number
  ahead: Set<number>
}

const cursors = new Map<string, Cursor>()
/** pluginId → host generations a newer load replaced, newest last. */
const retired = new Map<string, string[]>()
const listeners = new Set<(pluginId: string) => void>()
const entryListeners = new Set<(entry: PluginRuntimeLogEntry) => void>()
let failureSequence = 0

function notify(pluginId: string): void {
  for (const listener of listeners) {
    try {
      listener(pluginId)
    } catch {
      // A broken subscriber must never break ingestion.
    }
  }
}

function emitEntry(entry: PluginRuntimeLogEntry): void {
  for (const listener of entryListeners) {
    try {
      listener(entry)
    } catch {
      // Same as above.
    }
  }
}

function lifecycleGenerationOf(pluginId: string, hostGeneration: string): string {
  const bound = bindings.get(pluginId)?.get(hostGeneration)
  return bound === undefined ? hostGeneration : String(bound)
}

function withGeneration(stored: StoredEntry): PluginRuntimeLogEntry {
  if (stored.hostGeneration === null) return stored.entry
  const generation = lifecycleGenerationOf(stored.entry.pluginId, stored.hostGeneration)
  return generation === stored.entry.generation ? stored.entry : { ...stored.entry, generation }
}

function append(pluginId: string, stored: StoredEntry): void {
  const buffer = buffers.get(pluginId) ?? []
  buffer.push(stored)
  // Events and a drain can interleave; keep the list in time order, and
  // sequence order inside one generation.
  const last = buffer.length - 1
  if (
    last > 0 &&
    (buffer[last - 1].entry.timestamp > stored.entry.timestamp ||
      (buffer[last - 1].hostGeneration === stored.hostGeneration &&
        buffer[last - 1].sequence > stored.sequence))
  ) {
    buffer.sort(
      (a, b) =>
        a.entry.timestamp - b.entry.timestamp ||
        (a.hostGeneration === b.hostGeneration ? a.sequence - b.sequence : 0)
    )
  }
  if (buffer.length > WASM_LOG_LIMIT) buffer.splice(0, buffer.length - WASM_LOG_LIMIT)
  buffers.set(pluginId, buffer)
}

/**
 * Bind a WASM host generation to the plugin manager's lifecycle generation.
 * Called by the manager once `plugin_wasm_load` returned, before the guest's
 * `init` can log.
 */
export function bindWasmLogGeneration(
  pluginId: string,
  hostGeneration: string,
  lifecycleGeneration: number
): void {
  const map = bindings.get(pluginId) ?? new Map<string, number>()
  map.delete(hostGeneration)
  map.set(hostGeneration, lifecycleGeneration)
  while (map.size > GENERATION_BINDINGS_KEPT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  bindings.set(pluginId, map)
  if (buffers.get(pluginId)?.some((stored) => stored.hostGeneration === hostGeneration)) {
    notify(pluginId)
  }
}

function isRetired(pluginId: string, generation: string): boolean {
  return retired.get(pluginId)?.includes(generation) ?? false
}

/**
 * The cursor of `generation`, or `null` for a generation a newer load already
 * replaced (a late event from before a reload).
 */
function cursorFor(pluginId: string, generation: string): Cursor | null {
  const current = cursors.get(pluginId)
  if (current?.generation === generation) return current
  if (isRetired(pluginId, generation)) return null
  // The host records only the newest load, so an unseen generation is the
  // next one: start its stream from nothing.
  if (current) {
    const list = retired.get(pluginId) ?? []
    list.push(current.generation)
    if (list.length > GENERATION_BINDINGS_KEPT)
      list.splice(0, list.length - GENERATION_BINDINGS_KEPT)
    retired.set(pluginId, list)
  }
  const fresh: Cursor = { generation, contiguous: 0, ahead: new Set() }
  cursors.set(pluginId, fresh)
  return fresh
}

function advance(cursor: Cursor): void {
  while (cursor.ahead.has(cursor.contiguous + 1)) {
    cursor.contiguous += 1
    cursor.ahead.delete(cursor.contiguous)
  }
  if (cursor.ahead.size > WASM_LOG_LIMIT) {
    // A gap that large cannot be filled: the host keeps no more than this.
    cursor.contiguous = Math.max(...cursor.ahead)
    cursor.ahead.clear()
  }
}

/**
 * Keep one record. Redacts credential-shaped text first, and drops a record
 * already held, cleared or evicted (an event and a drain can both carry it).
 * Returns whether it was kept.
 */
export function ingestWasmLogRecord(record: WasmLogRecord): boolean {
  const { pluginId } = record
  const cursor = cursorFor(pluginId, record.generation)
  if (cursor) {
    if (record.sequence <= cursor.contiguous || cursor.ahead.has(record.sequence)) return false
    if (record.sequence === cursor.contiguous + 1) cursor.contiguous = record.sequence
    else cursor.ahead.add(record.sequence)
    advance(cursor)
  } else if (
    buffers
      .get(pluginId)
      ?.some((s) => s.hostGeneration === record.generation && s.sequence === record.sequence)
  ) {
    return false
  }

  const scope = redactCredentialText(record.scope)
  const entry: PluginRuntimeLogEntry = {
    id: `wasm-${pluginId}-${record.generation}-${record.sequence}`,
    pluginId,
    runtime: "wasm",
    generation: lifecycleGenerationOf(pluginId, record.generation),
    level: wasmLevelToPluginLevel(record.level),
    message: redactCredentialText(record.message),
    timestamp: record.timestampMs,
    // The guest's scope label renders where the python frame kind does.
    ...(scope ? { kind: scope } : {}),
  }
  append(pluginId, { hostGeneration: record.generation, sequence: record.sequence, entry })
  notify(pluginId)
  emitEntry(entry)
  return true
}

/**
 * Keep what a `plugin_wasm_logs` drain returned. The drain is the host's whole
 * history after the cursor, so anything below its last entry that it did not
 * return is gone (evicted by the host's bound) and is no longer a gap.
 */
export function ingestWasmLogDrain(pluginId: string, drain: WasmLogDrain): number {
  if (!drain || !isNonEmptyString(drain.generation)) return 0
  const cursor = cursorFor(pluginId, drain.generation)
  if (!cursor) return 0
  let kept = 0
  let last = 0
  for (const raw of Array.isArray(drain.entries) ? drain.entries : []) {
    const record = parseWasmLogRecord(raw)
    if (!record || record.pluginId !== pluginId || record.generation !== drain.generation) continue
    last = Math.max(last, record.sequence)
    if (ingestWasmLogRecord(record)) kept += 1
  }
  if (last > cursor.contiguous) {
    cursor.contiguous = last
    for (const sequence of cursor.ahead) if (sequence <= last) cursor.ahead.delete(sequence)
    advance(cursor)
  }
  return kept
}

/**
 * Where a drain should resume: the newest host generation seen and the
 * sequence below which nothing is missing. `null` before the first record.
 */
export function getWasmLogCursor(
  pluginId: string
): { generation: string; afterSequence: number } | null {
  const cursor = cursors.get(pluginId)
  return cursor ? { generation: cursor.generation, afterSequence: cursor.contiguous } : null
}

/** True when a line arrived ahead of one that never did. */
export function hasWasmLogGap(pluginId: string): boolean {
  return (cursors.get(pluginId)?.ahead.size ?? 0) > 0
}

/**
 * Record that the host's history could not be read. Shown in every
 * generation, since it is about the channel, not about one load.
 */
export function recordWasmLogDrainFailure(pluginId: string, error: unknown): void {
  const serialized = isErrorLike(error)
    ? serializeError(error)
    : { name: "Error", message: String(error) }
  const entry: PluginRuntimeLogEntry = {
    id: `wasm-${pluginId}-drain-${++failureSequence}`,
    pluginId,
    runtime: "wasm",
    generation: null,
    level: "error",
    message: redactCredentialText(serialized.message),
    timestamp: Date.now(),
    kind: WASM_LOG_DRAIN_FAILURE_KIND,
    ...("stack" in serialized && serialized.stack ? { stack: serialized.stack } : {}),
  }
  append(pluginId, { hostGeneration: null, sequence: 0, entry })
  notify(pluginId)
  emitEntry(entry)
}

/** Oldest first, each under the lifecycle generation it belongs to. */
export function getWasmLogs(pluginId: string): PluginRuntimeLogEntry[] {
  return (buffers.get(pluginId) ?? []).map(withGeneration)
}

/** Drop what is held. The cursor stays, so a later drain cannot bring it back. */
export function clearWasmLogs(pluginId: string): void {
  buffers.delete(pluginId)
  notify(pluginId)
}

export function subscribeWasmLogs(listener: (pluginId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Every newly kept entry, as it is kept (the unified-logger bridge). */
export function subscribeWasmLogEntries(
  listener: (entry: PluginRuntimeLogEntry) => void
): () => void {
  entryListeners.add(listener)
  return () => {
    entryListeners.delete(listener)
  }
}

/** Test-only: forget every buffer, binding, cursor and listener. */
export function __resetWasmLogBufferForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetWasmLogBufferForTesting is test-only")
  }
  buffers.clear()
  bindings.clear()
  cursors.clear()
  retired.clear()
  listeners.clear()
  entryListeners.clear()
  failureSequence = 0
}
