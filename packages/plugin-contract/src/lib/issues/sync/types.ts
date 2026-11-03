/**
 * The plugin contract's share of `lib/issues/sync/types.ts`, which re-exports these.
 */
import type {
  Issue,
  IssueActor,
  IssueCycleKind,
  IssueCycleStatus,
  IssueExternalRef,
  IssuePriority,
  IssueProject,
  IssueProjectResource,
  IssuePullRequestCiState,
  IssuePullRequestState,
  IssueStatus,
  IssueSyncField,
} from "../../../types/issues/index"
import type { PluginConfigSchema } from "../../../types/plugin/plugin"
import type { AuthConnectionRef } from "../../../types/plugin/plugin-auth"

/** Host namespaces this local id; implementations must be declared in the manifest. */
export interface PluginIssueSyncProviderDef {
  id: string
  label: string
  schemaVersion: number
}

export interface IssueSyncResourceSchema extends PluginConfigSchema {
  /** A second generated form, stored in config.mapping. Field/status maps are data, never code. */
  mapping?: PluginConfigSchema
}

export interface IssueSyncResourceDescriptor {
  label: string
  /** Built-in Host renderers only. Plugins always use kind `plugin`. */
  kind?: IssueProjectResource["kind"]
  schemaVersion: number
  schema: IssueSyncResourceSchema
  /** Pure and deterministic. The key must survive schema migrations. */
  describe(config: Record<string, unknown>): { key: string; label: string }
  validate?(config: Record<string, unknown>): string[]
  /** Return a new config; the stored resource is not changed until a user saves it. */
  migrate?(fromVersion: number, config: Record<string, unknown>): Record<string, unknown>
}

/** The Host resolves plugin resources from the schema; plugins need no private registry imports. */
export type PluginIssueSyncProvider = Omit<IssueSyncProvider, "resolveBindings" | "resource"> & {
  resource: IssueSyncResourceDescriptor
  /** Host connection, grant-checked and immutable for this registration. Never resource config. */
  connectionRef?: AuthConnectionRef
}

/** One remote container bound to one local container. */
export interface IssueSyncBinding {
  /** Host-resolved execution identity; never persisted in portable resource config. */
  connectionRef?: AuthConnectionRef
  providerId: string
  /** Owning workspace id. */
  projectId: string
  issueProjectId: string
  /** The container's key, for identifier parsing (PR bodies name `KEY-12`). */
  projectKey: string
  resource: IssueProjectResource
  /**
   * Stable per (provider, remote container). Stamped on every ref's
   * `meta.binding` so the engine can identify a binding's refs and a
   * provider can tell its own refs apart from another binding's.
   */
  key: string
}

/** A remote work item, normalised to the board's own vocabulary. */
export interface RemoteIssue {
  externalId: string
  url?: string
  /** Short printed form (`owner/repo#12`, a task title). Cached on the ref. */
  label?: string
  title: string
  description?: string
  status: IssueStatus
  /**
   * The remote only knows open versus closed (GitHub, a Lark task). The
   * engine then compares `status` by category, so a local `in_progress` is
   * not dragged back to `todo` on every pull of an open item.
   */
  coarseStatus?: boolean
  priority?: IssuePriority
  /** Display name of the remote assignee, when there is one. */
  assigneeLabel?: string | null
  /** Label NAMES. The engine resolves them to local rows by name. */
  labels?: readonly string[]
  dueDate?: number | null
  estimate?: number | null
  /** `RemoteCycle.externalId` the item is planned into, `null` for none. */
  cycleExternalId?: string | null
  /** Remote `updated_at`, epoch ms. The engine's clock for D2. */
  remoteUpdatedAt: number
  /** Provider-private data to keep on the ref (`etag`, node ids). */
  meta?: Record<string, string | number>
}

/** A remote milestone, iteration or section, normalised to `issueCycles`. */
export interface RemoteCycle {
  externalId: string
  /** Previous identities eligible for an in-place upgrade within the same binding. */
  legacyExternalIds?: readonly string[]
  kind: IssueCycleKind
  name: string
  status?: IssueCycleStatus
  startsAt?: number
  endsAt?: number
  url?: string
}

/**
 * A pull request or merge request that names issues. The engine links it as
 * a `github-pr`-style ref on every issue it mentions (D11).
 */
export interface RemoteLink {
  provider: string
  externalId: string
  url?: string
  label?: string
  /** Local identifiers (`KEY-12`) and remote issue ids the link mentions. */
  mentionsIdentifiers: readonly string[]
  mentionsExternalIds: readonly string[]
  /**
   * A pull request's state as the remote reported it this pass. The engine
   * records a change on every issue that carries the link, including links
   * made earlier, which is how an `until-pr` wakeup sees a merge.
   */
  prState?: IssuePullRequestState
  /** An open pull request's rolled-up CI this pass, when it has checks. Recorded like `prState`. */
  ciState?: IssuePullRequestCiState
}

export interface PullOptions {
  signal?: AbortSignal
  /** Epoch ms watermark. Absent means everything. */
  since?: number
  /** Ignore the watermark and read everything again. */
  full?: boolean
}

export interface PullResult {
  items: RemoteIssue[]
  cycles?: RemoteCycle[]
  links?: RemoteLink[]
  /** True when the remote answered "nothing changed" and `items` is empty. */
  notModified: boolean
  /** True when a page cap stopped the read before the remote ran out. */
  truncated?: boolean
}

export interface PullPageOptions {
  mode: "incremental" | "full"
  cursor?: string
  page?: string
  signal?: AbortSignal
}

export interface PullPage {
  items: RemoteIssue[]
  cycles?: RemoteCycle[]
  links?: RemoteLink[]
  deleted?: string[]
  /** Absent on the terminal page. */
  nextPage?: string
  /** Only the terminal page supplies the new committed cursor. */
  cursor?: string
}

/** The fields the engine wants written back, already in remote-neutral form. */
export interface RemotePatch {
  title?: string
  description?: string | null
  status?: IssueStatus
  priority?: IssuePriority
  labels?: readonly string[]
  dueDate?: number | null
  estimate?: number | null
  /** Local cycle's ref for this provider, when one exists, else `null`. */
  cycleExternalId?: string | null
  /**
   * The local assignee's display label, `null` when nobody is assigned. A
   * provider pushes it only when the label names someone on the remote (a
   * GitHub login that came from GitHub); agents and workspace members stay
   * local, exactly as before assignees were pushed at all.
   */
  assignee?: string | null
}

export type PushOutcome =
  /** The remote accepted the write. */
  | { status: "applied"; remoteUpdatedAt?: number }
  /**
   * The write was queued behind an approval gate (an integration action job).
   * The engine leaves the ref untouched, so the next pass pushes again with
   * the same idempotency key and the job is deduplicated upstream.
   */
  | { status: "queued"; jobId?: string }

export interface IssueSyncProvider {
  readonly id: string
  readonly label: string
  readonly resource?: IssueSyncResourceDescriptor
  /** Fields the engine may take FROM the remote. */
  readonly pullFields: readonly IssueSyncField[]
  /** Fields the engine may send TO the remote. Empty means read-only. */
  readonly pushFields: readonly IssueSyncField[]
  /** Full pages enumerate every live item, including closed/done items. Requires pullPage. */
  readonly completeFullScan?: boolean
  /** No change feed: enumerate the full container on every pass. */
  readonly fullScanOnly?: boolean
  /** Which resource kind(s) this provider binds. */
  resolveBindings(containers: readonly IssueProject[]): IssueSyncBinding[]
  /** Legacy single-page interface. A truncated result never advances the stored cursor. */
  pull(binding: IssueSyncBinding, options: PullOptions): Promise<PullResult>
  pullPage?(binding: IssueSyncBinding, options: PullPageOptions): Promise<PullPage>
  /**
   * Confirm deleted/moved ids before tombstoning. Return only verified departures;
   * reject on an uncertain response. The Host budgets at most 50 ids per run.
   */
  confirmDeparted?(
    binding: IssueSyncBinding,
    ids: string[],
    options: { signal?: AbortSignal }
  ): Promise<string[]>
  push?(
    binding: IssueSyncBinding,
    ref: IssueExternalRef,
    patch: RemotePatch,
    issue: Issue,
    context: {
      signal?: AbortSignal
      idempotencyKey: string
      by: IssueActor
      /**
       * Who made the local edits the patch carries (ADR-0239): `person` when
       * every one was a person's, else `automation`. A provider that writes
       * through the integration broker names a person's edit as the person's
       * own write, and leaves an automation's to the outbound policy.
       */
      editedBy?: "person" | "automation"
    }
  ): Promise<PushOutcome>
  /** Create the remote counterpart of a local issue. Manual, never automatic. */
  create?(binding: IssueSyncBinding, issue: Issue): Promise<IssueExternalRef>
}
