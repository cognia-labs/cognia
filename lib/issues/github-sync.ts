/** GitHub mirror pages share the durable incremental-sync checkpoint and exclusion. */
import {
  fetchGithubIssuePage,
  githubIssuePageUsedOffset,
  MAX_ISSUE_PAGES,
  toMirrorRow,
  type OctokitLike,
} from "@/lib/github/issues"
import {
  deleteGithubIssues,
  listGithubIssues,
  upsertGithubIssues,
} from "@/lib/db/github-issue-mirror"
import { getDb } from "@/lib/db/schema"
import type { GithubIssueMirrorRow } from "@/lib/db/github-issue-mirror-types"
import type { DerivedDataTarget } from "@/lib/external-services/derived-data-registry"
import { runExternalSync } from "@/lib/external-services/sync/core"
import type {
  ExternalSyncDriver,
  ExternalSyncOutcome,
  ExternalSyncTarget,
} from "@/lib/external-services/sync/types"

export interface SyncRepoIssuesDeps {
  /** Workspace sweeps execute only a still-registered, freshly resolved target. */
  runRegistered?: (input: SyncRepoIssuesInput) => Promise<SyncRepoIssuesResult | undefined>
  resolveOctokit?: (repoFullName: string) => Promise<OctokitLike>
  resolveReadClient?: (repoFullName: string) => Promise<{
    octokit: OctokitLike
    connectionRef?: ExternalSyncTarget["connectionRef"]
    consumerPluginId?: string
  }>
  upsertGithubIssues?: typeof upsertGithubIssues
  now?: () => number
  /** At most MAX_ISSUE_PAGES; smaller budgets let a Host share API spend. */
  pageBudget?: number
}

export interface SyncRepoIssuesInput {
  repoFullName: string
  issueProjectId: string
  full?: boolean
}

export interface SyncRepoIssuesResult {
  repoFullName: string
  written: number
  removed: number
  notModified: boolean
  truncated: boolean
  status: ExternalSyncOutcome["status"]
  errorCode?: string
  rateLimitRemaining?: number
}

export class GithubMirrorSyncOutcomeError extends Error {
  constructor(readonly code: string) {
    super(`GitHub mirror sync failed: ${code}`)
    this.name = "GithubMirrorSyncOutcomeError"
  }
}

export interface GithubMirrorSyncOwnership {
  consumerPluginId?: string
  providerPluginId?: string
  mirrorRunToken?: string
}

class GithubMirrorDataPurged extends Error {
  constructor() {
    super("GitHub mirror data purged")
    this.name = "AbortError"
  }
}

export function githubMirrorSyncTarget(
  input: SyncRepoIssuesInput
): ExternalSyncTarget & GithubMirrorSyncOwnership {
  return {
    key: `github-mirror:${input.issueProjectId}:${input.repoFullName.toLowerCase()}`,
    owner: "host",
  }
}

/** Also used by push registration: credentials and binding are resolved anew per run. */
export async function prepareGithubMirrorSync(
  input: SyncRepoIssuesInput,
  deps: SyncRepoIssuesDeps = {}
) {
  const target = githubMirrorSyncTarget(input)
  const table = getDb().externalSyncCursors
  const stored = await table.get(target.key)
  // A purge during credential preparation must also fence a factory without rows/cursors yet.
  const fences = new Map(
    (await getDb().integrationAudit.where("kind").equals("github-mirror.purge").toArray()).map(
      (row) => [row.id, row.detail?.generation]
    )
  )
  let octokit: OctokitLike | undefined
  let consumerPluginId: string | undefined
  let providerPluginId: string | undefined
  const assertNotPurged = async () => {
    for (const fence of await getDb()
      .integrationAudit.where("kind")
      .equals("github-mirror.purge")
      .toArray()) {
      const purged = fence.detail?.target as DerivedDataTarget | undefined
      const matches =
        purged?.kind === "plugin-data"
          ? purged.pluginId === consumerPluginId || purged.pluginId === providerPluginId
          : purged?.ref === target.connectionRef &&
            (purged?.kind === "connection" ||
              (purged?.kind === "consumer" && purged.consumerPluginId === consumerPluginId))
      if (matches && fence.detail?.generation !== fences.get(fence.id))
        throw new GithubMirrorDataPurged()
    }
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    target.connectionRef = stored?.connectionRef
  } else {
    const client = deps.resolveOctokit
      ? { octokit: await deps.resolveOctokit(input.repoFullName) }
      : await (
          deps.resolveReadClient ??
          (await import("./sync/providers/github")).resolveGithubSyncReadClient
        )(input.repoFullName)
    octokit = client.octokit
    target.connectionRef = client.connectionRef
    consumerPluginId = client.consumerPluginId
    if (target.connectionRef) {
      const { getAuthConnection } = await import("@/lib/db/auth-connections")
      providerPluginId = (await getAuthConnection(target.connectionRef))?.ownerPluginId ?? undefined
    }
    // Match the import engine: an empty offline deferral has no credential identity yet.
    await getDb().transaction("rw", table, async () => {
      const current = await table.get(target.key)
      if (
        current?.owner === target.owner &&
        current.deferredOffline &&
        !current.cursor &&
        !current.generation &&
        current.connectionRef !== target.connectionRef
      )
        await table.delete(target.key)
    })
  }
  Object.assign(target, { consumerPluginId, providerPluginId, mirrorRunToken: crypto.randomUUID() })
  await getDb().transaction("rw", table, getDb().integrationAudit, async () => {
    await assertNotPurged()
    const current = await table.get(target.key)
    if (current?.owner === target.owner && current.connectionRef === target.connectionRef) {
      const owned = {
        ...current,
        consumerPluginId,
        providerPluginId,
        mirrorRunToken: target.mirrorRunToken,
      }
      await table.put(owned)
    }
  })
  const result: SyncRepoIssuesResult = {
    repoFullName: input.repoFullName,
    written: 0,
    removed: 0,
    notModified: false,
    truncated: false,
    status: "completed",
  }
  const driver: ExternalSyncDriver<GithubIssueMirrorRow> = {
    pageBudget: Math.max(
      1,
      Math.min(MAX_ISSUE_PAGES, Math.floor(deps.pageBudget ?? MAX_ISSUE_PAGES))
    ),
    itemId: (row) => String(row.number),
    fetchPage: async (options) => {
      try {
        await assertNotPurged()
        const previous = options.cursor ?? (await table.get(target.key))?.cursor
        const page = await fetchGithubIssuePage(octokit!, {
          ...options,
          cursor: previous,
          repoFullName: input.repoFullName,
        })
        await assertNotPurged()
        if (page.rateLimitRemaining !== undefined)
          result.rateLimitRemaining = page.rateLimitRemaining
        return {
          items: page.raw
            .filter((row) => !row.pull_request)
            .map((row) =>
              toMirrorRow(row, {
                repoFullName: input.repoFullName,
                issueProjectId: input.issueProjectId,
                syncedAt: (deps.now ?? Date.now)(),
              })
            ),
          ...(page.nextPage
            ? { nextPage: page.nextPage }
            : { cursor: String(Math.max(Number(previous ?? 0), Number(page.cursor))) }),
        }
      } catch (error) {
        await clearPurgedCheckpoint()
        throw error
      }
    },
    applyPage: async ({ items }, { signal }) => {
      signal.throwIfAborted()
      try {
        await getDb().transaction(
          "rw",
          getDb().githubIssueMirror,
          getDb().integrationAudit,
          async () => {
            await assertNotPurged()
            const ownership = {
              connectionRef: target.connectionRef,
              consumerPluginId,
              providerPluginId,
            }
            // Revalidation also binds previously cached rows, including a successful empty page.
            await getDb()
              .githubIssueMirror.where("repoFullName")
              .equals(input.repoFullName)
              .modify(ownership)
            if (items.length)
              await (deps.upsertGithubIssues ?? upsertGithubIssues)(
                items.map((row) => ({ ...row, ...ownership }))
              )
          }
        )
        signal.throwIfAborted()
        result.written += items.length
      } catch (error) {
        await clearPurgedCheckpoint()
        throw error
      }
    },
    listKnownIds: async (signal) => {
      const generation = (await table.get(target.key))?.generation
      signal.throwIfAborted()
      // Durable tokens include earlier runs, including a retry of terminal finalization.
      if (generation?.pageTokens?.some(githubIssuePageUsedOffset)) return []
      return (
        await listGithubIssues({
          repoFullName: input.repoFullName,
          issueProjectId: input.issueProjectId,
        })
      ).map((row) => String(row.number))
    },
    tombstone: async (ids, { signal }) => {
      signal.throwIfAborted()
      result.removed += await deleteGithubIssues(input.repoFullName, ids.map(Number))
      signal.throwIfAborted()
    },
  }
  const clearPurgedCheckpoint = async () => {
    try {
      await assertNotPurged()
    } catch (error) {
      if (!(error instanceof GithubMirrorDataPurged)) throw error
      const db = getDb()
      await db.transaction("rw", db.externalSyncCursors, db.externalSyncSeen, async () => {
        const current = (await table.get(target.key)) as
          (ExternalSyncTarget & GithubMirrorSyncOwnership) | undefined
        if (current?.mirrorRunToken !== target.mirrorRunToken) return
        await db.externalSyncSeen.filter((row) => row.key === target.key).delete()
        await table.delete(target.key)
      })
    }
  }
  return { target, driver, result, clearPurgedCheckpoint }
}

export async function syncRepoIssues(
  input: SyncRepoIssuesInput,
  deps: SyncRepoIssuesDeps = {}
): Promise<SyncRepoIssuesResult> {
  const { target, driver, result, clearPurgedCheckpoint } = await prepareGithubMirrorSync(
    input,
    deps
  )
  let outcome: ExternalSyncOutcome
  try {
    outcome = await runExternalSync(target, driver, {
      mode: input.full ? "full" : "auto",
      now: deps.now,
    })
  } finally {
    await clearPurgedCheckpoint()
  }
  return {
    ...result,
    status: outcome.status,
    truncated: outcome.truncated ?? false,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  }
}

export interface SyncWorkspaceReposInput {
  /** Every (repo, container) pair bound in the workspace. */
  bindings: ReadonlyArray<{ repoFullName: string; issueProjectId: string }>
  full?: boolean
}

export interface SyncWorkspaceReposResult {
  results: SyncRepoIssuesResult[]
  failures: Array<{ repoFullName: string; error: unknown }>
}

/**
 * Sync every bound repo. One repo failing must not abandon the rest — a single
 * revoked installation should not leave the whole board stale, and the caller
 * needs to know which repo to complain about.
 */
export async function syncWorkspaceRepos(
  input: SyncWorkspaceReposInput,
  deps: SyncRepoIssuesDeps
): Promise<SyncWorkspaceReposResult> {
  const results: SyncRepoIssuesResult[] = []
  const failures: Array<{ repoFullName: string; error: unknown }> = []

  for (const binding of input.bindings) {
    try {
      const target = { ...binding, ...(input.full ? { full: true } : {}) }
      const result = deps.runRegistered
        ? await deps.runRegistered(target)
        : await syncRepoIssues(target, deps)
      if (!result) continue
      results.push(result)
      // Busy is a successful exclusion, just like the import runner.
      if (result.status === "failed" || result.status === "backoff") {
        failures.push({
          repoFullName: binding.repoFullName,
          error: new GithubMirrorSyncOutcomeError(result.errorCode ?? result.status),
        })
      }
    } catch (error) {
      failures.push({ repoFullName: binding.repoFullName, error })
    }
  }

  return { results, failures }
}
