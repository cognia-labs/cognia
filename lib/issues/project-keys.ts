/**
 * The project keys that exist in one workspace, live (D24).
 *
 * Text that mentions `MERC-12` is a link only while a project keyed `MERC`
 * exists in the workspace on screen, so every surface that linkifies text
 * needs this set, and needs it to follow project creation and deletion. One
 * `Dexie.liveQuery` per workspace serves all of them: a chat with hundreds of
 * messages reads the projects once, not once per message.
 *
 * The read starts with the first subscriber and stops with the last; the last
 * snapshot is kept, so a surface that mounts again draws its links at once
 * while the read restarts.
 */

import Dexie from "dexie"
import { listIssueProjects } from "@/lib/db/issue-projects"

export interface IssueProjectKeysStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ReadonlySet<string>
}

export const NO_ISSUE_PROJECT_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>())

const EMPTY_STORE: IssueProjectKeysStore = {
  subscribe: () => () => {},
  getSnapshot: () => NO_ISSUE_PROJECT_KEYS,
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}

function createStore(projectId: string): IssueProjectKeysStore {
  const listeners = new Set<() => void>()
  let snapshot = NO_ISSUE_PROJECT_KEYS
  let subscription: { unsubscribe(): void } | undefined

  const start = () => {
    subscription = Dexie.liveQuery(async () =>
      (await listIssueProjects({ projectId })).map((project) => project.key)
    ).subscribe({
      next: (keys) => {
        const next = new Set(keys)
        if (sameKeys(next, snapshot)) return
        snapshot = next
        for (const listener of listeners) listener()
      },
      // A failed read keeps the last keys: links stay as they were drawn.
      error: () => {},
    })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!subscription) start()
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return
        subscription?.unsubscribe()
        subscription = undefined
      }
    },
    getSnapshot: () => snapshot,
  }
}

const stores = new Map<string, IssueProjectKeysStore>()

/** The shared store for one workspace; no workspace means no keys. */
export function issueProjectKeysStore(projectId: string | null | undefined): IssueProjectKeysStore {
  if (!projectId) return EMPTY_STORE
  let store = stores.get(projectId)
  if (!store) {
    store = createStore(projectId)
    stores.set(projectId, store)
  }
  return store
}

export function resetIssueProjectKeysStoresForTesting(): void {
  stores.clear()
}
