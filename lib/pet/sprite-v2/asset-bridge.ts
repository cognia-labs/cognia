// Secondary pet windows (overlay / popup) have no unlocked account database.
// Project only the currently selected v2 sprite pack over a local, in-memory
// BroadcastChannel; never share account keys or writable database handles (F28).

import { getPetSpritePack, type PetSpritePackRow } from "@/lib/db/pet-sprite-packs"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { getWindowRole } from "@/lib/platform/window-role"
import { isValidSpritePackId, MAX_SPRITE_V2_ATLAS_BYTES } from "./import"

const CHANNEL = "cognia:pet:sprite-assets:v1"

/** Metadata projection of an installed sprite pack (without the atlas Blob). */
export type SpritePackMeta = Omit<PetSpritePackRow, "spritesheet">

export interface SpriteAssetChannel {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(value: unknown): void
  close(): void
}

function openChannel(): SpriteAssetChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined
  const wire = new BroadcastChannel(CHANNEL)
  const adapter: SpriteAssetChannel = {
    onmessage: null,
    postMessage: (value) => wire.postMessage(value),
    close: () => wire.close(),
  }
  wire.onmessage = (event) => adapter.onmessage?.({ data: event.data })
  return adapter
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

export function toSpritePackMeta(row: PetSpritePackRow): SpritePackMeta {
  return {
    id: row.id,
    displayName: row.displayName,
    description: row.description,
    spriteVersionNumber: row.spriteVersionNumber,
    totalBytes: row.totalBytes,
    createdAt: row.createdAt,
  }
}

function decodeMeta(value: unknown): SpritePackMeta | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.id !== "string" ||
    !isValidSpritePackId(value.id) ||
    typeof value.displayName !== "string" ||
    value.displayName.length > 200 ||
    typeof value.description !== "string" ||
    value.description.length > 1000 ||
    value.spriteVersionNumber !== 2 ||
    typeof value.totalBytes !== "number" ||
    !Number.isFinite(value.totalBytes) ||
    value.totalBytes < 0 ||
    value.totalBytes > MAX_SPRITE_V2_ATLAS_BYTES ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0
  ) {
    return undefined
  }
  return {
    id: value.id,
    displayName: value.displayName,
    description: value.description,
    spriteVersionNumber: 2,
    totalBytes: value.totalBytes,
    createdAt: value.createdAt,
  }
}

function decodeRow(value: unknown): PetSpritePackRow | undefined {
  if (!isRecord(value)) return undefined
  const meta = decodeMeta(value)
  if (!meta) return undefined
  if (!(value.spritesheet instanceof Blob) || value.spritesheet.size > MAX_SPRITE_V2_ATLAS_BYTES) {
    return undefined
  }
  return {
    ...meta,
    spritesheet: value.spritesheet,
  }
}

export function isSpriteAssetMirror(): boolean {
  const role = getWindowRole()
  return role === "overlay" || role === "popup"
}

export interface MainSpriteAssetsDeps {
  channel?: SpriteAssetChannel
  selectedPack: () => string | undefined
  readPack?: (id: string) => Promise<PetSpritePackRow | undefined>
  watchRow: (id: string, next: (row: PetSpritePackRow | undefined) => void) => () => void
}

/** Main alone reads account storage. Only the active pack is projected in memory. */
export function startMainSpriteAssets(deps: MainSpriteAssetsDeps) {
  const wire = deps.channel ?? openChannel()
  const readPack = deps.readPack ?? getPetSpritePack
  let disposed = false
  let packId: string | undefined
  let session = ""
  let meta: SpritePackMeta | undefined
  let unwatch: (() => void) | undefined
  const seenRequests = new Set<string>()

  const post = (message: Record<string, unknown>) => wire?.postMessage({ v: 1, ...message })

  const revoke = () => {
    seenRequests.clear()
    unwatch?.()
    unwatch = undefined
    if (packId) {
      getPetSkinRuntime().invalidateAsset(`sprite-v2:${packId}`)
      post({ t: "revoke", session, packId })
    }
    packId = undefined
    meta = undefined
  }

  const sync = () => {
    if (disposed || !wire) return
    const next = deps.selectedPack()
    if (next === packId) return
    revoke()
    packId = next
    if (next) {
      session = crypto.randomUUID()
      const current = session
      unwatch = deps.watchRow(next, (value) => {
        if (disposed || current !== session || deps.selectedPack() !== next) return
        meta = value ? decodeMeta(toSpritePackMeta(value)) : undefined
        if (!meta) getPetSkinRuntime().invalidateAsset(`sprite-v2:${next}`)
        post({ t: "metadata", session, packId: next, meta: meta ?? null })
      })
    }
    post({ t: "ready", session, packId })
  }

  if (wire) {
    wire.onmessage = (event) => {
      const msg = event.data
      if (!isRecord(msg) || msg.v !== 1 || disposed) return
      if (msg.t === "hello") {
        sync()
        if (packId && meta) post({ t: "metadata", session, packId, meta })
        return
      }
      if (
        msg.t !== "request" ||
        typeof msg.requestId !== "string" ||
        !msg.requestId ||
        msg.requestId.length > 128 ||
        typeof msg.packId !== "string"
      ) {
        return
      }
      sync()
      if (!packId || msg.packId !== packId || deps.selectedPack() !== packId) return
      if (seenRequests.has(msg.requestId)) return
      seenRequests.add(msg.requestId)
      if (seenRequests.size > 128) seenRequests.delete(seenRequests.values().next().value!)
      const id = packId
      const current = session
      void readPack(id)
        .then((row) => {
          if (disposed || session !== current || deps.selectedPack() !== id) return
          const valid = decodeRow(row)
          post({
            t: "asset",
            session,
            packId: id,
            requestId: msg.requestId,
            row: valid && valid.id === id ? valid : null,
          })
        })
        .catch(() => {
          if (!disposed && session === current && deps.selectedPack() === id) {
            post({ t: "asset", session, packId: id, requestId: msg.requestId, row: null })
          }
        })
    }
  }

  sync()
  post({ t: "ready", session, packId })

  return {
    sync,
    dispose() {
      if (disposed) return
      disposed = true
      revoke()
      if (wire) {
        wire.onmessage = null
        wire.close()
      }
    },
  }
}

export class SpriteAssetMirror {
  readonly metas = new Map<string, SpritePackMeta>()
  private sessions = new Map<string, string>()
  private revoked = new Set<string>()
  private retryIds = new Set<string>()
  private listeners = new Set<() => void>()
  private pending = new Map<
    string,
    { id: string; finish: (row: PetSpritePackRow | undefined) => void }
  >()
  private disposed = false

  constructor(
    private readonly wire: SpriteAssetChannel | undefined = openChannel(),
    private readonly timeoutMs = 15_000
  ) {
    if (wire) {
      wire.onmessage = (event) => this.receive(event.data)
      wire.postMessage({ v: 1, t: "hello" })
    }
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request(id: string): Promise<PetSpritePackRow | undefined> {
    if (!this.wire || this.disposed) return Promise.resolve(undefined)
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const finish = (row: PetSpritePackRow | undefined) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (!row) this.retryIds.add(id)
        else this.retryIds.delete(id)
        resolve(row)
      }
      const timer = setTimeout(() => finish(undefined), this.timeoutMs)
      this.pending.set(requestId, { id, finish })
      this.wire!.postMessage({ v: 1, t: "request", requestId, packId: id })
    })
  }

  private receive(value: unknown) {
    if (this.disposed || !isRecord(value) || value.v !== 1) return
    if (value.t === "ready") {
      this.wire?.postMessage({ v: 1, t: "hello" })
      for (const [requestId, pending] of this.pending) {
        this.wire?.postMessage({ v: 1, t: "request", requestId, packId: pending.id })
      }
      if (typeof value.packId === "string" && this.retryIds.delete(value.packId)) {
        getPetSkinRuntime().retryAsset(`sprite-v2:${value.packId}`)
      }
      return
    }
    if (typeof value.session !== "string" || !value.session || typeof value.packId !== "string") {
      return
    }
    const id = value.packId
    const session = value.session

    if (value.t === "revoke") {
      this.revoked.add(session)
      if (this.revoked.size > 64) this.revoked.delete(this.revoked.values().next().value!)
      if (!this.sessions.has(id) || this.sessions.get(id) === session) {
        this.metas.delete(id)
        this.sessions.delete(id)
        this.retryIds.add(id)
        getPetSkinRuntime().invalidateAsset(`sprite-v2:${id}`)
        for (const pending of [...this.pending.values()]) {
          if (pending.id === id) pending.finish(undefined)
        }
        this.emit()
      }
      return
    }
    if (this.revoked.has(session)) return

    if (value.t === "metadata") {
      const meta = decodeMeta(value.meta)
      if (meta?.id !== id && value.meta !== null) return
      const previousSession = this.sessions.get(id)
      const changedSession = previousSession !== undefined && previousSession !== session
      if (changedSession) {
        this.revoked.add(previousSession)
        if (this.revoked.size > 64) this.revoked.delete(this.revoked.values().next().value!)
        for (const pending of [...this.pending.values()]) {
          if (pending.id === id) pending.finish(undefined)
        }
      }
      this.sessions.set(id, session)
      if (meta?.id !== id) {
        if (value.meta === null) {
          this.metas.delete(id)
          this.retryIds.add(id)
          if (changedSession) getPetSkinRuntime().retryAsset(`sprite-v2:${id}`)
          else getPetSkinRuntime().invalidateAsset(`sprite-v2:${id}`)
          this.emit()
        }
        return
      }
      this.metas.set(id, meta)
      const retry = this.retryIds.delete(id)
      if (changedSession || retry || getPetSkinRuntime().assetDiagnostic(`sprite-v2:${id}`)) {
        getPetSkinRuntime().retryAsset(`sprite-v2:${id}`)
      }
      this.emit()
      return
    }

    if (value.t !== "asset" || typeof value.requestId !== "string") return
    const pending = this.pending.get(value.requestId)
    if (!pending || pending.id !== id) return
    const previousSession = this.sessions.get(id)
    if (previousSession !== undefined && previousSession !== session) {
      pending.finish(undefined)
      return
    }
    this.sessions.set(id, session)
    const row = decodeRow(value.row)
    if (!row || row.id !== id) {
      pending.finish(undefined)
      return
    }
    this.metas.set(id, toSpritePackMeta(row))
    this.emit()
    pending.finish(row)
  }

  dispose() {
    this.disposed = true
    for (const pending of [...this.pending.values()]) pending.finish(undefined)
    for (const id of this.metas.keys()) getPetSkinRuntime().invalidateAsset(`sprite-v2:${id}`)
    this.metas.clear()
    this.listeners.clear()
    this.sessions.clear()
    this.retryIds.clear()
    this.revoked.clear()
    if (this.wire) {
      this.wire.onmessage = null
      this.wire.close()
    }
  }
}

let mirror: SpriteAssetMirror | undefined
let subscribers = 0

export function subscribeSpriteMirror(listener: () => void): () => void {
  if (!isSpriteAssetMirror()) return () => {}
  mirror ??= new SpriteAssetMirror()
  subscribers += 1
  const current = mirror
  const unsubscribe = current.subscribe(listener)
  return () => {
    unsubscribe()
    subscribers -= 1
    queueMicrotask(() => {
      if (subscribers === 0 && mirror === current) {
        current.dispose()
        mirror = undefined
      }
    })
  }
}

export function getMirroredSpriteMeta(id: string): SpritePackMeta | undefined {
  return mirror?.metas.get(id)
}

export function requestMirroredSpriteAsset(id: string): Promise<PetSpritePackRow | undefined> {
  mirror ??= new SpriteAssetMirror()
  return mirror.request(id)
}

export function __resetSpriteMirrorForTesting(): void {
  mirror?.dispose()
  mirror = undefined
  subscribers = 0
}
