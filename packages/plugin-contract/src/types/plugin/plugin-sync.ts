import type { AuthConnectionRef } from "./plugin-auth"

export type ExternalSyncMode = "incremental" | "full"
export interface ExternalSyncPage<Item> {
  /** At most 1000 items per page; itemId must return a nonempty string. */
  items: Item[]
  deleted?: string[]
  /** Opaque page and cursor tokens are bounded to 16 KiB each. */
  nextPage?: string
  /** Required on the terminal page. Opaque and stored only by the Host. */
  cursor?: string
}
export interface ExternalSyncOutcome {
  status: "completed" | "deferred-offline" | "backoff" | "busy" | "cancelled" | "failed"
  mode: ExternalSyncMode
  pages: number
  applied: number
  tombstoned: number
  errorCode?: string
  truncated?: boolean
}
export interface PluginSyncDriver<Item> {
  fullScanOnly?: boolean
  itemId(item: Item): string
  fetchPage(input: {
    mode: ExternalSyncMode
    cursor?: string
    page?: string
    signal: AbortSignal
  }): Promise<ExternalSyncPage<Item>>
  /** Idempotent: a crash before checkpointing re-applies the same generation/page. */
  applyPage(
    page: { items: Item[]; deleted: string[] },
    context: { mode: ExternalSyncMode; generation: string; signal: AbortSignal }
  ): Promise<void>
  listKnownIds?(signal: AbortSignal): Promise<string[]>
  /** Keep the item, mark its source removed; never delete user-kept data. */
  tombstone?(ids: string[], context: { generation: string; signal: AbortSignal }): Promise<void>
  /** Last authorization/revision check, before the Host commits its cursor. */
  complete?(context: { signal: AbortSignal }): Promise<void>
}
export interface PluginSyncStatus {
  lastSuccessAt?: number
  failures: number
  backoffUntil?: number
  lastErrorCode?: string
  mode?: ExternalSyncMode
  inProgress: boolean
}
export interface PluginSyncRegistrationOptions {
  /** Immutable binding. Validated eagerly at registration and before every run. */
  connectionRef?: AuthConnectionRef
}
/**
 * Host-owned cursors, generations, retry and exclusion. Requires sync:run.
 * Subscription renewal is scheduler-based and dormant: no public renewal API,
 * no active UI, and tests pin its inert state. Polling remains supported.
 *
 * Node-target plugins: only activation-time register is replayed. Revived
 * callbacks return through invokeCallback; message-only errors become generic
 * failures with bounded backoff and never advance the cursor. Cancellation
 * stops the Host run/discards late results, but is not sent into the child.
 * run/request/status/reset are unavailable there after activation. In-realm
 * frontend/hybrid plugins support tagged errors and two-way cancellation.
 */
export interface PluginSyncAPI {
  /**
   * Local key: 1-128 characters, [A-Za-z0-9._:-]. Duplicate keys throw.
   * Connection authorization starts here; asynchronous validation gates all runs.
   * A rejected binding fails run() or the background request without invoking the driver.
   * Dispose and re-register to change the immutable binding.
   */
  register<Item>(
    key: string,
    driver: PluginSyncDriver<Item>,
    options?: PluginSyncRegistrationOptions
  ): { dispose(): void }
  run(key: string, options?: { full?: boolean; signal?: AbortSignal }): Promise<ExternalSyncOutcome>
  request(key: string, options: { reason: "poll" | "manual"; full?: boolean }): void
  /** Metadata only: never returns cursor or page tokens. */
  status(key: string): Promise<PluginSyncStatus>
  reset(key: string): Promise<void>
}
