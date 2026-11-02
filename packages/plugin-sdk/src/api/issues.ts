/**
 * Issue tracker API surface, published as `@cognia/plugin-sdk/api/issues`
 * (spec 2026-09-06 D9).
 *
 * Runtime operations live on `ctx.issues`. What ships here is the shape of
 * that surface plus the domain vocabulary and definition helper authors need.
 * The host owns the behaviour, and the same
 * `lib/issues/service.ts` gate that refuses a move on the board refuses it
 * for a plugin.
 */

export { defineIssueSyncProvider } from "../define/define-issue-sync-provider"

export type {
  PluginIssuesAPI,
  PluginIssueCreateInput,
  PluginIssueQuery,
  PluginIssueUpdatePatch,
  PluginIssueEventOptions,
} from "@cognia/plugin-contract/lib/plugin/api/issues-api"

export type {
  IssueBulkAction,
  IssueBulkOutcome,
} from "@cognia/plugin-contract/lib/issues/bulk-actions"
export type { IssueWire } from "@cognia/plugin-contract/lib/issues/service"

export type {
  IssueSyncBinding,
  IssueSyncProvider,
  PluginIssueSyncProvider,
  PluginIssueSyncProviderDef,
  IssueSyncResourceDescriptor,
  IssueSyncResourceSchema,
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

export type {
  Issue,
  IssueActor,
  IssueCycle,
  IssueEvent,
  IssueEventKind,
  IssueEventPayload,
  IssueExternalRef,
  IssueOrigin,
  IssuePriority,
  IssueProject,
  IssueProjectResource,
  IssueStatus,
  IssueSyncField,
} from "@cognia/plugin-contract/types/issues/index"
