/**
 * GitHub issue mirror CRUD — Dexie table `githubIssueMirror` (schema v171).
 *
 * A read-through cache of `GET /repos/{owner}/{repo}/issues`. Rows reach the
 * board as read-only federated items via `lib/issues/sources/github-source.ts`;
 * nothing here is a source of truth, and nothing here is edited by the user.
 *
 * Deliberately NOT registered in `lib/sync/handlers/`: the mirror is
 * rebuildable from GitHub in one request, and syncing a cache that can drift
 * costs more than re-fetching it. The seven-site sync fan-out is reserved for
 * data that only exists locally.
 *
 * Mechanical module — no network, no gating. Fetching lives in
 * `lib/github/issues.ts`; this module only stores what that returns.
 */

import type { GithubIssueMirrorRow } from "./github-issue-mirror-types"
import { getDb } from "./schema"

/** Stable, human-legible primary key. */
export function githubMirrorId(repoFullName: string, number: number): string {
  return `${repoFullName}#${number}`
}

/**
 * Inverse of {@link githubMirrorId}. Lives here because this module owns the
 * format — a write-back surface that re-derived `owner/repo` and the number by
 * splitting the string itself would drift the moment the key changed.
 *
 * Splits on the LAST `#`: a repo name cannot contain one, but being explicit
 * costs nothing and a wrong split would address the wrong issue.
 */
export function parseGithubMirrorId(id: string): { repoFullName: string; number: number } | null {
  const hash = id.lastIndexOf("#")
  if (hash <= 0) return null
  const repoFullName = id.slice(0, hash)
  const number = Number(id.slice(hash + 1))
  if (!Number.isInteger(number) || number <= 0) return null
  return { repoFullName, number }
}

/**
 * Upsert a page of issues for one repo.
 *
 * `bulkPut` rather than add-or-patch: GitHub hands back the full issue on every
 * fetch, so the remote row always wins wholesale. There is no local edit to
 * preserve — that is the point of the mirror being read-only.
 */
export async function upsertGithubIssues(rows: readonly GithubIssueMirrorRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().githubIssueMirror.bulkPut([...rows])
}

export interface ListGithubIssuesQuery {
  repoFullName?: string
  /** Narrow to the issues bound to one delivery container. */
  issueProjectId?: string
  /** Omit closed issues — the board's default for a "what's outstanding" read. */
  openOnly?: boolean
}

export async function listGithubIssues(
  query: ListGithubIssuesQuery = {}
): Promise<GithubIssueMirrorRow[]> {
  const db = getDb()

  let rows: GithubIssueMirrorRow[]
  if (query.repoFullName !== undefined) {
    rows = await db.githubIssueMirror.where("repoFullName").equals(query.repoFullName).toArray()
  } else if (query.issueProjectId !== undefined) {
    rows = await db.githubIssueMirror.where("issueProjectId").equals(query.issueProjectId).toArray()
  } else {
    rows = await db.githubIssueMirror.toArray()
  }

  return rows
    .filter((row) => {
      if (query.issueProjectId !== undefined && row.issueProjectId !== query.issueProjectId) {
        return false
      }
      if (query.openOnly && row.state !== "open") return false
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.number - b.number)
}

/**
 * Drop single issues from the cache — ones GitHub no longer lists under this
 * repo: transferred to another repository, or deleted. Without this a
 * transferred issue lingers on the board for good, because an incremental
 * `since` walk never mentions an issue that left.
 */
export async function deleteGithubIssues(
  repoFullName: string,
  numbers: readonly number[]
): Promise<number> {
  if (numbers.length === 0) return 0
  const ids = numbers.map((number) => githubMirrorId(repoFullName, number))
  const table = getDb().githubIssueMirror
  const present = (await table.bulkGet(ids)).filter(Boolean).length
  await table.bulkDelete(ids)
  return present
}
