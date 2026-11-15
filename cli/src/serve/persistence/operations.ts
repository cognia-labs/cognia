/**
 * The read-only inspection behind `cognia-agent durability verify`.
 *
 * Verify never changes a byte of the account root: SQLite can create WAL/SHM
 * files even for a read-only connection, so it reads an exact disposable copy.
 * The Host backup runs it over every staged brain root before sealing an
 * archive (`crates/cognia-companion/src/backup.rs`).
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { readSqliteState, sqliteFile } from "./sqlite"
import { decodeDurableValue } from "./value-codec"
import {
  DURABILITY_BACKEND,
  DurabilityFault,
  type DurabilityBackendId,
  type DurabilityState,
} from "./types"

export interface DurabilityStatus {
  root: string
  backend: DurabilityBackendId
  sqlitePresent: boolean
  sqliteSequence: number | null
  faults: Array<{ code: string; message: string; sequence: number | null }>
}

function recordFault(status: DurabilityStatus, error: unknown): void {
  if (error instanceof DurabilityFault) {
    status.faults.push({ code: error.code, message: error.message, sequence: error.sequence })
    return
  }
  status.faults.push({
    code: "store-corrupt",
    message: error instanceof Error ? error.message : String(error),
    sequence: null,
  })
}

/**
 * Inspect an account's store: SQLite `integrity_check`, a full materialisation
 * and a decode of every value (including its binary side files).
 */
export async function verifyDurability(root: string): Promise<DurabilityStatus> {
  const status: DurabilityStatus = {
    root,
    backend: DURABILITY_BACKEND,
    sqlitePresent: fs.existsSync(sqliteFile(root)),
    sqliteSequence: null,
    faults: [],
  }
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new DurabilityFault("store-corrupt", `durability root is not a directory: ${root}`)
    }
    if (!status.sqlitePresent) {
      throw new DurabilityFault("store-corrupt", `no SQLite store at ${sqliteFile(root)}`)
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-verify-"))
    let state: DurabilityState
    try {
      const file = sqliteFile(temporary)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.copyFileSync(sqliteFile(root), file)
      for (const suffix of ["-wal", "-journal"]) {
        if (fs.existsSync(`${sqliteFile(root)}${suffix}`))
          fs.copyFileSync(`${sqliteFile(root)}${suffix}`, `${file}${suffix}`)
      }
      state = readSqliteState(temporary)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
    assertDecodable(root, state)
    status.sqliteSequence = state.sequence
  } catch (error) {
    recordFault(status, error)
  }
  return status
}

function assertDecodable(root: string, state: DurabilityState): void {
  for (const entry of Object.values(state.dbs)) {
    for (const rows of Object.values(entry.rows)) {
      for (const value of Object.values(rows)) decodeDurableValue(value, root)
    }
  }
}
