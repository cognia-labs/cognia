/**
 * The GitHub mirror's half of a workspace sweep.
 *
 * `lib/issues/github-sync.ts` is deliberately dependency-injected and knows
 * nothing about where repos come from or how a token is obtained. This module
 * supplies both. Every caller reaches it through `runWorkspaceIssueSync`
 * (`lib/issues/sync/runner.ts`): the toolbar button, the scheduler executor and
 * the RPC run exactly the same path, so a schedule can never drift from the
 * manual button.
 *
 * Credentials use the import provider's resolver, which returns the client and
 * its Host connection together (or a gh CLI fallback with a named lock).
 */

import { listIssueProjects } from "@/lib/db/issue-projects"
import type { OctokitLike } from "@/lib/github/issues"
import {
  syncWorkspaceRepos,
  githubMirrorSyncTarget,
  type SyncRepoIssuesDeps,
  type SyncWorkspaceReposResult,
} from "./github-sync"
import {
  reconcileIssueSyncRegistrations,
  runRegisteredIssueSync,
  type IssueSyncRuntimeDeps,
} from "./sync/runtime"

export interface WorkspaceGithubBinding {
  repoFullName: string
  issueProjectId: string
}

/**
 * Every `github-repo` resource, as (repo → container) pairs. Omit `projectId`
 * to sweep every workspace — that is what the background schedule does, since
 * one refresh task per install beats one per workspace.
 *
 * Deduplicated by repo, first binding wins. A mirror row's primary key is
 * `owner/repo#number`, so it can belong to exactly one container — binding the
 * same repo to two projects would have the second sync silently steal every row
 * from the first. The add-resource dialog refuses that binding up front; this
 * dedup is the backstop for rows that predate the check or arrive by import.
 *
 * Ordering is by container id so the winner is stable across runs rather than
 * dependent on Dexie's iteration order.
 */
export async function resolveWorkspaceGithubBindings(
  projectId?: string
): Promise<WorkspaceGithubBinding[]> {
  const containers = await listIssueProjects(projectId === undefined ? {} : { projectId })
  const seen = new Set<string>()
  const bindings: WorkspaceGithubBinding[] = []

  for (const container of [...containers].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const resource of container.resources) {
      if (resource.kind !== "github-repo") continue
      // Import-mode bindings belong to `lib/issues/sync/` (spec 2026-09-06
      // D1): their rows are local issues, not mirror rows.
      if (resource.sync?.mode === "import") continue
      if (seen.has(resource.repoFullName.toLowerCase())) continue
      seen.add(resource.repoFullName.toLowerCase())
      bindings.push({ repoFullName: resource.repoFullName, issueProjectId: container.id })
    }
  }

  return bindings
}

export interface RunWorkspaceGithubSyncInput {
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  /** Workspace scope. Omit to refresh every bound repo across all workspaces. */
  projectId?: string
  /** Ignore the stored watermark and re-read every issue. */
  full?: boolean
}

export interface RunWorkspaceGithubSyncDeps {
  resolveBindings?: typeof resolveWorkspaceGithubBindings
  /** Test/legacy override; production resolves the exact credential source too. */
  resolveOctokitOrNull?: (repoFullName: string) => Promise<OctokitLike | null>
  sync?: typeof syncWorkspaceRepos
  /**
   * The import side of the registration set. A workspace sweep passes its own
   * so the one reconcile before the mirror registers every binding kind with
   * the deps that sweep runs it with.
   */
  runtime?: Pick<IssueSyncRuntimeDeps, "registry" | "importBindings">
}

export interface RunWorkspaceGithubSyncResult extends SyncWorkspaceReposResult {
  /** Bound repos considered. Zero means nothing is bound — not an error. */
  repoCount: number
}

/** Thrown so a missing credential fails that repo alone, not the whole run. */
export class MissingGithubCredentialError extends Error {
  constructor(repoFullName: string) {
    super(`No GitHub credential available for "${repoFullName}"`)
    this.name = "MissingGithubCredentialError"
    // Subclassing a builtin loses the prototype link when the transform
    // downlevels the class, which silently breaks `instanceof`. Jest's SWC
    // pipeline does exactly that, so restore it explicitly.
    Object.setPrototypeOf(this, MissingGithubCredentialError.prototype)
  }
}

/**
 * Prefer this over `instanceof` at surface boundaries: it survives a downlevel
 * transform and a duplicated module instance, both of which would otherwise
 * turn "connect GitHub first" into a generic "sync failed".
 */
export function isMissingGithubCredential(error: unknown): boolean {
  return error instanceof Error && error.name === "MissingGithubCredentialError"
}

/**
 * Refresh every repo bound in the workspace.
 *
 * A workspace with no bound repo returns an empty success rather than an
 * error: the scheduled task is registered once per install, so "nothing bound
 * yet" is the normal state for most of its life and must not show up as a
 * failing execution in the scheduler history.
 */
export async function runWorkspaceGithubSync(
  input: RunWorkspaceGithubSyncInput,
  deps: RunWorkspaceGithubSyncDeps = {}
): Promise<RunWorkspaceGithubSyncResult> {
  const resolveBindings = deps.resolveBindings ?? resolveWorkspaceGithubBindings
  const bindings = await resolveBindings(input.projectId)
  const mirrorDeps: SyncRepoIssuesDeps = deps.resolveOctokitOrNull
    ? {
        resolveOctokit: async (repoFullName) => {
          const octokit = await deps.resolveOctokitOrNull!(repoFullName)
          if (!octokit) throw new MissingGithubCredentialError(repoFullName)
          return octokit
        },
      }
    : {}
  await reconcileIssueSyncRegistrations({
    ...deps.runtime,
    mirrorBindings: () => resolveBindings(),
    mirrorDeps,
  })
  if (bindings.length === 0) return { repoCount: 0, results: [], failures: [] }

  const sync = deps.sync ?? syncWorkspaceRepos
  const result = await sync(
    { bindings, ...(input.full ? { full: true } : {}) },
    async (binding) => {
      const outcome = await runRegisteredIssueSync(githubMirrorSyncTarget(binding).key, {
        full: binding.full,
        credentialContext: input.credentialContext,
      })
      return outcome && "repoFullName" in outcome ? outcome : undefined
    }
  )
  return { repoCount: bindings.length, ...result }
}
