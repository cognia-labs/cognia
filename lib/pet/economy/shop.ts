// Purchase + consumption flows for the pet shop. Coin deductions and cosmetic
// applies are profile writes OUTSIDE the pet-controller event path, so they run
// through `enqueuePetWork` (serialized after in-flight event handling) AND a
// Dexie 'rw' transaction over petProfile+petInventory — otherwise an in-flight
// event's read-modify-write `upsertPetProfile` silently overwrites the
// deduction. Consumption itself is just an event emission: the controller owns
// all progression (needs restore via meta.itemId, XP, coins, achievements).
// Because the controller can still DROP that event (cooldown, egg), consumption
// asks it first via `checkInteractionAccepted`, so a refused use never costs
// the item.

import { getDb, withDbReopenRetry } from "@/lib/db/schema"
import { decrementPetInventory } from "@/lib/db/pet"
import { normalizeCoins, type PetShopItem } from "@/types/pet"
import { commitPetEvent, enqueuePetWork } from "@/lib/pet/runtime/pet-controller"
import { checkInteractionAccepted, type PetRefusal } from "@/lib/pet/access/gate"
import { getPetItem } from "./item-catalog"

export type PurchaseError = "no-profile" | "unknown-item" | "insufficient-coins"

export interface PurchaseResult {
  ok: boolean
  error?: PurchaseError
  /** Balance after a successful purchase. */
  coins?: number
}

export function canAfford(coins: number, item: PetShopItem, qty = 1): boolean {
  return normalizeCoins(coins) >= item.price * qty
}

/** Buy `qty` of an item: deduct coins, add inventory. Atomic + serialized. */
export async function purchaseItem(itemId: string, qty = 1): Promise<PurchaseResult> {
  const item = getPetItem(itemId)
  if (!item) return { ok: false, error: "unknown-item" }
  return enqueuePetWork(() =>
    withDbReopenRetry(() => {
      const db = getDb()
      return db.transaction("rw", db.petProfile, db.petInventory, () =>
        db.petProfile.get("global").then((profile) => {
          if (!profile) return { ok: false, error: "no-profile" as const }
          const balance = normalizeCoins(profile.coins)
          if (!canAfford(balance, item, qty)) {
            return { ok: false, error: "insufficient-coins" as const }
          }
          const coins = balance - item.price * qty
          const now = Date.now()
          return db.petInventory.get(itemId).then((inventory) => {
            const nextInventory = inventory
              ? { ...inventory, qty: inventory.qty + qty, updatedAt: now }
              : { id: itemId, qty, acquiredAt: now, updatedAt: now }
            return Promise.all([
              db.petProfile.put({
                ...profile,
                coins,
                updatedAt: new Date(now).toISOString(),
              }),
              db.petInventory.put(nextInventory),
            ]).then(() => ({ ok: true as const, coins }))
          })
        })
      )
    })
  )
}

export type ConsumeError =
  | "unknown-item"
  | "not-owned"
  /** The controller would drop the item's interaction right now. */
  | "cooling-down"
  /** The pet is still an egg; nurturing it would do nothing. */
  | "not-hatched"
  | "no-profile"

export interface ConsumeResult {
  ok: boolean
  error?: ConsumeError
  /** With `cooling-down`: how long until the interaction is accepted again. */
  retryAfterMs?: number
}

type ConsumeDeps = Parameters<typeof checkInteractionAccepted>[1]

function refusalToConsumeResult(refusal: PetRefusal): ConsumeResult {
  switch (refusal.code) {
    case "cooling-down":
      return { ok: false, error: "cooling-down", retryAfterMs: refusal.retryAfterMs }
    case "not-hatched":
      return { ok: false, error: "not-hatched" }
    default:
      return { ok: false, error: "no-profile" }
  }
}

/**
 * Use an owned item. Consumables decrement inventory and apply their
 * interaction effect + progression in ONE atomic controller transaction (F16,
 * F18), so concurrent uses of different items sharing a care cooldown or a
 * failed write can never lose an item. Decor merges its cosmetic override into
 * the profile without consuming.
 */
export async function consumeItem(itemId: string, deps: ConsumeDeps = {}): Promise<ConsumeResult> {
  const item = getPetItem(itemId)
  if (!item) return { ok: false, error: "unknown-item" }

  if (!item.consumable) {
    return enqueuePetWork(async () => {
      const db = getDb()
      return db.transaction("rw", db.petProfile, db.petInventory, async () => {
        const profile = await db.petProfile.get("global")
        if (!profile) return { ok: false, error: "no-profile" as const }
        if (!profile.soul) return { ok: false, error: "not-hatched" as const }
        const owned = await db.petInventory.get(itemId)
        if (!owned || owned.qty < 1) return { ok: false, error: "not-owned" as const }
        if (item.cosmetic) {
          await db.petProfile.put({
            ...profile,
            cosmetic: { ...profile.cosmetic, ...item.cosmetic },
            updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
          })
        }
        return { ok: true }
      })
    })
  }

  if (!item.interactionKind) {
    return enqueuePetWork(async (): Promise<ConsumeResult> => {
      const consumed = await decrementPetInventory(itemId)
      return consumed ? { ok: true } : { ok: false, error: "not-owned" }
    })
  }

  const now = (deps.now ?? Date.now)()
  // If a caller injected a custom `getProfile` (test double), honor its precheck first.
  if (deps.getProfile) {
    const refusal = await checkInteractionAccepted(item.interactionKind, deps)
    if (refusal) return refusalToConsumeResult(refusal)
  }

  const outcome = await commitPetEvent(
    {
      source: "user",
      kind: item.interactionKind,
      at: now,
      meta: { itemId },
    },
    {
      consumeItemId: itemId,
      emitOnBus: true,
      signalRefusal: false,
    }
  )

  if (outcome.ok) return { ok: true }
  switch (outcome.reason) {
    case "cooldown":
      return {
        ok: false,
        error: "cooling-down",
        retryAfterMs: outcome.readyAtMs !== undefined ? Math.max(0, outcome.readyAtMs - now) : 0,
      }
    case "not-hatched":
      return { ok: false, error: "not-hatched" }
    case "item-not-owned":
      return { ok: false, error: "not-owned" }
    case "uninitialized":
    case "scope-invalidated":
      return { ok: false, error: "no-profile" }
    case "storage-error":
      throw outcome.error instanceof Error
        ? outcome.error
        : new Error(String(outcome.error ?? "pet item consume failed"))
  }
}
