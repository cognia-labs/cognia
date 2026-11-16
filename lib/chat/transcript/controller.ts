import type {
  SessionTimelinePage,
  SessionTurnMessagesPage,
  TranscriptTimelineItem,
} from "@cognia/agent-config-types"

import { TranscriptDetailCache } from "./detail-cache"
import type { TranscriptSource } from "./source"

export type { SessionTimelinePage, SessionTurnMessagesPage, TranscriptSource }

export interface TranscriptTurnDetail extends SessionTurnMessagesPage {
  /** Local window navigation; not part of the host protocol. */
  hasPrevious?: boolean
}

interface DetailWindow {
  index: number
  starts: Array<string | undefined>
}

export const TRANSCRIPT_DETAIL_WINDOW_MESSAGES = 200

export interface TranscriptControllerSnapshot {
  mode: "unknown" | "timeline"
  items: TranscriptTimelineItem[]
  revision: number | null
  loading: boolean
  loadingOlder: boolean
  hasMore: boolean
  expandedTurnKeys: ReadonlySet<string>
  loadingTurnKeys: ReadonlySet<string>
  error: unknown | null
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : undefined
}

function staleTranscript(): Error {
  return Object.assign(new Error("transcript revision changed while reading history"), {
    code: "TRANSCRIPT_STALE",
  })
}

function turnKeyOf(item: TranscriptTimelineItem): string | undefined {
  return item.kind === "system" ? undefined : item.turnKey
}

/**
 * Splice a freshly read newest page onto the history already loaded, when
 * that is provably the same as re-reading the whole window: the page reaches
 * back into what is loaded (its oldest item is one we hold), and every turn
 * the notice named is either in the page or not loaded at all. Returns
 * `undefined` otherwise, and the caller re-reads the window.
 */
function spliceNewestPage(
  loaded: TranscriptTimelineItem[],
  page: SessionTimelinePage,
  named: ReadonlySet<string>
): TranscriptTimelineItem[] | undefined {
  if (!page.hasMore) return page.items
  const oldestNew = page.items[0]
  if (!oldestNew) return undefined
  const overlap = loaded.findIndex((item) => item.itemKey === oldestNew.itemKey)
  if (overlap < 0) return undefined
  const inPage = new Set(page.items.flatMap((item) => turnKeyOf(item) ?? []))
  for (const key of named) {
    if (!inPage.has(key) && loaded.some((item) => turnKeyOf(item) === key)) return undefined
  }
  return prependPage(loaded.slice(0, overlap), page.items)
}

/** Pages are already in host order; timestamps alone cannot order tied rows. */
function prependPage(older: TranscriptTimelineItem[], newer: TranscriptTimelineItem[]) {
  const seen = new Set(newer.map((item) => item.itemKey))
  return [
    ...older.filter((item) => {
      if (seen.has(item.itemKey)) return false
      seen.add(item.itemKey)
      return true
    }),
    ...newer,
  ]
}

export class TranscriptController {
  private readonly listeners = new Set<() => void>()
  private readonly detailCache: TranscriptDetailCache<TranscriptTurnDetail>
  private readonly detailWindows = new Map<string, DetailWindow>()
  private nextCursor: string | undefined
  private unsubscribeRevision: (() => void) | undefined
  private started = false
  private generation = 0
  private readEpoch = 0
  private requestedRevision = 0
  /**
   * What the notices since the last refresh started said changed: the turns
   * they named, or `full` once any of them could not name its turns (or a
   * caller asked for a whole reload).
   */
  private pendingTurnKeys = new Set<string>()
  private pendingFull = true
  private refreshPromise: Promise<void> | undefined
  private readonly detailRequests = new Map<string, Promise<void>>()
  private readonly detailReadVersions = new Map<string, number>()
  private nextDetailReadVersion = 0
  private snapshot: TranscriptControllerSnapshot = {
    mode: "unknown",
    items: [],
    revision: null,
    loading: false,
    loadingOlder: false,
    hasMore: false,
    expandedTurnKeys: new Set(),
    loadingTurnKeys: new Set(),
    error: null,
  }

  constructor(
    private readonly sessionId: string,
    private readonly source: TranscriptSource,
    cacheBudget?: { softBytes?: number; hardBytes?: number }
  ) {
    this.detailCache = new TranscriptDetailCache(cacheBudget)
  }

  /**
   * Wire the revision subscription. Kept out of the constructor because the
   * hook builds the controller during render: the remote source opens the
   * companion WebSocket here, and that flips the transport's connection state,
   * which wakes every other connectivity subscriber inside our render pass.
   * Idempotent, so a re-run of the owning effect is free.
   */
  start = (): void => {
    if (this.started) return
    this.started = true
    this.unsubscribeRevision = this.source.subscribeRevision?.(
      this.sessionId,
      (revision, turnKeys) => {
        if (!Number.isSafeInteger(revision) || revision < 0) return
        if (this.snapshot.revision !== null && revision <= this.snapshot.revision) return
        if (turnKeys) for (const key of turnKeys) this.pendingTurnKeys.add(key)
        else this.pendingFull = true
        this.requestedRevision = Math.max(this.requestedRevision, revision)
        void this.scheduleRefresh()
      }
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TranscriptControllerSnapshot => this.snapshot

  getDetail(turnKey: string): TranscriptTurnDetail | undefined {
    return this.detailCache.get(this.cacheKey(turnKey))
  }

  /** Re-read the whole visible window (first load, retry, recovery). */
  loadInitial(): Promise<void> {
    this.pendingFull = true
    return this.scheduleRefresh()
  }

  /**
   * One refresh at a time; notices that arrive meanwhile are folded into a
   * single follow-up. A refresh that only has named turns to account for
   * leaves every other turn's detail read and cache entry alone.
   */
  private scheduleRefresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    const generation = this.generation
    const full =
      this.pendingFull ||
      this.snapshot.mode !== "timeline" ||
      this.snapshot.error !== null ||
      this.snapshot.items.length === 0
    const named = this.pendingTurnKeys
    this.pendingTurnKeys = new Set()
    this.pendingFull = false
    let epoch = this.readEpoch
    if (full) {
      epoch = ++this.readEpoch
      this.detailReadVersions.clear()
      this.update({ loadingTurnKeys: new Set() })
    }
    const request = Promise.resolve().then(() =>
      full ? this.refresh(generation, epoch) : this.refreshNewest(generation, epoch, named)
    )
    this.refreshPromise = request
    void request.finally(() => {
      if (this.refreshPromise !== request) return
      this.refreshPromise = undefined
      if (
        this.snapshot.mode === "timeline" &&
        !this.snapshot.error &&
        (this.pendingFull || this.requestedRevision > (this.snapshot.revision ?? 0))
      )
        void this.scheduleRefresh()
    })
    return request
  }

  /**
   * A notice that named its turns: read the newest page only and splice it
   * on. Older loaded items keep their place and the cursor that pages beyond
   * them; expanded turns reload only when they changed. Anything this cannot
   * prove equivalent to a whole re-read falls back to one.
   */
  private async refreshNewest(
    generation: number,
    epoch: number,
    named: ReadonlySet<string>
  ): Promise<void> {
    if (generation !== this.generation) return
    try {
      for (;;) {
        const requestedAtStart = this.requestedRevision
        const page = await this.source.timeline({
          sessionId: this.sessionId,
          direction: "backward",
        })
        if (generation !== this.generation || epoch !== this.readEpoch) return
        if (page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart)
          continue
        const items =
          page.revision >= requestedAtStart
            ? spliceNewestPage(this.snapshot.items, page, named)
            : undefined
        if (!items) return this.refreshWhole(generation)
        const previous = new Map(this.snapshot.items.map((item) => [item.itemKey, item] as const))
        const changed = new Set(named)
        for (const item of page.items) {
          const before = previous.get(item.itemKey)
          const key = turnKeyOf(item)
          if (!key) continue
          if (
            !before ||
            before.kind !== item.kind ||
            (before.kind === "completed-turn" &&
              item.kind === "completed-turn" &&
              before.detailRevision !== item.detailRevision)
          )
            changed.add(key)
        }
        const completed = new Map(
          items.flatMap((item) =>
            item.kind === "completed-turn" ? [[item.turnKey, item] as const] : []
          )
        )
        const expandedTurnKeys = new Set(
          [...this.snapshot.expandedTurnKeys].filter((key) => completed.has(key))
        )
        const loadingTurnKeys = new Set(this.snapshot.loadingTurnKeys)
        for (const key of changed) {
          // The cached detail and any read in flight belong to the old version.
          this.detailReadVersions.delete(key)
          this.detailCache.delete(this.cacheKey(key))
          this.detailWindows.delete(key)
          loadingTurnKeys.delete(key)
        }
        if (!page.hasMore) this.nextCursor = undefined
        this.update({
          mode: "timeline",
          items,
          // Not `page.revision`: a notice at or below it that this read did
          // not account for (one naming an older turn, still in flight) must
          // not be dropped as already seen.
          revision: Math.max(this.snapshot.revision ?? 0, requestedAtStart),
          loading: false,
          hasMore: page.hasMore ? this.snapshot.hasMore : false,
          expandedTurnKeys,
          loadingTurnKeys,
          error: null,
        })
        for (const key of changed) {
          const item = completed.get(key)
          if (item && expandedTurnKeys.has(key))
            void this.loadTurn(key, item.revision, item.detailRevision, false)
        }
        return
      }
    } catch (error) {
      if (generation !== this.generation) return
      if (errorCode(error) === "TRANSCRIPT_STALE") return this.refreshWhole(generation)
      this.update({ loading: false, error })
    }
  }

  /** Fall back from a newest-page refresh to a whole re-read, in place. */
  private refreshWhole(generation: number): Promise<void> {
    const epoch = ++this.readEpoch
    this.detailReadVersions.clear()
    this.update({ loadingTurnKeys: new Set() })
    return this.refresh(generation, epoch)
  }

  private async refresh(generation: number, epoch: number): Promise<void> {
    if (generation !== this.generation) return
    this.update({ loading: true, error: null })
    try {
      await this.source.capabilities()
      if (generation !== this.generation) return
      // A revision-bound cursor cannot survive a refresh. Rebuild only the
      // already visible window, then swap it atomically so readers keep history.
      const oldest = this.snapshot.items[0]
      let staleRetries = 0
      for (;;) {
        const requestedAtStart = this.requestedRevision
        let page: SessionTimelinePage
        try {
          page = await this.source.timeline({ sessionId: this.sessionId, direction: "backward" })
          if (generation !== this.generation) return
          // A burst needs one follow-up read, not one read per notification.
          // Skip downloading older pages for a response we already know is old.
          if (page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart)
            continue
          if (page.revision < Math.max(this.snapshot.revision ?? 0, this.requestedRevision))
            throw staleTranscript()
          const cursors = new Set<string>()
          while (
            oldest &&
            page.hasMore &&
            !(
              page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart
            ) &&
            !page.items.some((item) => item.itemKey === oldest.itemKey) &&
            (!page.items[0] || page.items[0].startedAt >= oldest.startedAt)
          ) {
            if (!page.nextCursor || cursors.has(page.nextCursor))
              throw new Error("transcript timeline cursor did not advance")
            cursors.add(page.nextCursor)
            const older = await this.source.timeline({
              sessionId: this.sessionId,
              direction: "backward",
              cursor: page.nextCursor,
            })
            if (generation !== this.generation) return
            if (older.revision !== page.revision) throw staleTranscript()
            page = { ...older, items: prependPage(older.items, page.items) }
          }
        } catch (error) {
          if (generation !== this.generation) return
          if (errorCode(error) === "TRANSCRIPT_STALE" && staleRetries++ < 1) continue
          throw error
        }
        if (page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart)
          continue
        // Old detail requests belong to the previous page generation too.
        if (epoch !== this.readEpoch) return
        this.readEpoch++
        this.detailReadVersions.clear()
        this.detailCache.clearSession(this.sessionId)
        this.detailWindows.clear()
        this.nextCursor = page.nextCursor
        const expandedTurnKeys = new Set(
          [...this.snapshot.expandedTurnKeys].filter((key) =>
            page.items.some((item) => item.kind === "completed-turn" && item.turnKey === key)
          )
        )
        this.update({
          mode: "timeline",
          items: page.items,
          revision: page.revision,
          loading: false,
          loadingOlder: false,
          hasMore: page.hasMore,
          expandedTurnKeys,
          loadingTurnKeys: new Set(),
          error: null,
        })
        // A whole re-read at or past every revision announced so far already
        // shows what those notices (and a reload asked for meanwhile) meant.
        if (page.revision >= this.requestedRevision) {
          this.pendingFull = false
          this.pendingTurnKeys.clear()
        }
        for (const item of page.items) {
          if (item.kind === "completed-turn" && expandedTurnKeys.has(item.turnKey)) {
            void this.loadTurn(item.turnKey, item.revision, item.detailRevision, false)
          }
        }
        return
      }
    } catch (error) {
      if (generation === this.generation)
        this.update({
          loading: false,
          loadingOlder: false,
          expandedTurnKeys: new Set(
            [...this.snapshot.expandedTurnKeys].filter(
              (key) =>
                this.detailCache.has(this.cacheKey(key)) || this.snapshot.loadingTurnKeys.has(key)
            )
          ),
          error,
        })
    }
  }

  async loadOlder(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    if (!this.nextCursor || this.snapshot.loadingOlder) return
    const epoch = this.readEpoch
    const revision = this.snapshot.revision
    this.update({ loadingOlder: true, error: null })
    try {
      const page = await this.source.timeline({
        sessionId: this.sessionId,
        direction: "backward",
        cursor: this.nextCursor,
      })
      if (epoch !== this.readEpoch) return
      // A Host that went backwards (a reset database) cannot extend this view.
      if (revision !== null && page.revision < revision) throw staleTranscript()
      // The Host refuses a cursor it can no longer honour (TRANSCRIPT_STALE,
      // handled below), so an older page may come back at a newer session
      // revision: keyset cursors outlive revision bumps. The snapshot keeps
      // its own revision; the newer one is a change this view has not shown
      // yet, so it gets a newest-page refresh even if its notice was lost.
      this.nextCursor = page.nextCursor
      this.update({
        items: prependPage(page.items, this.snapshot.items),
        revision: this.snapshot.revision ?? revision,
        loadingOlder: false,
        hasMore: page.hasMore,
      })
      if (page.revision > (this.snapshot.revision ?? 0)) {
        this.requestedRevision = Math.max(this.requestedRevision, page.revision)
        void this.scheduleRefresh()
      }
    } catch (error) {
      if (epoch !== this.readEpoch) return
      if (errorCode(error) === "TRANSCRIPT_STALE") {
        await this.loadInitial()
        return
      }
      this.update({ loadingOlder: false, error })
    }
  }

  expandTurn(turnKey: string, revision: number, detailRevision: number): Promise<void> {
    return this.loadTurn(turnKey, revision, detailRevision, true)
  }

  pageTurn(turnKey: string, direction: "previous" | "next"): Promise<void> {
    if (this.snapshot.loadingTurnKeys.has(turnKey)) return Promise.resolve()
    const detail = this.getDetail(turnKey)
    const window = this.detailWindows.get(turnKey)
    if (!detail || !window) return Promise.resolve()
    const index = window.index + (direction === "next" ? 1 : -1)
    if (index < 0 || (direction === "next" && !detail.hasMore)) return Promise.resolve()
    const starts = window.starts.slice(0, index + 1)
    if (direction === "next") starts[index] = detail.nextCursor
    return this.loadTurn(turnKey, detail.revision, detail.detailRevision, true, { index, starts })
  }

  private loadTurn(
    turnKey: string,
    revision: number,
    detailRevision: number,
    allowReconcile: boolean,
    window?: DetailWindow
  ): Promise<void> {
    const expanded = new Set(this.snapshot.expandedTurnKeys)
    expanded.add(turnKey)
    this.update({ expandedTurnKeys: expanded, error: null })
    const key = this.cacheKey(turnKey)
    if (!window && this.detailCache.get(key)) {
      this.detailCache.pin(key)
      return Promise.resolve()
    }
    const readVersion = this.detailReadVersions.get(turnKey) ?? ++this.nextDetailReadVersion
    this.detailReadVersions.set(turnKey, readVersion)
    const requestKey = `${this.readEpoch}:${readVersion}:${turnKey}:${revision}:${detailRevision}`
    const existing = this.detailRequests.get(requestKey)
    if (existing) return existing
    this.update({ loadingTurnKeys: new Set([...this.snapshot.loadingTurnKeys, turnKey]) })
    const epoch = this.readEpoch
    const request = this.readDetail(
      turnKey,
      revision,
      detailRevision,
      epoch,
      readVersion,
      allowReconcile,
      window ?? { index: 0, starts: [undefined] }
    )
    this.detailRequests.set(requestKey, request)
    void request.finally(() => {
      if (this.detailRequests.get(requestKey) === request) this.detailRequests.delete(requestKey)
      if (this.detailReadVersions.get(turnKey) === readVersion) {
        this.detailReadVersions.delete(turnKey)
        const loadingTurnKeys = new Set(this.snapshot.loadingTurnKeys)
        loadingTurnKeys.delete(turnKey)
        const expandedTurnKeys = new Set(this.snapshot.expandedTurnKeys)
        for (const expanded of expandedTurnKeys) {
          if (!this.detailCache.has(this.cacheKey(expanded)) && !loadingTurnKeys.has(expanded))
            expandedTurnKeys.delete(expanded)
        }
        this.update({ loadingTurnKeys, expandedTurnKeys })
      }
    })
    return request
  }

  private async readDetail(
    turnKey: string,
    revision: number,
    detailRevision: number,
    epoch: number,
    readVersion: number,
    allowReconcile: boolean,
    window: DetailWindow
  ): Promise<void> {
    const isCurrent = () =>
      epoch === this.readEpoch && readVersion === this.detailReadVersions.get(turnKey)
    try {
      let detail: TranscriptTurnDetail | undefined
      // This array is private until the whole read commits. Appending avoids
      // copying all earlier pages on every request of a long-running turn.
      const messages: SessionTurnMessagesPage["messages"] = []
      let cursor = window.starts[window.index]
      const cursors = new Set(window.starts.filter((value): value is string => value !== undefined))
      const seen = new Set<string>()
      for (;;) {
        const page = await this.source.turnMessages({
          sessionId: this.sessionId,
          turnKey,
          revision,
          detailRevision,
          limit: TRANSCRIPT_DETAIL_WINDOW_MESSAGES - messages.length,
          ...(cursor ? { cursor } : {}),
        })
        if (!isCurrent()) return
        // A turn's detail is versioned by the turn, not the session: another
        // turn streaming moves `page.revision` without touching this one.
        if (page.detailRevision !== detailRevision) throw staleTranscript()
        if (!Number.isSafeInteger(page.approximateBytes) || page.approximateBytes < 0) {
          throw new Error("transcript detail page has an invalid byte size")
        }
        if (page.approximateBytes > this.detailCache.hardByteLimit) {
          throw Object.assign(new Error("A transcript detail page exceeds the memory budget"), {
            code: "TRANSCRIPT_DETAIL_TOO_LARGE",
          })
        }
        // Keep the previous window readable during navigation. If this page
        // would overflow the hard cap, it starts the next window instead.
        if (
          detail &&
          detail.approximateBytes + page.approximateBytes > this.detailCache.hardByteLimit
        ) {
          detail = { ...detail, hasMore: true, nextCursor: cursor }
          break
        }
        for (const message of page.messages) {
          if (seen.has(message.id)) continue
          seen.add(message.id)
          messages.push(message)
        }
        detail = {
          ...page,
          messages,
          approximateBytes: (detail?.approximateBytes ?? 0) + page.approximateBytes,
          ...(window.index > 0 ? { hasPrevious: true } : {}),
        }
        if (!page.hasMore) break
        if (!page.nextCursor || cursors.has(page.nextCursor))
          throw new Error("transcript detail cursor did not advance")
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
        // Window presentation only: authoritative messages stay on the host.
        if (
          detail.approximateBytes >= this.detailCache.softByteLimit ||
          messages.length >= TRANSCRIPT_DETAIL_WINDOW_MESSAGES
        )
          break
      }
      const key = this.cacheKey(turnKey)
      this.detailCache.set(
        key,
        detail,
        detail.approximateBytes,
        this.sessionId,
        this.snapshot.expandedTurnKeys.has(turnKey)
      )
      this.detailWindows.set(turnKey, window)
      const expandedTurnKeys = new Set(this.snapshot.expandedTurnKeys)
      for (const expanded of expandedTurnKeys) {
        if (
          !this.detailCache.has(this.cacheKey(expanded)) &&
          !this.snapshot.loadingTurnKeys.has(expanded)
        ) {
          expandedTurnKeys.delete(expanded)
        }
      }
      for (const key of this.detailWindows.keys()) {
        if (!this.detailCache.has(this.cacheKey(key))) this.detailWindows.delete(key)
      }
      // useSyncExternalStore observes snapshot identity, not notifications.
      this.update({ expandedTurnKeys })
    } catch (error) {
      if (!isCurrent()) return
      // A refreshed turn gets one automatic detail attempt. Re-reconciling a
      // persistently stale host here would produce an endless history RPC loop.
      if (
        allowReconcile &&
        (errorCode(error) === "TRANSCRIPT_STALE" || errorCode(error) === "TURN_NOT_FOUND")
      ) {
        await this.loadInitial()
        return
      }
      const expandedTurnKeys = new Set(this.snapshot.expandedTurnKeys)
      if (!this.getDetail(turnKey)) expandedTurnKeys.delete(turnKey)
      this.update({ error, expandedTurnKeys })
    }
  }

  collapseTurn(turnKey: string): void {
    // Invalidate this read independently of other expanded turns. A collapse
    // stops further downloads even if the same turn is immediately reopened.
    this.detailReadVersions.delete(turnKey)
    const expanded = new Set(this.snapshot.expandedTurnKeys)
    expanded.delete(turnKey)
    this.detailCache.unpin(this.cacheKey(turnKey))
    if (!this.getDetail(turnKey)) this.detailWindows.delete(turnKey)
    const loadingTurnKeys = new Set(this.snapshot.loadingTurnKeys)
    loadingTurnKeys.delete(turnKey)
    this.update({ expandedTurnKeys: expanded, loadingTurnKeys })
  }

  clear(): void {
    this.generation++
    this.readEpoch++
    this.refreshPromise = undefined
    this.detailRequests.clear()
    this.detailReadVersions.clear()
    this.detailWindows.clear()
    this.requestedRevision = 0
    this.pendingTurnKeys = new Set()
    this.pendingFull = true
    this.unsubscribeRevision?.()
    this.unsubscribeRevision = undefined
    this.started = false
    this.detailCache.clearSession(this.sessionId)
    this.listeners.clear()
  }

  private cacheKey(turnKey: string): string {
    return `${this.sessionId}:${turnKey}`
  }

  private update(patch: Partial<TranscriptControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
