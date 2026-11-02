import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"

export type ExternalSyncMode = "incremental" | "full"

export interface ExternalSyncPage<Item> {
  items: Item[]
  /** Remote ids reported deleted in this page. */
  deleted?: string[]
  /** Absent on the terminal page. */
  nextPage?: string
  /** Terminal page only: the new committed opaque cursor. */
  cursor?: string
}

export interface ExternalSyncDriver<Item> {
  /** Enumerate full pages every pass without bypassing persisted retry delays. */
  fullScanOnly?: boolean
  itemId(item: Item): string
  fetchPage(input: {
    mode: ExternalSyncMode
    cursor?: string
    page?: string
    signal: AbortSignal
  }): Promise<ExternalSyncPage<Item>>
  /** Idempotent by itemId: a crash before checkpointing re-applies this page. */
  applyPage(
    page: { items: Item[]; deleted: string[] },
    ctx: { mode: ExternalSyncMode; generation: string; signal: AbortSignal }
  ): Promise<void>
  listKnownIds?(signal: AbortSignal): Promise<string[]>
  /** Idempotent: a crash before committing the terminal cursor repeats tombstones. */
  tombstone?(ids: string[], ctx: { generation: string; signal: AbortSignal }): Promise<void>
  /** Finalize under the same exclusion, after tombstones and before committing the cursor. */
  complete?(ctx: { signal: AbortSignal }): Promise<void>
}

export class ExternalSyncRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("External sync rate limited")
    this.name = "ExternalSyncRateLimited"
  }
}
export class ExternalSyncCursorInvalid extends Error {}

export interface ExternalSyncTarget {
  key: string
  owner: "host" | `plugin:${string}`
  connectionRef?: AuthConnectionRef
}

export interface ExternalSyncOutcome {
  status: "completed" | "deferred-offline" | "backoff" | "busy" | "cancelled" | "failed"
  mode: ExternalSyncMode
  pages: number
  applied: number
  tombstoned: number
  errorCode?: string
}

export interface ExternalSyncOptions {
  mode?: "auto" | "full"
  signal?: AbortSignal
  now?: () => number
  isOffline?: () => boolean
  random?: () => number
}

/** Dormant (ADR-0246 P8): no shipped provider registers an expiring-subscription renewer yet. */
export interface ExternalSyncSubscription {
  id: string
  expiresAt: number
  renewAt: number
  state: "active" | "renew-failed"
  attempts: number
}

export type ExternalSyncRenewer = (
  subscription: ExternalSyncSubscription,
  signal: AbortSignal
) => Promise<{ id: string; expiresAt: number }>
