/**
 * Where an account's durability store lives, and how it is opened.
 *
 * The store is `sqlite-v5` (`./sqlite.ts`). A first boot seeds the empty
 * database from the freshly opened Dexie content; every later boot loads what
 * the database already holds.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { openSqliteBackend } from "./sqlite"
import type { DurabilityState, HeadlessDurabilityBackend } from "./types"

/** Per-account durability root: `<home>/durability/<accountId>`. */
export function durabilityRoot(home: string, accountId: string): string {
  return path.join(home, "durability", encodeURIComponent(accountId))
}

/** The persistence home used by both serve and its operator commands. */
export function resolveServeHome(
  env: Record<string, string | undefined>,
  override?: string,
  userHome = os.homedir()
): string {
  return override ?? path.join(env.COGNIA_DATA_DIR || path.join(userHome, ".cognia"), "serve")
}

export function ensureDurabilityRoot(root: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function isEmptyState(state: DurabilityState): boolean {
  return state.sequence === 0 && Object.keys(state.dbs).length === 0
}

export interface ResolvedBackend {
  backend: HeadlessDurabilityBackend
  /** The materialised state the caller should restore into Dexie. */
  state: DurabilityState
}

export interface ResolveBackendOptions {
  root: string
  /** Seed state for a first boot with an empty store (schema + rows). */
  seed?: DurabilityState
}

/**
 * Open the account's store, seeding it when it holds nothing yet.
 *
 * SQLite has no checkpoint to read a seed from, so an empty store is seeded by
 * compaction; without that its first commit would reference a database with
 * no schema row. A seeded store is never seeded twice, because seeding only
 * happens while the store is empty.
 */
export async function resolveBackend(opts: ResolveBackendOptions): Promise<ResolvedBackend> {
  const root = ensureDurabilityRoot(opts.root)
  const backend = openSqliteBackend({ root })
  try {
    let state = await backend.load()
    if (opts.seed && isEmptyState(state)) {
      await backend.compact({ ...opts.seed, sequence: 0 })
      state = await backend.load()
    }
    return { backend, state }
  } catch (error) {
    await backend.close()
    throw error
  }
}
