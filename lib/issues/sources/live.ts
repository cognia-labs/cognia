/**
 * Live reads for issue sources.
 *
 * Every source's `list` reads local storage, so its `subscribe` is the same
 * read run under `Dexie.liveQuery`: Dexie records the tables and keys the read
 * touched and runs it again after a write commits to any of them. Dexie 4
 * keeps that record across awaits inside the read, including the dynamic
 * imports some sources use, so a source needs no list of tables of its own.
 *
 * A source that also reads memory Dexie cannot see (the Agent Team store)
 * passes a `trigger`: when it fires, the live read is restarted, which reads
 * everything again. Triggers that fire in a burst restart it once.
 *
 * A read that throws reaches `observer.error` and ends that live read; the
 * next trigger starts a fresh one, so a source with a trigger recovers on its
 * own once the store changes.
 *
 * `Dexie.liveQuery` delivers nothing where there is no IndexedDB at all, even
 * for a read that touches no table; every shell that renders a board has one.
 */

import Dexie from "dexie"
import type { IssueSourceObserver, UnifiedIssueItem } from "@/types/issues/unified"

/** Calls `notify` whenever the memory a read depends on changes; returns its disposer. */
export type IssueListTrigger = (notify: () => void) => () => void

export function observeIssueList(
  read: () => Promise<UnifiedIssueItem[]>,
  observer: IssueSourceObserver,
  triggers: readonly IssueListTrigger[] = []
): () => void {
  let closed = false
  let restartQueued = false
  let current: { unsubscribe(): void } | null = null

  const start = () => {
    current?.unsubscribe()
    current = Dexie.liveQuery(read).subscribe({
      next: (items) => {
        if (!closed) observer.next(items)
      },
      error: (error: unknown) => {
        if (!closed) observer.error(error)
      },
    })
  }

  const restart = () => {
    if (closed || restartQueued) return
    restartQueued = true
    queueMicrotask(() => {
      restartQueued = false
      if (!closed) start()
    })
  }

  start()
  const stops = triggers.map((trigger) => trigger(restart))

  return () => {
    if (closed) return
    closed = true
    current?.unsubscribe()
    current = null
    for (const stop of stops) stop()
  }
}
