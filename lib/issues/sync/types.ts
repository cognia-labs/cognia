/**
 * The contract between the sync engine and a provider (spec 2026-09-06, D1).
 *
 * A provider knows one remote system: how to find its bindings among a
 * container's resources, how to read what changed, and how to write a patch
 * back. It knows nothing about Dexie, events, conflicts or the board. The
 * engine (`./engine.ts`) owns all of that, so a Lark tasklist, a GitHub
 * repository and a plugin's Jira instance all reconcile the same way.
 */

import type { IssueSyncBinding } from "@cognia/plugin-contract/lib/issues/sync/types"
import type { IssueSyncProvider as ContractProvider } from "@cognia/plugin-contract/lib/issues/sync/types"
import type { ExternalSyncOutcome, ExternalSyncTarget } from "@/lib/external-services/sync/types"
export type {
  IssueSyncBinding,
  IssueSyncResourceDescriptor,
  IssueSyncResourceSchema,
  PluginIssueSyncProviderDef,
  PullOptions,
  PullResult,
  PullPage,
  PullPageOptions,
  PushOutcome,
  RemoteCycle,
  RemoteIssue,
  RemoteLink,
  RemotePatch,
} from "@cognia/plugin-contract/lib/issues/sync/types"

/** Host-only credential preparation; plugin registrations never copy this hook. */
export interface IssueSyncProvider extends ContractProvider {
  readonly connectionRef?: ExternalSyncTarget["connectionRef"]
  prepare?(binding: IssueSyncBinding): Promise<{
    provider: IssueSyncProvider
    connectionRef?: ExternalSyncTarget["connectionRef"]
    consumerPluginId?: string
    consumerKind?: "integration"
  }>
}

export interface ReconcileOutcome {
  status: ExternalSyncOutcome["status"]
  errorCode?: string
  tombstoned: number
  pages: number
  binding: IssueSyncBinding
  created: number
  updated: number
  pushed: number
  queued: number
  conflicts: number
  linked: number
  cycles: number
  notModified: boolean
  truncated: boolean
}

export class IssueSyncOutcomeError extends Error {
  constructor(readonly code: string) {
    super(`Issue sync failed: ${code}`)
    this.name = "IssueSyncOutcomeError"
  }
}

export interface IssueSyncFailure {
  binding: IssueSyncBinding
  error: unknown
}
