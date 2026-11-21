// Dexie CRUD for the pet's rolling conversation history. Same small
// data-module pattern as `lib/db/pet.ts`. Only completed `talked` turns are
// stored, because proactive speech is skip-memory by design and never lands
// here.
//
// The primary key is a minted string rather than an auto-increment number.
// This table holds the user's own words and the pet's replies, so it is
// encrypted at rest, and the encryption middleware needs a primary key to
// exist before the row is written. An auto-increment key does not exist until
// Dexie has written it, so every append would have thrown.
//
// That is also why the store is named `petConversationV2`. Dexie refuses to
// open a database whose primary key changed, so the move had to drop the old
// `++id` store and create a new one beside it. Conversation history from
// before v220 is not carried over. The table only ever kept a 200-turn rolling
// window of chatter, and the alternative was a database that would not open.

import { getDb } from "./schema"
import { registerPendingAccountWriteFlusher } from "@/lib/accounts/pending-write-flush"
import {
  assertPetConversationScopeCurrent,
  bumpPetConversationGeneration,
  type PetScopeToken,
} from "@/lib/pet/runtime/pet-scope"
import type { PetConversationRow } from "@/types/pet"

/** Newest-N turns kept. Older rows are pruned on append. */
export const PET_CONVERSATION_CAP = 200

export interface AppendPetTurnOptions {
  /**
   * Account partition and conversation generation captured before async work
   * (model call, recall). Re-verified before and inside the Dexie transaction
   * so account switches, locks, clears, and resets cannot receive stale turns.
   */
  scope?: PetScopeToken
}

function newId(): string {
  return "pc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Append one finished talk turn, then prune to the newest `cap` rows. */
export async function appendPetTurn(
  turn: Omit<PetConversationRow, "id">,
  cap = PET_CONVERSATION_CAP,
  opts: AppendPetTurnOptions = {}
): Promise<string> {
  if (opts.scope) assertPetConversationScopeCurrent(opts.scope)
  const db = getDb()
  const row: PetConversationRow = { ...turn, id: newId() }
  const write = db.transaction("rw", db.petConversationV2, async () => {
    if (opts.scope) assertPetConversationScopeCurrent(opts.scope)
    await db.petConversationV2.add(row)
    const count = await db.petConversationV2.count()
    if (count > cap) {
      const overflow = count - cap
      const oldest = await db.petConversationV2.orderBy("at").limit(overflow).primaryKeys()
      if (oldest.length > 0) await db.petConversationV2.bulkDelete(oldest as string[])
    }
    return row.id
  })
  const unregister = registerPendingAccountWriteFlusher(async (signal) => {
    if (signal.aborted) return
    await write.catch(() => undefined)
  })
  try {
    return await write
  } finally {
    unregister()
  }
}

/** The newest `limit` turns in chronological order (newest LAST). */
export async function listRecentPetTurns(limit: number): Promise<PetConversationRow[]> {
  const rows = await getDb().petConversationV2.orderBy("at").reverse().limit(limit).toArray()
  return rows.reverse()
}

/** Wipe the pet's conversation memory (settings "clear" action). */
export async function clearPetConversation(): Promise<void> {
  const db = getDb()
  // Bump the generation BEFORE clearing so any in-flight reply that finishes
  // concurrently is fenced out before its transaction can commit.
  bumpPetConversationGeneration(db.name)
  await db.petConversationV2.clear()
}
