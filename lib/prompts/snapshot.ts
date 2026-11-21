/**
 * The in-memory view of published prompt overrides the resolver reads.
 *
 * Consumers resolve synchronously (a subagent definition is projected inside
 * a sync function; a title template is read once per call), so the resolver
 * never queries Dexie itself. One snapshot of every active binding is loaded
 * per account database and replaced whenever a mutation commits, here or in
 * another window (the initializer subscribes to a live query for that).
 *
 * A snapshot is tied to the database it was read from: after an account
 * switch `peekPromptOverrideSnapshot()` reports nothing until the new account's
 * overrides are loaded, a load in flight for the previous account is never
 * shared with a caller of the new one, and a load that finishes after a switch
 * is not handed out, so one account's text can never apply to another.
 */

import { getDb } from "@/lib/db/schema"
import { onPromptOverridesChanged, readActivePromptOverrides } from "@/lib/db/prompt-overrides"
import type { PromptDefinitionV1, PromptScope } from "./types"

export interface ActivePromptOverride {
  bindingId: string
  promptId: string
  scope: PromptScope
  targetId: string
  revisionId: string
  body: string
  contractVersion: number
}

export interface PromptOverrideSnapshot {
  /** Name of the account database the snapshot was read from. */
  databaseName: string
  byPrompt: ReadonlyMap<string, readonly ActivePromptOverride[]>
  loadedAt: number
}

let current: PromptOverrideSnapshot | null = null
/** The load in flight, and the database it reads. */
let inflight: { databaseName: string | null; promise: Promise<PromptOverrideSnapshot> } | null =
  null
/** Loads a caller retries before giving up while the account keeps switching under it. */
const MAX_LOAD_ATTEMPTS = 3
/** Bumped by every invalidation, so a load that started earlier cannot win. */
let generation = 0
const subscribers = new Set<() => void>()
let unsubscribeWrites: (() => void) | null = null
/** Test seam: the database name to treat as active when no Dexie exists. */
let testDatabaseName: string | null = null

function activeDatabaseName(): string | null {
  if (testDatabaseName !== null) return testDatabaseName
  try {
    return getDb().name
  } catch {
    return null
  }
}

/** Build a snapshot from bindings and their active revisions. Pure; exported for tests. */
export function buildPromptOverrideSnapshot(
  databaseName: string,
  rows: readonly ActivePromptOverride[],
  loadedAt = Date.now()
): PromptOverrideSnapshot {
  const byPrompt = new Map<string, ActivePromptOverride[]>()
  for (const row of rows) {
    const list = byPrompt.get(row.promptId) ?? []
    list.push(row)
    byPrompt.set(row.promptId, list)
  }
  return { databaseName, byPrompt, loadedAt }
}

async function readSnapshot(): Promise<PromptOverrideSnapshot> {
  const { databaseName, entries } = await readActivePromptOverrides()
  const rows: ActivePromptOverride[] = []
  entries.forEach(({ binding, revision }) => {
    // A pointer at a missing or non-published revision is skipped rather than
    // resolved to an empty body: an absent override means the shipped text.
    if (!revision || revision.kind !== "published") return
    rows.push({
      bindingId: binding.id,
      promptId: binding.promptId,
      scope: binding.scope,
      targetId: binding.targetId,
      revisionId: revision.id,
      body: revision.body,
      contractVersion: revision.contractVersion,
    })
  })
  return buildPromptOverrideSnapshot(databaseName, rows)
}

function ensureWriteSubscription(): void {
  if (unsubscribeWrites) return
  unsubscribeWrites = onPromptOverridesChanged(() => {
    invalidatePromptOverrideSnapshot()
    void loadPromptOverrideSnapshot().catch(() => undefined)
  })
}

/**
 * The current snapshot for the active account, or `null` when none is loaded
 * (first use, account switch, or a context without a database).
 */
export function peekPromptOverrideSnapshot(): PromptOverrideSnapshot | null {
  if (!current) return null
  return isActivePromptOverrideSnapshot(current) ? current : null
}

/** Whether `snapshot` was read from the account database active now. */
export function isActivePromptOverrideSnapshot(snapshot: PromptOverrideSnapshot): boolean {
  return snapshot.databaseName === activeDatabaseName()
}

/** The load for `databaseName`: one in flight for it, the loaded snapshot, or a new read. */
function loadFor(databaseName: string | null): Promise<PromptOverrideSnapshot> {
  if (inflight && inflight.databaseName === databaseName) return inflight.promise
  const fresh = peekPromptOverrideSnapshot()
  if (fresh) return Promise.resolve(fresh)
  const started = generation
  const promise: Promise<PromptOverrideSnapshot> = readSnapshot()
    .then((snapshot) => {
      // Installed only while it is still the newest read of the database
      // active now; a read that an invalidation or a switch overtook is not.
      if (started === generation && isActivePromptOverrideSnapshot(snapshot)) {
        current = snapshot
        for (const subscriber of subscribers) subscriber()
      }
      return snapshot
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
  inflight = { databaseName, promise }
  return promise
}

/** The active account changed under every attempt to load its snapshot. */
export class PromptOverrideSnapshotUnavailableError extends Error {
  readonly code = "prompt_snapshot_unavailable"
  constructor() {
    super("the account database changed while its prompt overrides were loading")
    this.name = "PromptOverrideSnapshotUnavailableError"
  }
}

/**
 * Load (or reuse an in-flight load of) the active account's snapshot. What it
 * resolves with was read from the database active when it resolves: a read
 * that an account switch overtook is retried for the new account, never
 * returned.
 */
export async function loadPromptOverrideSnapshot(): Promise<PromptOverrideSnapshot> {
  ensureWriteSubscription()
  for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
    const databaseName = activeDatabaseName()
    let snapshot: PromptOverrideSnapshot
    try {
      snapshot = await loadFor(databaseName)
    } catch (error) {
      // A switch closes the previous account's connection under its read:
      // that read was cancelled, not failed, and the new account still loads.
      if (activeDatabaseName() !== databaseName) continue
      throw error
    }
    if (isActivePromptOverrideSnapshot(snapshot)) return snapshot
  }
  throw new PromptOverrideSnapshotUnavailableError()
}

/** Drop the cached snapshot; the next load reads the database again. */
export function invalidatePromptOverrideSnapshot(): void {
  generation += 1
  current = null
  inflight = null
}

/** Called after a snapshot is replaced. Returns an unsubscribe function. */
export function subscribePromptOverrideSnapshot(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

/** Test seam: install a snapshot without a database (and treat its db as active). */
export function __setPromptOverrideSnapshotForTests(snapshot: PromptOverrideSnapshot | null): void {
  generation += 1
  current = snapshot
  inflight = null
  testDatabaseName = snapshot?.databaseName ?? null
}

let testRevision = 0

/**
 * Test seam: publish `body` as the account override of each definition, under
 * its current contract version, in place of any snapshot. A consumer test uses
 * it to show the user's text, not the shipped one, reaches the send boundary.
 * Each call mints fresh revision ids, so no cached verdict of an earlier body
 * applies. Clear with `__setPromptOverrideSnapshotForTests(null)`.
 */
export function __overridePromptsForTests(
  overrides: ReadonlyArray<readonly [def: PromptDefinitionV1, body: string]>
): void {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot(
      "prompt-overrides-test",
      overrides.map(([def, body]) => {
        testRevision += 1
        return {
          bindingId: `pob-test-${def.id}`,
          promptId: def.id,
          scope: "account",
          targetId: "",
          revisionId: `por-test-${testRevision}`,
          body,
          contractVersion: def.contractVersion,
        }
      })
    )
  )
}
