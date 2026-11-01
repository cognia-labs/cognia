/**
 * The contract between the sync engine and a provider (spec 2026-09-06, D1).
 *
 * A provider knows one remote system: how to find its bindings among a
 * container's resources, how to read what changed, and how to write a patch
 * back. It knows nothing about Dexie, events, conflicts or the board. The
 * engine (`./engine.ts`) owns all of that, so a Lark tasklist, a GitHub
 * repository and a plugin's Jira instance all reconcile the same way.
 */

import type {
  IssueSyncProvider as PortableProvider,
  PullOptions as PortablePullOptions,
  PullPageOptions as PortablePullPageOptions,
} from "@cognia/plugin-contract/lib/issues/sync/types"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import type { IssueSyncBinding } from "@cognia/plugin-contract/lib/issues/sync/types"
import type { ExternalSyncOutcome, ExternalSyncTarget } from "@/lib/external-services/sync/types"
export type {
  IssueSyncBinding,
  IssueSyncResourceDescriptor,
  IssueSyncResourceSchema,
  PluginIssueSyncProviderDef,
  PullResult,
  PullPage,
  PushOutcome,
  RemoteCycle,
  RemoteIssue,
  RemoteLink,
  RemotePatch,
} from "@cognia/plugin-contract/lib/issues/sync/types"

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

/** Invocation proof stays in Host types and never crosses plugin callbacks. */
export interface PullOptions extends PortablePullOptions {
  credentialContext?: PersonalCredentialContext
}
export interface PullPageOptions extends PortablePullPageOptions {
  credentialContext?: PersonalCredentialContext
}

/** Invocation proof and preparation are Host-only; public callbacks receive portable arguments. */
export interface IssueSyncProvider extends Omit<
  PortableProvider,
  "pull" | "pullPage" | "confirmDeparted" | "push" | "create"
> {
  readonly connectionRef?: ExternalSyncTarget["connectionRef"]
  prepare?(
    binding: IssueSyncBinding,
    credentialContext?: PersonalCredentialContext
  ): Promise<{
    provider: IssueSyncProvider
    connectionRef?: ExternalSyncTarget["connectionRef"]
    consumerPluginId?: string
    consumerKind?: "integration"
  }>
  pullPage?: (
    binding: IssueSyncBinding,
    options: PullPageOptions
  ) => ReturnType<NonNullable<PortableProvider["pullPage"]>>
  confirmDeparted?: (
    binding: IssueSyncBinding,
    ids: Parameters<NonNullable<PortableProvider["confirmDeparted"]>>[1],
    options: Parameters<NonNullable<PortableProvider["confirmDeparted"]>>[2] & {
      credentialContext?: PersonalCredentialContext
    }
  ) => ReturnType<NonNullable<PortableProvider["confirmDeparted"]>>
  pull(binding: IssueSyncBinding, options: PullOptions): ReturnType<PortableProvider["pull"]>
  push?: (
    ...args: [
      Parameters<NonNullable<PortableProvider["push"]>>[0],
      Parameters<NonNullable<PortableProvider["push"]>>[1],
      Parameters<NonNullable<PortableProvider["push"]>>[2],
      Parameters<NonNullable<PortableProvider["push"]>>[3],
      Parameters<NonNullable<PortableProvider["push"]>>[4] & {
        credentialContext?: PersonalCredentialContext
      },
    ]
  ) => ReturnType<NonNullable<PortableProvider["push"]>>
  create?: (
    binding: IssueSyncBinding,
    issue: Parameters<NonNullable<PortableProvider["create"]>>[1],
    credentialContext?: PersonalCredentialContext
  ) => ReturnType<NonNullable<PortableProvider["create"]>>
}
