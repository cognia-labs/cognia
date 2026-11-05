/**
 * Write-back for mirrored GitHub issues — comment, label, close.
 *
 * Deliberately ZERO new GitHub write paths. Every mutation routes through the
 * `github-delivery` plugin's existing `commentIssue` / `labelIssue` /
 * `closeIssue` actions, which means it inherits, for free:
 *
 *   - the integration account + credential resolution,
 *   - the PII gate on the outbound request body (`hasNoLeakingPiiDeep` in
 *     `lib/integrations/action-runner.ts`),
 *   - the audit trail, retry policy and per-account concurrency cap,
 *   - the `awaiting_approval` gate that every non-read action starts in.
 *
 * That last one is the load-bearing part. `executeIntegrationAction` parks any
 * `write`/`destructive` action in `awaiting_approval`; nothing here approves it
 * unless the caller passes `approval: "user-confirmed"`, which the UI only does
 * after the confirmation dialog has shown the user the exact payload. An
 * irreversible external write must never happen on a stray click.
 *
 * A confirmed write is also the person's under the outbound policy (ADR-0239
 * phase 2): it reaches the broker as a `person` caller, which records a human
 * receipt and is never held. An unconfirmed one is the plugin's, as before.
 *
 * Every board write-back carries an idempotency key under
 * `ISSUE_WRITEBACK_KEY_PREFIX` (the plugin's write actions require one), and
 * that prefix is how the trail finds them again: a write-back that succeeds
 * appends one `github_write_back` entry to every local issue linked to the
 * GitHub issue (`recordGithubWritebackJob`). A job that has not finished when
 * the call returns — queued for another window, or waiting on a retry — is
 * watched until it settles, and the boot sweep (`reconcileGithubWritebacks`)
 * picks up any whose window closed first. The entry is keyed by the job, so
 * the three paths record it once between them.
 */

import Dexie from "dexie"
import { loggers } from "@cognia/logging"

import {
  approveIntegrationActionJob,
  executeIntegrationAction,
} from "@/lib/integrations/action-runner"
import {
  getIntegrationActionJob,
  isIntegrationActionJobTerminal,
  listIntegrationAccounts,
} from "@/lib/db/integrations"
import { appendIssueEvent } from "@/lib/db/issue-events"
import { listIssuesByExternalKey } from "@/lib/db/issues"
import { getDb } from "@/lib/db/schema"
import { GITHUB_DOT_COM } from "@/lib/github/host"
import { githubReadAccountsFor } from "@/lib/integrations/github-read-credential"
import { externalKeyOf } from "@/types/issues"
import type { Issue, IssueActor, IssueEvent, IssueGithubRef } from "@/types/issues"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"

const log = loggers.store

export const GITHUB_DELIVERY_PLUGIN_ID = "github-delivery"
export const GITHUB_INTEGRATION_ID = "github"

/**
 * The three write-backs the board offers. Intentionally not "edit title" or
 * "reassign": those have no local equivalent to keep in step, and the board
 * greys them out via `READ_ONLY_ISSUE_CAPABILITIES` rather than pretending.
 */
export type GithubWritebackAction =
  | { kind: "comment"; body: string }
  | { kind: "label"; labels: readonly string[] }
  | { kind: "close"; reason?: "completed" | "not_planned" }

export interface GithubWritebackTarget {
  repoFullName: string
  number: number
}

/** Raised for every refusal the user can act on, with a machine-readable code. */
export class GithubWritebackError extends Error {
  readonly code: "no-account" | "plugin-unavailable" | "rejected"

  constructor(code: "no-account" | "plugin-unavailable" | "rejected", message: string) {
    super(message)
    this.name = "GithubWritebackError"
    this.code = code
    // Restores `instanceof` after a downlevel transform — see the same note in
    // `sync-runner.ts`.
    Object.setPrototypeOf(this, GithubWritebackError.prototype)
  }
}

/**
 * Issue bindings currently name public GitHub repositories. Reuse the read
 * path's host and owner selection so a newer GHES account cannot redirect a
 * write to its same-named repository. A confirmed account never falls back to
 * another account if it was removed, disabled, or disconnected meanwhile.
 */
export async function resolveGithubWritebackAccount(
  repoFullName = "",
  connectorAccountId?: string,
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext,
  connectionRef?: string
): Promise<IntegrationAccount | null> {
  const accounts = await githubReadAccountsFor(
    repoFullName,
    GITHUB_DOT_COM,
    {
      listAccounts: () => listIntegrationAccounts(GITHUB_DELIVERY_PLUGIN_ID, GITHUB_INTEGRATION_ID),
      hostForSession: async (sessionId) => {
        const { githubHostForSession } = await import("@/lib/integrations/github-auth")
        return githubHostForSession(sessionId)
      },
    },
    credentialContext
  )
  return (
    accounts.find(
      (account) =>
        (connectorAccountId === undefined || account.id === connectorAccountId) &&
        (connectionRef === undefined || account.connectionId === connectionRef)
    ) ?? null
  )
}

/**
 * Prefix of the idempotency key on every board write-back job. The rest is
 * the target, the action and a fresh attempt id: one confirmation is one
 * write, and the action runner's own retries replay the job under its key.
 */
export const ISSUE_WRITEBACK_KEY_PREFIX = "issue-writeback:"

export function issueWritebackKey(
  target: GithubWritebackTarget,
  kind: GithubWritebackAction["kind"],
  attemptId: string
): string {
  return `${ISSUE_WRITEBACK_KEY_PREFIX}${target.repoFullName}#${target.number}:${kind}:${attemptId}`
}

/** The write-back each integration action records as. */
const WRITEBACK_ACTION_BY_ID: Readonly<Record<string, GithubWritebackAction["kind"]>> = {
  commentIssue: "comment",
  labelIssue: "label",
  closeIssue: "close",
}

/** Action id + payload for the underlying integration action. */
export function toIntegrationAction(
  target: GithubWritebackTarget,
  action: GithubWritebackAction
): { actionId: string; input: Record<string, unknown> } {
  const base = { repoFullName: target.repoFullName, issueNumber: target.number }
  switch (action.kind) {
    case "comment":
      return { actionId: "commentIssue", input: { ...base, body: action.body } }
    case "label":
      return { actionId: "labelIssue", input: { ...base, labels: [...action.labels] } }
    case "close":
      return {
        actionId: "closeIssue",
        input: { ...base, reason: action.reason ?? "completed" },
      }
  }
}

export interface RunGithubWritebackInput {
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  target: GithubWritebackTarget
  action: GithubWritebackAction
  /** The account shown in the confirmation dialog, when there is one. */
  connectorAccountId?: string
  /**
   * Present ONLY when a human has confirmed this exact write in a dialog that
   * showed them the payload. Omitting it leaves the job parked in
   * `awaiting_approval` for the integrations approval surface to pick up.
   */
  approval?: "user-confirmed"
}

export interface RunGithubWritebackDeps {
  resolveAccount?: typeof resolveGithubWritebackAccount
  execute?: typeof executeIntegrationAction
  approve?: typeof approveIntegrationActionJob
  /** The attempt id in the idempotency key. Tests pass a fixed one. */
  newAttemptId?: () => string
  /** Records a succeeded job on the trail. */
  record?: (job: IntegrationActionJob) => Promise<unknown>
  /** Watches a job that has not finished yet. */
  track?: (jobId: string) => void
}

/** Statuses a job ends in without the write having landed. */
const REJECTED_JOB_STATUSES: ReadonlySet<IntegrationActionJob["status"]> = new Set([
  "failed",
  "deadlettered",
  "cancelled",
])

/**
 * Run one write-back. Resolves with the job once GitHub accepted the write
 * (`succeeded`) or the job is still on its way (`queued`, `running`,
 * `retry_wait`, `awaiting_approval`: the caller says so, and the job is
 * watched until it settles). A job that ended without the write landing
 * throws `rejected` with the runner's error, so a failure never reads as a
 * success.
 */
export async function runGithubWriteback(
  input: RunGithubWritebackInput,
  deps: RunGithubWritebackDeps = {}
): Promise<IntegrationActionJob> {
  const resolveAccount = deps.resolveAccount ?? resolveGithubWritebackAccount
  const execute = deps.execute ?? executeIntegrationAction
  const approve = deps.approve ?? approveIntegrationActionJob
  const newAttemptId = deps.newAttemptId ?? (() => crypto.randomUUID())
  const record = deps.record ?? recordGithubWritebackJob
  const track = deps.track ?? trackGithubWritebackJob

  const account = await resolveAccount(
    input.target.repoFullName,
    input.connectorAccountId,
    input.credentialContext
  )
  if (
    !account ||
    (input.connectorAccountId !== undefined && account.id !== input.connectorAccountId)
  ) {
    throw new GithubWritebackError(
      "no-account",
      "No enabled GitHub account is connected; connect one in Settings → Connections."
    )
  }

  const { actionId, input: actionInput } = toIntegrationAction(input.target, input.action)

  let job: IntegrationActionJob
  try {
    job = await execute(
      GITHUB_DELIVERY_PLUGIN_ID,
      {
        integrationId: GITHUB_INTEGRATION_ID,
        accountId: account.id,
        actionId,
        input: actionInput,
        source: "manual",
        idempotencyKey: issueWritebackKey(input.target, input.action.kind, newAttemptId()),
      },
      input.approval === "user-confirmed"
        ? {
            kind: "person",
            surface: "issue-writeback",
            localAuthorization: input.credentialContext?.localAuthorization,
          }
        : undefined,
      input.credentialContext
    )
  } catch (cause) {
    // The commonest cause by far is the plugin not being enabled, which reads
    // as an opaque "Integration is not registered" without this translation.
    throw new GithubWritebackError(
      "plugin-unavailable",
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  if (job.status === "awaiting_approval" && input.approval === "user-confirmed") {
    job = await approve(job.id)
  }
  if (REJECTED_JOB_STATUSES.has(job.status)) {
    throw new GithubWritebackError(
      "rejected",
      job.error ?? `GitHub did not accept the write (job ${job.status})`
    )
  }
  if (job.status === "succeeded") {
    // The write landed; a trail entry that fails to write is retried by the
    // boot sweep, so it must not turn a landed write into an error.
    await record(job).catch((error: unknown) =>
      log.warn("issue write-back: recording the trail entry failed", {
        jobId: job.id,
        error: String(error),
      })
    )
  } else {
    track(job.id)
  }
  return job
}

/** Whether `runGithubWriteback`'s job is still on its way rather than landed. */
export function isGithubWritebackPending(job: IntegrationActionJob): boolean {
  return job.status !== "succeeded"
}

/** The write-back person: confirmed in the dialog, or approved by a person later. */
const WRITEBACK_ACTOR: IssueActor = { kind: "human" }

function writebackTargetOf(job: IntegrationActionJob): GithubWritebackTarget | null {
  const repoFullName = job.input.repoFullName
  const number = job.input.issueNumber
  if (typeof repoFullName !== "string" || typeof number !== "number") return null
  return { repoFullName, number }
}

function isBoardWritebackJob(job: IntegrationActionJob): boolean {
  return (
    job.pluginId === GITHUB_DELIVERY_PLUGIN_ID &&
    job.integrationId === GITHUB_INTEGRATION_ID &&
    WRITEBACK_ACTION_BY_ID[job.actionId] !== undefined &&
    (job.idempotencyKey?.startsWith(ISSUE_WRITEBACK_KEY_PREFIX) ?? false)
  )
}

function githubRefFor(issue: Issue, target: GithubWritebackTarget): IssueGithubRef {
  if (
    issue.githubRef?.repoFullName === target.repoFullName &&
    issue.githubRef.number === target.number
  ) {
    return issue.githubRef
  }
  const externalId = `${target.repoFullName}#${target.number}`
  const url = issue.externalRefs?.find(
    (ref) => ref.provider === "github" && ref.externalId === externalId
  )?.url
  return {
    repoFullName: target.repoFullName,
    number: target.number,
    htmlUrl: url ?? `https://github.com/${target.repoFullName}/issues/${target.number}`,
  }
}

/**
 * Append the `github_write_back` entry for a succeeded board write-back job to
 * every local issue linked to its GitHub issue, once per job. A GitHub issue
 * nothing local links to has no trail to write to. The entry is stamped with
 * the job's own completion time, so one recorded late (by the watcher or the
 * boot sweep) still sits where the write happened.
 *
 * The check and the append share one transaction, so two windows recording
 * the same job write it once.
 */
export async function recordGithubWritebackJob(job: IntegrationActionJob): Promise<IssueEvent[]> {
  if (job.status !== "succeeded" || !isBoardWritebackJob(job)) return []
  const action = WRITEBACK_ACTION_BY_ID[job.actionId]!
  const target = writebackTargetOf(job)
  if (!target) return []
  const finishedAt = Date.parse(job.updatedAt)
  const db = getDb()
  return db.transaction("rw", db.issues, db.issueEvents, async () => {
    const issues = await listIssuesByExternalKey(
      externalKeyOf({ provider: "github", externalId: `${target.repoFullName}#${target.number}` })
    )
    const recorded: IssueEvent[] = []
    for (const issue of issues) {
      const existing = await db.issueEvents
        .where("[issueId+ts]")
        .between([issue.id, Dexie.minKey], [issue.id, Dexie.maxKey])
        .filter(
          (event) => event.payload.kind === "github_write_back" && event.payload.jobId === job.id
        )
        .first()
      if (existing) continue
      recorded.push(
        await appendIssueEvent({
          issueId: issue.id,
          payload: {
            kind: "github_write_back",
            action,
            ref: githubRefFor(issue, target),
            jobId: job.id,
            by: WRITEBACK_ACTOR,
          },
          ...(Number.isFinite(finishedAt) ? { ts: finishedAt } : {}),
        })
      )
    }
    return recorded
  })
}

/** Jobs being watched until they settle, by id. */
const tracked = new Map<string, { unsubscribe: () => void }>()

/**
 * Watch a board write-back job that has not finished, and record it if it
 * succeeds. Idempotent per job; the watch ends when the job settles or is
 * gone. A window that closes first leaves it to `reconcileGithubWritebacks`.
 */
export function trackGithubWritebackJob(jobId: string): void {
  if (tracked.has(jobId)) return
  const entry = { unsubscribe: () => {} }
  tracked.set(jobId, entry)
  const stop = () => {
    entry.unsubscribe()
    tracked.delete(jobId)
  }
  // `Dexie.liveQuery`, not the named import: see `lib/issues/notify.ts`.
  const subscription = Dexie.liveQuery(() => getIntegrationActionJob(jobId)).subscribe({
    next: (job) => {
      if (!tracked.has(jobId)) return
      if (!job) return stop()
      if (!isIntegrationActionJobTerminal(job.status)) return
      stop()
      if (job.status !== "succeeded") return
      void recordGithubWritebackJob(job).catch((error: unknown) =>
        log.warn("issue write-back: recording a settled job failed", {
          jobId,
          error: String(error),
        })
      )
    },
    error: (error: unknown) => {
      stop()
      log.warn("issue write-back: watching a job failed", { jobId, error: String(error) })
    },
  })
  entry.unsubscribe = () => subscription.unsubscribe()
}

/** Stop every watch. The boot teardown calls it. */
export function stopGithubWritebackTracking(): void {
  for (const entry of [...tracked.values()]) entry.unsubscribe()
  tracked.clear()
}

/**
 * Boot sweep: record every succeeded board write-back the trail is missing,
 * and watch the ones still on their way. Covers a window that closed between
 * a write and its settle.
 */
export async function reconcileGithubWritebacks(): Promise<{
  recorded: number
  tracking: number
}> {
  const jobs = await getDb()
    .integrationActionJobs.where("[pluginId+integrationId]")
    .equals([GITHUB_DELIVERY_PLUGIN_ID, GITHUB_INTEGRATION_ID])
    .toArray()
  let recorded = 0
  let tracking = 0
  for (const job of jobs) {
    if (!isBoardWritebackJob(job)) continue
    if (job.status === "succeeded") {
      recorded += (await recordGithubWritebackJob(job)).length
    } else if (!isIntegrationActionJobTerminal(job.status)) {
      trackGithubWritebackJob(job.id)
      tracking += 1
    }
  }
  return { recorded, tracking }
}

export interface CreateGithubIssueInput {
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  repoFullName: string
  title: string
  body?: string
  /**
   * Stable per (local issue, repository): a retry of the same publish is
   * deduplicated by the action runner instead of opening a second issue.
   */
  idempotencyKey: string
}

export interface CreatedGithubIssue {
  repoFullName: string
  number: number
  htmlUrl: string
  /** Epoch ms of the remote's `updated_at`, when GitHub reported one. */
  updatedAt?: number
}

/**
 * Open a GitHub issue through the `github-delivery` `createIssue` action.
 *
 * Only ever called after a person confirmed the exact title and body in a
 * dialog, so the job is approved in the same step — the same contract as
 * `runGithubWriteback` with `approval: "user-confirmed"`. Anything short of a
 * completed job (the plugin refused, GitHub failed) is an error, because the
 * caller links the local issue to the result and there is no result to link.
 */
export async function createGithubIssue(
  input: CreateGithubIssueInput,
  deps: RunGithubWritebackDeps = {}
): Promise<CreatedGithubIssue> {
  const resolveAccount = deps.resolveAccount ?? resolveGithubWritebackAccount
  const execute = deps.execute ?? executeIntegrationAction
  const approve = deps.approve ?? approveIntegrationActionJob

  const account = await resolveAccount(input.repoFullName, undefined, input.credentialContext)
  if (!account) {
    throw new GithubWritebackError(
      "no-account",
      "No enabled GitHub account is connected; connect one in Settings → Connections."
    )
  }

  let job: IntegrationActionJob
  try {
    job = await execute(
      GITHUB_DELIVERY_PLUGIN_ID,
      {
        integrationId: GITHUB_INTEGRATION_ID,
        accountId: account.id,
        actionId: "createIssue",
        input: {
          repoFullName: input.repoFullName,
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
        },
        source: "manual",
        idempotencyKey: input.idempotencyKey,
      },
      // Only ever called after a person confirmed the issue in a dialog.
      {
        kind: "person",
        surface: "issue-publish",
        localAuthorization: input.credentialContext?.localAuthorization,
      },
      input.credentialContext
    )
  } catch (cause) {
    throw new GithubWritebackError(
      "plugin-unavailable",
      cause instanceof Error ? cause.message : String(cause)
    )
  }
  if (job.status === "awaiting_approval") job = await approve(job.id)
  const output = job.output as
    { number?: unknown; html_url?: unknown; updated_at?: unknown } | undefined
  if (job.status !== "succeeded" || typeof output?.number !== "number") {
    throw new GithubWritebackError(
      "rejected",
      job.error ?? `GitHub did not create the issue (job ${job.status})`
    )
  }
  const updatedAt = typeof output.updated_at === "string" ? Date.parse(output.updated_at) : NaN
  return {
    repoFullName: input.repoFullName,
    number: output.number,
    htmlUrl:
      typeof output.html_url === "string"
        ? output.html_url
        : `https://github.com/${input.repoFullName}/issues/${output.number}`,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }
}
