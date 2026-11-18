/**
 * Asking whether a plugin data migration may run without a snapshot.
 *
 * Before a newer major version migrates a plugin's Dexie data, the rows are
 * copied so a rollback can restore them (ADR-0258). When the copy will not fit
 * in the browser's storage quota, the user decides: migrate without a
 * snapshot (that version's data then cannot be rolled back) or cancel the
 * upgrade. The migration waits on the answer; `PluginDataSnapshotSpaceHost`
 * renders the question wherever the user is, as the permission prompt does.
 *
 * A headless Host has nobody to ask. It migrates without a snapshot and the
 * skipped snapshot is recorded, so the plugin's page says the data of that
 * version cannot be restored.
 */
import { nanoid } from "nanoid"
import { isHeadlessHost } from "@/lib/platform/detect"

export type PluginDataSnapshotSpaceDecision = "continue-without-snapshot" | "cancel"

export interface PluginDataSnapshotSpaceRequest {
  id: string
  pluginId: string
  /** The data version being migrated from. */
  fromVersion: number
  /** The data version being migrated to. */
  toVersion: number
  /** Space the snapshot is estimated to need, in bytes. */
  requiredBytes: number
  /** Space left in the storage quota; `undefined` when the copy itself ran out. */
  availableBytes?: number
}

export interface PluginDataSnapshotSpaceState {
  current: PluginDataSnapshotSpaceRequest | null
  queue: PluginDataSnapshotSpaceRequest[]
}

type Listener = (state: PluginDataSnapshotSpaceState) => void

const listeners = new Set<Listener>()
const resolvers = new Map<string, (decision: PluginDataSnapshotSpaceDecision) => void>()
let state: PluginDataSnapshotSpaceState = { current: null, queue: [] }

function notify(): void {
  const snapshot = { current: state.current, queue: [...state.queue] }
  for (const listener of listeners) listener(snapshot)
}

export function requestPluginDataSnapshotSpaceDecision(
  input: Omit<PluginDataSnapshotSpaceRequest, "id">
): Promise<PluginDataSnapshotSpaceDecision> {
  if (isHeadlessHost()) return Promise.resolve("continue-without-snapshot")
  const request: PluginDataSnapshotSpaceRequest = { ...input, id: nanoid() }
  return new Promise((resolve) => {
    resolvers.set(request.id, resolve)
    state = state.current
      ? { ...state, queue: [...state.queue, request] }
      : { ...state, current: request }
    notify()
  })
}

export function resolvePluginDataSnapshotSpaceRequest(
  requestId: string,
  decision: PluginDataSnapshotSpaceDecision
): void {
  const resolve = resolvers.get(requestId)
  resolvers.delete(requestId)
  resolve?.(decision)
  if (state.current?.id === requestId) {
    const [next = null, ...rest] = state.queue
    state = { current: next, queue: rest }
  } else {
    state = { ...state, queue: state.queue.filter((request) => request.id !== requestId) }
  }
  notify()
}

export function subscribePluginDataSnapshotSpaceRequests(listener: Listener): () => void {
  listeners.add(listener)
  listener({ current: state.current, queue: [...state.queue] })
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper: cancel every open question. */
export function __resetPluginDataSnapshotSpaceRequestsForTests(): void {
  const pending = [...resolvers.values()]
  resolvers.clear()
  state = { current: null, queue: [] }
  for (const resolve of pending) resolve("cancel")
  notify()
}
