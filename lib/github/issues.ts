/**
 * GitHub issue reads — the half of the API this repo never had.
 *
 * Before this module, `plugins/github-delivery` could comment, label and close
 * an issue but could not LIST one: there was no `listForRepo`, no search, no
 * cursor'd fetch, and no GraphQL client at all. This adds the read path the
 * issue mirror needs, and nothing else.
 *
 * Conventions are lifted from `lib/github/pr-observe/fetch.ts`, the only real
 * caching layer in the codebase:
 *   - `OctokitLike` keeps the fetch logic decoupled from `@octokit/core`, so
 *     tests inject a plain object.
 *   - `safeRequest` normalises both throw-based and resolve-based 304 into
 *     a resolved `{status}` with no body.
 *   - ETag conditional requests: a 304 means "reuse what you have", which is
 *     the whole reason `proxyFetch` had to stop throwing on null-body statuses.
 *
 * Pull requests are excluded: GitHub's issues endpoint returns PRs too (they
 * carry a `pull_request` key), and mixing them onto an issue board is noise —
 * the PR surface already exists in `lib/github/pr-observe/`.
 */

import {
  ExternalSyncRateLimited,
  ExternalSyncCursorInvalid,
  type ExternalSyncMode,
} from "@/lib/external-services/sync/types"

import type {
  GithubIssueMirrorRow,
  GithubIssueState,
  GithubIssueStateReason,
} from "@/lib/db/github-issue-mirror-types"
import { githubMirrorId } from "@/lib/db/github-issue-mirror"

/** Minimal surface we need from Octokit — see `pr-observe/types.ts`. */
export interface OctokitLike {
  request(
    route: string,
    params?: Record<string, unknown>
  ): Promise<{
    status: number
    headers: Record<string, string | undefined>
    data: unknown
  }>
}

/** GitHub caps `per_page` at 100; anything larger is silently clamped anyway. */
export const ISSUES_PER_PAGE = 100

/**
 * Bound API spend and memory at 100,000 raw records (including PRs). Reaching
 * this guard fails the whole read; partial rows must never advance a watermark.
 */
export const MAX_ISSUE_PAGES = 1_000

export interface FetchRepoIssuesOptions {
  /** `owner/repo`. */
  repoFullName: string
  /** ISO-8601 watermark; overlapped by one second to include boundary updates. */
  since?: string
  /** ETag from a complete single-page fetch with the exact same query. */
  etag?: string
  /** Delivery container to stamp on the mirrored rows. */
  issueProjectId?: string
  /** Injected for tests; defaults to `Date.now()`. */
  now?: number
}

export interface FetchRepoIssuesResult {
  /** Empty when `notModified` is true. */
  rows: GithubIssueMirrorRow[]
  /** True when GitHub answered 304 — the cache is already current. */
  notModified: boolean
  /** ETag to persist for the next conditional fetch. */
  etag?: string
  /** Incomplete reads throw; retained for the shared sync result contract. */
  truncated: boolean
  /** Rate-limit budget left, surfaced so callers can back off. */
  rateLimitRemaining?: number
}

/**
 * Normalise a request into a resolved result. Octokit throws for non-2xx by
 * default, and 304 is not an error here — it is the successful outcome of a
 * conditional request.
 */
async function safeRequest(
  octokit: OctokitLike,
  route: string,
  params: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string | undefined>; data: unknown }> {
  try {
    return await rateAwareOctokit(octokit).request(route, params)
  } catch (error) {
    const status =
      error !== null && typeof error === "object" && "status" in error
        ? Number((error as { status: unknown }).status)
        : NaN
    if (status === 304) {
      const headers =
        error !== null && typeof error === "object" && "response" in error
          ? ((error as { response?: { headers?: Record<string, string | undefined> } }).response
              ?.headers ?? {})
          : {}
      return { status, headers, data: [] }
    }
    throw error
  }
}

interface RawGithubIssue {
  number: number
  title: string
  body?: string | null
  state: string
  state_reason?: string | null
  html_url: string
  comments?: number
  created_at: string
  updated_at: string
  closed_at?: string | null
  user?: { login?: string } | null
  assignees?: Array<{ login?: string } | null> | null
  labels?: Array<{ name?: string; color?: string } | string | null> | null
  /** Present iff this "issue" is actually a pull request. */
  pull_request?: unknown
  milestone?: { number?: number; title?: string } | null
}

function toEpoch(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

function normalizeState(state: string): GithubIssueState {
  return state === "closed" ? "closed" : "open"
}

function normalizeStateReason(
  value: string | null | undefined
): GithubIssueStateReason | undefined {
  if (value === "completed" || value === "not_planned" || value === "reopened") return value
  return undefined
}

/** Project one API issue into a mirror row. Exported for direct unit testing. */
export function toMirrorRow(
  raw: RawGithubIssue,
  context: { repoFullName: string; issueProjectId?: string; etag?: string; syncedAt: number }
): GithubIssueMirrorRow {
  const labels = (raw.labels ?? [])
    .map((label) => {
      if (typeof label === "string") return { name: label }
      if (label && typeof label.name === "string") {
        return label.color ? { name: label.name, color: label.color } : { name: label.name }
      }
      return null
    })
    .filter((label): label is { name: string; color?: string } => label !== null)

  return {
    id: githubMirrorId(context.repoFullName, raw.number),
    repoFullName: context.repoFullName,
    number: raw.number,
    ...(context.issueProjectId ? { issueProjectId: context.issueProjectId } : {}),
    title: raw.title,
    ...(raw.body ? { body: raw.body } : {}),
    state: normalizeState(raw.state),
    ...(normalizeStateReason(raw.state_reason)
      ? { stateReason: normalizeStateReason(raw.state_reason) }
      : {}),
    ...(raw.user?.login ? { authorLogin: raw.user.login } : {}),
    assigneeLogins: (raw.assignees ?? [])
      .map((assignee) => assignee?.login)
      .filter((login): login is string => Boolean(login)),
    labels,
    htmlUrl: raw.html_url,
    ...(typeof raw.milestone?.number === "number" ? { milestoneNumber: raw.milestone.number } : {}),
    ...(raw.milestone?.title ? { milestoneTitle: raw.milestone.title } : {}),
    commentCount: raw.comments ?? 0,
    createdAt: toEpoch(raw.created_at) ?? context.syncedAt,
    updatedAt: toEpoch(raw.updated_at) ?? context.syncedAt,
    ...(toEpoch(raw.closed_at) !== undefined ? { closedAt: toEpoch(raw.closed_at) } : {}),
    syncedAt: context.syncedAt,
    ...(context.etag ? { etag: context.etag } : {}),
  }
}

/** Does the Link header advertise another page? */
export function hasNextPage(link: string | undefined): boolean {
  return typeof link === "string" && /<[^>]+>;\s*rel="next"/.test(link)
}

/**
 * Fetch a repo's complete issue listing, or fail without publishing partial rows.
 *
 * The ETag is only meaningful for the FIRST page — that is what a conditional
 * request revalidates. Only callers with a complete single-page cache for the
 * same query may provide one. Multipage results never retain that ETag.
 */
export async function fetchRepoIssues(
  octokit: OctokitLike,
  options: FetchRepoIssuesOptions
): Promise<FetchRepoIssuesResult> {
  const [owner, repo] = options.repoFullName.split("/")
  if (!owner || !repo) {
    throw new Error(`Invalid repository: ${options.repoFullName}`)
  }

  const syncedAt = options.now ?? Date.now()
  const rows: GithubIssueMirrorRow[] = []
  let pageEtag: string | undefined
  let rateLimitRemaining: number | undefined
  // GitHub documents `since` as "after", with second-resolution timestamps.
  // An overlap also covers another update sharing the last observed second.
  const since = options.since
    ? new Date(Date.parse(options.since) - 1_000).toISOString()
    : undefined

  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const conditional = page === 1 && options.etag ? { "if-none-match": options.etag } : {}
    const response = await safeRequest(octokit, "GET /repos/{owner}/{repo}/issues", {
      owner,
      repo,
      state: "all",
      sort: "created",
      direction: "asc",
      per_page: ISSUES_PER_PAGE,
      page,
      ...(since ? { since } : {}),
      headers: { ...conditional },
    })

    const remaining = response.headers["x-ratelimit-remaining"]
    if (remaining !== undefined) rateLimitRemaining = Number(remaining)

    if (page === 1) {
      if (response.status === 304 && options.etag) {
        return {
          rows: [],
          notModified: true,
          ...(options.etag ? { etag: options.etag } : {}),
          truncated: false,
          ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
        }
      }
      pageEtag = response.headers.etag
    }

    if (response.status !== 200) {
      throw Object.assign(new Error(`GitHub issues request failed (HTTP ${response.status})`), {
        status: response.status,
      })
    }
    if (!Array.isArray(response.data)) {
      throw new Error("Invalid GitHub issues response: expected an array")
    }
    const batch = response.data as RawGithubIssue[]
    for (const raw of batch) {
      // GitHub's issues endpoint returns pull requests too; they belong to the
      // PR surface, not the issue board.
      if (raw.pull_request) continue
      rows.push(
        toMirrorRow(raw, {
          repoFullName: options.repoFullName,
          ...(options.issueProjectId ? { issueProjectId: options.issueProjectId } : {}),
          syncedAt,
        })
      )
    }

    if (!hasNextPage(response.headers.link)) {
      const etag = page === 1 ? pageEtag : undefined
      if (etag) for (const row of rows) row.etag = etag
      return {
        rows,
        notModified: false,
        ...(etag ? { etag } : {}),
        truncated: false,
        ...(rateLimitRemaining !== undefined ? { rateLimitRemaining } : {}),
      }
    }
  }

  throw new Error(`GitHub issue listing incomplete: page limit (${MAX_ISSUE_PAGES}) reached`)
}

function githubRateLimit(error: {
  status?: number
  headers?: Record<string, string | undefined>
  data?: unknown
  message?: string
}): ExternalSyncRateLimited | undefined {
  const headers = Object.fromEntries(
    Object.entries(error.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  const message =
    error.data && typeof error.data === "object" && "message" in error.data
      ? String(error.data.message)
      : (error.message ?? "")
  if (
    error.status !== 429 &&
    !(
      error.status === 403 &&
      (headers["x-ratelimit-remaining"] === "0" || /secondary rate limit/i.test(message))
    )
  )
    return undefined
  const retry = headers["retry-after"]
  const delay = retry
    ? /^\d+(?:\.\d+)?$/.test(retry.trim())
      ? Number(retry) * 1000
      : Date.parse(retry) - Date.now()
    : NaN
  const reset = Number(headers["x-ratelimit-reset"]) * 1000 - Date.now()
  return new ExternalSyncRateLimited(
    Number.isFinite(delay) && delay >= 0
      ? delay
      : Number.isFinite(reset) && reset >= 0
        ? reset
        : 60_000
  )
}

class GithubSyncHttpError extends Error {
  constructor(readonly status: number) {
    super("GitHub sync request failed")
  }
}

export function rateAwareOctokit(octokit: OctokitLike): OctokitLike {
  return {
    request: async (route, params) => {
      try {
        const response = await octokit.request(route, params)
        const limited = githubRateLimit(response)
        if (limited) throw limited
        if (response.status >= 400) throw new GithubSyncHttpError(response.status)
        return response
      } catch (error) {
        if (error && typeof error === "object") {
          const value = error as {
            status?: number
            response?: { headers?: Record<string, string | undefined>; data?: unknown }
            message?: string
          }
          const limited = githubRateLimit({
            status: value.status,
            ...value.response,
            message: value.message,
          })
          if (limited) throw limited
        }
        throw error
      }
    },
  }
}

/** P8b keyset checkpoint shared by imports and the disposable mirror. */
export interface GithubIssuePageToken {
  since: number
  page: number
  floor?: number
  max?: number
}

function githubIssuePageToken(input: {
  mode: ExternalSyncMode
  cursor?: string
  page?: string
}): GithubIssuePageToken {
  const previous = Number(input.cursor ?? 0)
  let token: GithubIssuePageToken
  try {
    token = input.page
      ? JSON.parse(input.page)
      : { since: input.mode === "full" ? 0 : previous, page: 1 }
  } catch {
    throw new ExternalSyncCursorInvalid()
  }
  if (
    !Number.isFinite(previous) ||
    previous < 0 ||
    !token ||
    !Number.isFinite(token.since) ||
    token.since < 0 ||
    !Number.isSafeInteger(token.page) ||
    token.page < 1 ||
    (token.floor !== undefined &&
      (!Number.isFinite(token.floor) || token.floor < 0 || token.floor > token.since)) ||
    (token.max !== undefined && (!Number.isFinite(token.max) || token.max < 0))
  )
    throw new ExternalSyncCursorInvalid()
  return token
}

/** A tie-bucket offset can shift when rows leave: never infer mirror deletions from it. */
export function githubIssuePageUsedOffset(page: string): boolean {
  try {
    const token = JSON.parse(page) as GithubIssuePageToken
    return token.page > 1 || token.floor !== undefined
  } catch {
    return true
  }
}

export async function fetchGithubIssuePage(
  octokit: OctokitLike,
  input: {
    repoFullName: string
    mode: ExternalSyncMode
    cursor?: string
    page?: string
    signal?: AbortSignal
  }
): Promise<{
  raw: RawGithubIssue[]
  nextPage?: string
  cursor?: string
  rateLimitRemaining?: number
}> {
  const [owner, repo] = input.repoFullName.split("/")
  if (!owner || !repo) throw new Error(`Invalid repository: ${input.repoFullName}`)
  const token = githubIssuePageToken(input)
  const previous = Number(input.cursor ?? 0)
  const response = await rateAwareOctokit(octokit).request("GET /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "asc",
    per_page: ISSUES_PER_PAGE,
    page: token.page,
    since: new Date(Math.max(0, token.since - 1000)).toISOString(),
    request: { signal: input.signal },
  })
  if (response.status !== 200)
    throw new Error(`GitHub issues request failed (HTTP ${response.status})`)
  if (!Array.isArray(response.data)) throw new Error("Invalid GitHub issue page")
  const raw = response.data as RawGithubIssue[]
  for (const row of raw) {
    if (!row.pull_request && !Number.isFinite(Date.parse(row.updated_at)))
      throw new Error("GitHub issue update time missing")
  }
  // PR-only pages still carry the newest timestamp forward.
  const pageMax = raw.reduce((max, row) => {
    const updated = Date.parse(row.updated_at)
    return Number.isFinite(updated) ? Math.max(max, updated) : max
  }, token.max ?? 0)
  let floor = token.page > 1 ? Math.min(token.floor ?? token.since, token.since) : token.floor
  let nextPage: string | undefined
  if (hasNextPage(response.headers.link)) {
    const boundary = Date.parse(raw.at(-1)?.updated_at ?? "")
    if (!Number.isFinite(boundary)) throw new Error("GitHub issue page boundary missing")
    if (boundary <= token.since) floor = Math.min(floor ?? token.since, token.since)
    nextPage = JSON.stringify({
      ...(boundary > token.since
        ? { since: boundary, page: 1 }
        : { since: token.since, page: token.page + 1 }),
      ...(floor !== undefined ? { floor } : {}),
      ...(pageMax > 0 ? { max: pageMax } : {}),
    })
  }
  input.signal?.throwIfAborted()
  // Preserve P8b-1's earliest tie floor so a later pass replays that bucket.
  const cursor = String(Math.min(Math.max(previous, pageMax), floor ?? Infinity))
  const remaining = response.headers["x-ratelimit-remaining"]
  return {
    raw,
    ...(nextPage ? { nextPage } : { cursor }),
    ...(remaining !== undefined ? { rateLimitRemaining: Number(remaining) } : {}),
  }
}
