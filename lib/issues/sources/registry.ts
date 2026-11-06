/**
 * IssueSourceRegistry
 *
 * Holds one `IssueSourceAdapter` per `IssueSourceKind`. Every source
 * (local, GitHub, collaboration, agent task, Agent Team) registers from
 * `bootIssueTracker` (`lib/issues/boot.ts`); a source registered late, or
 * replaced, reaches open boards through `onSourcesChanged`, so `subscribeAll`
 * never needs a reload to see it.
 *
 * Deliberately mirrors `lib/scheduler/sources/registry.ts` — that registry
 * already solved "six independent backends, one page" and the two should be
 * recognisably the same shape.
 *
 * Lifetime: singleton per process. Tests use `createIssueSourceRegistry()` for
 * a fresh instance, or `resetIssueSourceRegistry()` between cases.
 */

import type {
  IssueSourceAdapter,
  IssueSourceKind,
  IssueSourceQuery,
  UnifiedIssueItem,
} from "@/types/issues/unified"
import { compareUnifiedIssues } from "@/types/issues/unified"

/** What the board renders: every source's rows merged, and which sources failed. */
export interface IssueSourceSnapshot {
  items: UnifiedIssueItem[]
  errors: Array<{ kind: IssueSourceKind; error: unknown }>
}

export class IssueSourceRegistry {
  private readonly sources = new Map<IssueSourceKind, IssueSourceAdapter>()
  private readonly changeListeners = new Set<() => void>()

  register(source: IssueSourceAdapter): void {
    if (this.sources.get(source.kind) === source) return
    this.sources.set(source.kind, source)
    this.notifyChanged()
  }

  unregister(kind: IssueSourceKind): void {
    if (this.sources.delete(kind)) this.notifyChanged()
  }

  getSource(kind: IssueSourceKind): IssueSourceAdapter | undefined {
    return this.sources.get(kind)
  }

  /**
   * All registered sources in registration order. Callers must not rely on the
   * order for correctness — `subscribeAll` re-sorts via `compareUnifiedIssues`.
   */
  listAllSources(): ReadonlyArray<IssueSourceAdapter> {
    return Array.from(this.sources.values())
  }

  has(kind: IssueSourceKind): boolean {
    return this.sources.has(kind)
  }

  clear(): void {
    if (this.sources.size === 0) return
    this.sources.clear()
    this.notifyChanged()
  }

  /** Called after a source is registered, replaced or removed. */
  onSourcesChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private notifyChanged(): void {
    for (const listener of [...this.changeListeners]) listener()
  }

  /**
   * Subscribe every registered source and hand `onChange` the merged rows.
   *
   * The first snapshot arrives once every source has answered, so the board
   * never flashes a partial set; after that every change to any source
   * delivers a fresh snapshot. Sources registered later (the tracker's boot
   * registers them from an initializer, which can run after the board mounts)
   * are subscribed as they arrive, and a removed source's rows leave.
   *
   * A source that fails is left out rather than failing the whole board — a
   * broken GitHub token must not blank out the user's local issues. Failures
   * come back in `errors` so the toolbar can show a degraded-source badge
   * instead of silently under-reporting. A source that recovers rejoins on
   * its next delivery.
   */
  subscribeAll(
    query: IssueSourceQuery,
    onChange: (snapshot: IssueSourceSnapshot) => void
  ): () => void {
    type Result = { items: UnifiedIssueItem[] } | { error: unknown }
    interface Subscription {
      source: IssueSourceAdapter
      stop: () => void
      result?: Result
    }
    const subscriptions = new Map<IssueSourceKind, Subscription>()
    let closed = false
    // Held while `reconcile` subscribes, so a source that answers on subscribe
    // does not emit before the sources after it are even in the map.
    let reconciling = false

    const emit = () => {
      if (closed || reconciling) return
      const items: UnifiedIssueItem[] = []
      const errors: IssueSourceSnapshot["errors"] = []
      for (const [kind, subscription] of subscriptions) {
        const result = subscription.result
        if (!result) return
        if ("error" in result) errors.push({ kind, error: result.error })
        else items.push(...result.items)
      }
      onChange({ items: items.sort(compareUnifiedIssues), errors })
    }

    const reconcile = () => {
      if (closed) return
      reconciling = true
      let changed = false
      for (const [kind, subscription] of subscriptions) {
        if (this.sources.get(kind) === subscription.source) continue
        subscription.stop()
        subscriptions.delete(kind)
        changed = true
      }
      for (const [kind, source] of this.sources) {
        if (subscriptions.has(kind)) continue
        const subscription: Subscription = { source, stop: () => {} }
        subscriptions.set(kind, subscription)
        changed = true
        const deliver = (result: Result) => {
          if (subscriptions.get(kind) !== subscription) return
          subscription.result = result
          emit()
        }
        try {
          subscription.stop = source.subscribe(query, {
            next: (items) => deliver({ items }),
            error: (error) => deliver({ error }),
          })
        } catch (error) {
          deliver({ error })
        }
      }
      reconciling = false
      if (changed || subscriptions.size === 0) emit()
    }

    reconcile()
    const stopWatching = this.onSourcesChanged(reconcile)

    return () => {
      if (closed) return
      closed = true
      stopWatching()
      for (const subscription of subscriptions.values()) subscription.stop()
      subscriptions.clear()
    }
  }
}

export function createIssueSourceRegistry(): IssueSourceRegistry {
  return new IssueSourceRegistry()
}

let singletonRegistry: IssueSourceRegistry | null = null

/**
 * Process-wide registry. Created lazily on first access so test files that
 * import a source module before any adapter registers don't inherit leftover
 * state from a previous test.
 */
export function getIssueSourceRegistry(): IssueSourceRegistry {
  if (!singletonRegistry) {
    singletonRegistry = createIssueSourceRegistry()
  }
  return singletonRegistry
}

/** Test-only: reset the singleton between tests. */
export function resetIssueSourceRegistry(): void {
  singletonRegistry = null
}
