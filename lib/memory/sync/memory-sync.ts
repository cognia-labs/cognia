import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Memory } from "@/types/memory/memory"
import {
  createProfileDekStore,
  ProfileDekProtocolError,
  type ProfileDekHandle,
} from "@/lib/rag/profile-dek-store"

import { finalizeDelta } from "@/lib/sync/delta"
import { runSyncHandler } from "@/lib/sync/handlers/base"
import {
  createMemorySyncRowV1,
  MEMORY_SYNC_PROFILE_ID,
  openMemorySyncRowV1,
  type EncryptedMemorySyncRowV1,
} from "@/lib/sync/memory-content-protocol"
import type { SyncCursor, SyncDelta, SyncOutcome, SyncServeContext } from "@/lib/sync/types"

interface ProfileDekPairingResponseV1 {
  protocolVersion: 1
  profileId: string
  keyId: string
  rawKey: string
}

export const MOBILE_MEMORY_CACHE_LIMIT = 1_000

export async function pruneMobileMemoryCache(limit = MOBILE_MEMORY_CACHE_LIMIT): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Memory cache limit must be positive")
  const table = getDb().memories
  if ((await table.count()) <= limit) return 0
  const rows = await table.toArray()
  if (rows.length <= limit) return 0
  rows.sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.lastAccessedAt - left.lastAccessedAt ||
      right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id)
  )
  const deleteIds = rows.slice(limit).map((row) => row.id)
  await table.bulkDelete(deleteIds)
  return deleteIds.length
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

export async function ensurePairedMemoryDek(
  transport: Transport,
  profileId: string,
  keyId: string,
  store: Pick<
    ReturnType<typeof createProfileDekStore>,
    "load" | "importPaired"
  > = createProfileDekStore(),
  assertCurrent: () => void = () => {}
): Promise<CryptoKey> {
  assertCurrent()
  const existing = await store.load(profileId, keyId)
  assertCurrent()
  if (existing) return existing.key
  const response = await transport.call<ProfileDekPairingResponseV1>(
    "retrieval_profile_dek_export",
    { profileId, contentProtocolVersion: 1 }
  )
  if (
    response.protocolVersion !== 1 ||
    response.profileId !== profileId ||
    response.keyId !== keyId
  ) {
    throw new ProfileDekProtocolError()
  }
  assertCurrent()
  const rawKey = decodeBase64(response.rawKey)
  try {
    await store.importPaired(profileId, keyId, rawKey, {
      authenticated: true,
      protocolVersion: response.protocolVersion,
    })
  } finally {
    rawKey.fill(0)
  }
  const imported = await store.load(profileId, keyId)
  if (!imported) throw new ProfileDekProtocolError()
  return imported.key
}

/**
 * Pull long-term `memories` from the desktop so the mobile companion can show
 * recalled memories offline. Read-mostly mirror — memories are written by the
 * desktop consolidation path; the phone only displays them.
 */
export function syncMemories(
  transport: Transport,
  cursor: SyncCursor,
  deps: {
    loadDek: (profileId: string, keyId: string) => Promise<CryptoKey | null>
  } = {
    loadDek: (profileId, keyId) =>
      ensurePairedMemoryDek(transport, profileId, keyId, undefined, cursor.assertCurrent),
  }
): Promise<SyncOutcome> {
  return runSyncHandler<EncryptedMemorySyncRowV1>(
    {
      table: "memories",
      getTable: () => getDb().memories as never,
      applyRows: async (rows, assertCurrent) => {
        const memories: Memory[] = []
        for (const row of rows) {
          const key = await deps.loadDek(row.profileId, row.envelope.keyId)
          assertCurrent()
          if (!key) throw new ProfileDekProtocolError()
          memories.push(await openMemorySyncRowV1(row, key))
        }
        assertCurrent()
        await getDb().memories.bulkPut(memories)
        assertCurrent()
        await pruneMobileMemoryCache()
      },
    },
    transport,
    cursor
  )
}

// ── Host-side reader ─────────────────────────────────────────────────────────

/** How many memories a paired client's first pull carries, newest first. */
export const MEMORY_COLD_START_LIMIT = 500

/**
 * What the host's memory reader takes through `SyncServeContext.deps`; tests
 * inject the DEK and the cold-start limit, production passes neither.
 */
export interface MemorySyncServeDeps {
  getMemoryDek?: () => Promise<ProfileDekHandle>
  memoryColdStartLimit?: number
}

/**
 * The memories a paired client pulls, encrypted under the shared memory DEK
 * (retrieval content protocol v1, which the host checks before it gets here).
 * A first pull carries the newest `MEMORY_COLD_START_LIMIT`; later pulls carry
 * everything past the cursor.
 */
export async function readMemoriesDelta(
  since: number,
  context: SyncServeContext
): Promise<SyncDelta<unknown>> {
  const deps = context.deps as MemorySyncServeDeps
  const coldStartLimit = deps.memoryColdStartLimit ?? MEMORY_COLD_START_LIMIT
  if (!Number.isInteger(coldStartLimit) || coldStartLimit < 1) {
    throw new Error("Memory cold-start limit must be positive")
  }
  const rows =
    since === 0
      ? await getDb().memories.orderBy("updatedAt").reverse().limit(coldStartLimit).toArray()
      : await getDb().memories.where("updatedAt").above(since).toArray()
  if (rows.length === 0) return finalizeDelta("memories", [], since)
  const dek = await (
    deps.getMemoryDek ?? (() => createProfileDekStore().getOrCreate(MEMORY_SYNC_PROFILE_ID))
  )()
  const encryptedRows = await Promise.all(rows.map((row) => createMemorySyncRowV1(row, dek)))
  return finalizeDelta("memories", encryptedRows, since)
}
