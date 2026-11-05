/**
 * IssueRunRegistry — the run adapters and the orchestration around them.
 *
 * Shape follows `lib/scheduler/task-scheduler.ts:registerTaskExecutor`
 * (last-write-wins registration + registration-wait listeners, because
 * adapters register from deferred boot chunks). It deliberately does NOT
 * follow `lib/issues/sources/registry.ts`'s swallow-and-report `listAll`: a
 * dispatch that fails must fail loudly, never turn into a silent queued row.
 *
 * The orchestrations live here because every entry point (detail panel Run
 * button, IM card, wakeups, reconciler) must apply the same ownership rules:
 *   - `startIssueRun`   — refuse, claim the issue (`claimIssueRun`, the start
 *                          lock), dispatch, then bind what the engine accepted
 *                          and take `in_progress` in one transaction. A
 *                          dispatch that throws settles the claim as failed,
 *                          leaves the issue where it was, and rethrows.
 *   - `settleIssueRunAndIssue` — settle the row, link the PRs it produced and
 *                          advance the issue to `in_review` (or hand it back to
 *                          `statusBefore` on cancel) in one transaction.
 *                          NEVER to `done`.
 *   - `reconcileIssueRuns` — poll every bound active run through its adapter;
 *                          the recovery path after a reload, and the fan-in for
 *                          the engine-table watchers in `install.ts`.
 *   - `repairStrandedIssues` — once at boot, finish the issue half of a settle
 *                          that a crash interrupted before settles were atomic.
 */

import type {
  IssueActor,
  IssueRun,
  IssueRunKind,
  IssueRunWakeup,
  IssueStatus,
} from "@/types/issues"
import { isActiveIssueRunStatus } from "@/types/issues"
import {
  applyRuntimeIssueStatus,
  getIssue,
  handBackRuntimeIssueStatus,
  linkIssueExternal,
  listIssues,
} from "@/lib/db/issues"
import { listIssueEvents } from "@/lib/db/issue-events"
import { getDb } from "@/lib/db/schema"
import { openBlockers } from "@/lib/issues/relations"
import { linkRunPullRequests, type LinkRunPullRequestsDeps } from "@/lib/issues/pull-requests"
import { getIssueProject } from "@/lib/db/issue-projects"
import {
  bindIssueRunDispatch,
  claimIssueRun,
  getIssueRun,
  hasActiveIssueRun,
  isUnboundIssueRun,
  IssueRunActiveError,
  ISSUE_RUN_DISPATCH_STALE_MS,
  listIssueRuns,
  markIssueRunRunning,
  settleIssueRun,
  type IssueRunDispatch,
  type SettleIssueRunInput,
} from "@/lib/db/issue-runs"
import type {
  IssueRunAdapter,
  IssueRunConversation,
  IssueRunOrigin,
  IssueRunRefusalReason,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"
import { isNamedRunOrigin } from "./types"

/** Raised by `startIssueRun` for a policy refusal — machine-readable, i18n at the UI. */
export class IssueRunRefusedError extends Error {
  readonly reason: IssueRunRefusalReason
  readonly detail?: string

  constructor(reason: IssueRunRefusalReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = "IssueRunRefusedError"
    this.reason = reason
    if (detail) this.detail = detail
    Object.setPrototypeOf(this, IssueRunRefusedError.prototype)
  }
}

export class IssueRunRegistry {
  private readonly adapters = new Map<string, IssueRunAdapter>()
  private readonly waiters = new Set<() => void>()

  register(adapter: IssueRunAdapter): void {
    this.adapters.set(adapter.id, adapter)
    for (const waiter of this.waiters) waiter()
  }

  unregister(id: string): void {
    this.adapters.delete(id)
  }

  get(id: string): IssueRunAdapter | undefined {
    return this.adapters.get(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  list(): ReadonlyArray<IssueRunAdapter> {
    return Array.from(this.adapters.values())
  }

  listByKind(kind: IssueRunKind): ReadonlyArray<IssueRunAdapter> {
    return this.list().filter((adapter) => adapter.kind === kind)
  }

  clear(): void {
    this.adapters.clear()
  }

  /**
   * Resolve when `id` is registered, or after `timeoutMs`. Mirrors
   * `waitForTaskExecutor`: an IM callback that lands before the deferred boot
   * chunk registered the adapters waits briefly instead of failing.
   */
  waitFor(id: string, timeoutMs: number): Promise<boolean> {
    if (this.adapters.has(id)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        this.waiters.delete(check)
        clearTimeout(timer)
        resolve(value)
      }
      const check = () => {
        if (this.adapters.has(id)) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.waiters.add(check)
    })
  }
}

let singleton: IssueRunRegistry | null = null

export function getIssueRunRegistry(): IssueRunRegistry {
  if (!singleton) singleton = new IssueRunRegistry()
  return singleton
}

/** Test-only. */
export function resetIssueRunRegistry(): void {
  singleton = null
}

export function registerIssueRunAdapter(
  adapter: IssueRunAdapter,
  registry: IssueRunRegistry = getIssueRunRegistry()
): void {
  registry.register(adapter)
}

/** Load the target an adapter decides on. */
export async function loadIssueRunTarget(
  issueId: string,
  credentialContext?: IssueRunTarget["credentialContext"]
): Promise<IssueRunTarget | undefined> {
  const issue = await getIssue(issueId)
  if (!issue) return undefined
  const project = await getIssueProject(issue.issueProjectId)
  return { issue, project, ...(credentialContext ? { credentialContext } : {}) }
}

export interface IssueRunOption {
  adapter: IssueRunAdapter
  verdict: IssueRunVerdict
}

/**
 * Every registered adapter's verdict for an issue — what the Run dialog lists.
 * Tracker-level refusals (`issue-finished`, `run-active`) apply to all
 * adapters and are returned as such so the dialog can explain itself once.
 */
export async function listIssueRunOptions(
  issueId: string,
  registry: IssueRunRegistry = getIssueRunRegistry(),
  origin: IssueRunOrigin = "interactive",
  credentialContext?: IssueRunTarget["credentialContext"]
): Promise<IssueRunOption[]> {
  const target = await loadIssueRunTarget(issueId, credentialContext)
  if (!target) return []
  const blanket = await trackerVerdict(target, origin)
  const adapters = registry.list()
  return Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      verdict: blanket.ok ? await adapter.canRun(target) : blanket,
    }))
  )
}

async function trackerVerdict(
  target: IssueRunTarget,
  origin: IssueRunOrigin
): Promise<IssueRunVerdict> {
  const { issue } = target
  if (issue.statusCategory === "completed" || issue.statusCategory === "canceled") {
    return { ok: false, reason: "issue-finished" }
  }
  if (issue.triage === "pending" && !isNamedRunOrigin(origin)) {
    return { ok: false, reason: "issue-in-triage" }
  }
  if (await hasActiveIssueRun(issue.id)) return { ok: false, reason: "run-active" }
  // A human may still drag a blocked issue anywhere (the tracker does not
  // argue), but dispatching an agent onto work that waits on other work is
  // wasted effort, so the engines refuse it and say which issues stand in
  // the way.
  if (issue.blockedBy?.length) {
    const rows = await listIssues({ projectId: issue.projectId })
    const blockers = openBlockers(issue, new Map(rows.map((row) => [row.id, row])))
    if (blockers.length > 0) {
      return {
        ok: false,
        reason: "blocked",
        detail: blockers.map((blocker) => blocker.identifier).join(", "),
      }
    }
  }
  return { ok: true }
}

export interface StartIssueRunInput {
  credentialContext?: IssueRunTarget["credentialContext"]
  issueId: string
  adapterId: string
  by: IssueActor
  origin: IssueRunOrigin
  /** The IM thread behind an `im` origin, so an engine can ask there. */
  conversation?: IssueRunConversation
  options?: Readonly<Record<string, unknown>>
  /** Text appended to what the engine receives. See `IssueRunStartContext.brief`. */
  brief?: string
  /** Lineage when an issue wakeup is the caller. */
  wakeup?: IssueRunWakeup
}

/**
 * Refuse-or-dispatch. Throws `IssueRunRefusedError` for a policy refusal
 * (including `run-active` when another dispatch won the claim) and rethrows
 * engine failures untouched after settling the claim as failed. On success
 * the engine accepted the work, the issue is `in_progress`, and the returned
 * run row is active and bound to the engine item.
 *
 * When a cancel lands while the engine is accepting, the bind finds the claim
 * already settled: the engine item that was just created is cancelled too,
 * and the settled (cancelled) row is returned.
 */
export async function startIssueRun(
  input: StartIssueRunInput,
  registry: IssueRunRegistry = getIssueRunRegistry()
): Promise<IssueRun> {
  const adapter = registry.get(input.adapterId)
  if (!adapter) throw new IssueRunRefusedError("adapter-missing", input.adapterId)

  const target = await loadIssueRunTarget(input.issueId, input.credentialContext)
  if (!target) throw new Error(`Issue not found: ${input.issueId}`)

  const blanket = await trackerVerdict(target, input.origin)
  if (!blanket.ok) throw new IssueRunRefusedError(blanket.reason, blanket.detail)
  const verdict = await adapter.canRun(target)
  if (!verdict.ok) throw new IssueRunRefusedError(verdict.reason, verdict.detail)

  let claim: IssueRun
  try {
    claim = await claimIssueRun({
      issueId: target.issue.id,
      projectId: target.issue.projectId,
      adapterId: adapter.id,
      kind: adapter.kind,
      by: input.by,
      ...(input.wakeup ? { wakeup: input.wakeup } : {}),
    })
  } catch (error) {
    if (error instanceof IssueRunActiveError) throw new IssueRunRefusedError("run-active")
    throw error
  }

  let dispatch: IssueRunDispatch
  try {
    dispatch = await adapter.start(target, {
      runId: claim.id,
      by: input.by,
      origin: input.origin,
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.options ? { options: input.options } : {}),
      ...(input.brief ? { brief: input.brief } : {}),
      ...(input.wakeup ? { wakeup: input.wakeup } : {}),
    })
  } catch (error) {
    // The issue never left its column (it moves only once the engine
    // accepted), so settling the claim is the whole cleanup.
    await settleIssueRun(claim.id, { status: "failed", error: dispatchErrorText(error) })
    throw error
  }

  const bound = await acceptIssueRunDispatch(claim.id, dispatch, input.by)
  if (bound) return bound
  const settled = await getIssueRun(claim.id)
  if (adapter.cancel && settled) {
    await adapter.cancel({ ...settled, targetId: dispatch.targetId, ...targetRefOf(dispatch) })
  }
  if (!settled) throw new Error(`Issue run ${claim.id} vanished during dispatch`)
  return settled
}

function targetRefOf(dispatch: IssueRunDispatch): Pick<IssueRun, "targetRef"> {
  return dispatch.targetRef ? { targetRef: dispatch.targetRef } : {}
}

/** The text a failed dispatch leaves on its run row. */
function dispatchErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim() || "dispatch failed"
}

/**
 * Bind what the engine accepted onto the claim and give the runtime the
 * column, in one transaction. `statusBefore` is read from the issue here,
 * just before it moves: a person may have moved it between the claim and
 * the engine's answer (any column but `in_progress`, which the claim holds).
 * Returns `undefined` when the claim was settled meanwhile (a cancel).
 */
async function acceptIssueRunDispatch(
  runId: string,
  dispatch: IssueRunDispatch,
  by: IssueActor
): Promise<IssueRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.issueRuns, db.issues, db.issueEvents, async () => {
    const claim = await db.issueRuns.get(runId)
    if (!claim || !isActiveIssueRunStatus(claim.status)) return undefined
    const issue = await db.issues.get(claim.issueId)
    const bound = await bindIssueRunDispatch(runId, dispatch, issue?.status)
    if (!bound) return undefined
    await applyRuntimeIssueStatus(claim.issueId, "in_progress", by)
    return bound
  })
}

/** The runtime actor stamped on status changes the bridge makes on an engine's behalf. */
export function runtimeActorFor(run: IssueRun): IssueActor {
  return {
    kind: run.kind === "agent-team" ? "team" : "agent",
    id: run.targetId,
    label: run.adapterId,
  }
}

/** The column a run took its issue from, for a hand-back. */
export function runStatusBefore(run: IssueRun): IssueStatus | undefined {
  return run.statusBefore ?? run.wakeup?.statusBefore
}

const LINK_PULL_REQUEST_DEPS: LinkRunPullRequestsDeps = {
  getIssue,
  link: linkIssueExternal,
}

/**
 * Settle a run and move its issue on, in ONE transaction: the row, the PRs
 * among its artifacts (`linkRunPullRequests`, so an until-pr wakeup sees a PR
 * the run opened even when its text never names the issue), and the issue's
 * column. Success and failure both advance to `in_review` — either way a
 * human has to look; a cancel hands the issue back to the column the run
 * took it from (`handBackRuntimeIssueStatus`). A crash can no longer leave a
 * terminal run beside an issue stuck in `in_progress`.
 *
 * Idempotent: an already-settled run returns `undefined` and touches nothing.
 */
export async function settleIssueRunAndIssue(
  runId: string,
  settlement: SettleIssueRunInput,
  now = Date.now()
): Promise<IssueRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.issueRuns, db.issues, db.issueEvents, async () => {
    const settled = await settleIssueRun(runId, settlement, now)
    if (!settled) return undefined
    const actor = runtimeActorFor(settled)
    await linkRunPullRequests(settled.issueId, settled.artifacts, actor, LINK_PULL_REQUEST_DEPS)
    if ("mode" in settlement || settled.status === "cancelled") {
      await handBackRuntimeIssueStatus(settled.issueId, runStatusBefore(settled), actor)
    } else {
      await applyRuntimeIssueStatus(settled.issueId, "in_review", actor)
    }
    return settled
  })
}

export interface ReconcileIssueRunsResult {
  polled: number
  settled: string[]
  /** Runs whose adapter threw during `poll`; left active for the next pass. */
  errored: Array<{ runId: string; error: unknown }>
}

/**
 * Poll every bound active run through its adapter and settle the terminal
 * ones. A run whose adapter is no longer registered is settled as failed — an
 * engine we cannot ask cannot keep owning an `in_progress` column forever.
 *
 * A claim not yet bound to an engine item is a dispatch in flight and is not
 * polled (its adapter would look up an empty id). Once it is older than
 * `ISSUE_RUN_DISPATCH_STALE_MS` the dispatch was interrupted — the window
 * closed between claim and acceptance — and the claim is settled as failed;
 * its issue never left its column, so nothing else moves.
 */
export async function reconcileIssueRuns(
  registry: IssueRunRegistry = getIssueRunRegistry(),
  now = Date.now()
): Promise<ReconcileIssueRunsResult> {
  const active = await listIssueRuns({ activeOnly: true })
  const result: ReconcileIssueRunsResult = { polled: 0, settled: [], errored: [] }
  for (const run of active) {
    if (isUnboundIssueRun(run)) {
      if (now - run.startedAt > ISSUE_RUN_DISPATCH_STALE_MS) {
        await settleIssueRun(
          run.id,
          { status: "failed", error: "dispatch interrupted before the engine accepted it" },
          now
        )
        result.settled.push(run.id)
      }
      continue
    }
    result.polled += 1
    const adapter = registry.get(run.adapterId)
    if (!adapter) {
      await settleIssueRunAndIssue(
        run.id,
        { status: "failed", error: `run adapter "${run.adapterId}" is not registered` },
        now
      )
      result.settled.push(run.id)
      continue
    }
    try {
      const outcome = await adapter.poll(run)
      if (!outcome) continue
      if (outcome.status === "running") {
        if (run.status === "queued") await markIssueRunRunning(run.id, now)
        continue
      }
      if (await settleIssueRunAndIssue(run.id, outcome, now)) result.settled.push(run.id)
    } catch (error) {
      result.errored.push({ runId: run.id, error })
    }
  }
  return result
}

/**
 * User-initiated cancel: engine cancel, then settle as cancelled (which hands
 * the issue back to the column the run took it from). A claim whose engine
 * has not accepted yet has nothing to cancel engine-side; `startIssueRun`
 * finds it settled when the engine answers and cancels the item it got.
 * Returns the settled run, or `undefined` if it was already terminal/missing.
 */
export async function cancelIssueRun(
  runId: string,
  registry: IssueRunRegistry = getIssueRunRegistry(),
  now = Date.now()
): Promise<IssueRun | undefined> {
  const run = await getIssueRun(runId)
  if (!run || !isActiveIssueRunStatus(run.status)) return undefined
  const adapter = registry.get(run.adapterId)
  if (adapter?.cancel && !isUnboundIssueRun(run)) await adapter.cancel(run)
  return settleIssueRunAndIssue(runId, { status: "cancelled" }, now)
}

/**
 * Sessions the run is executing in, newest first, or `[]` when it is not
 * active or its adapter cannot say (`IssueRunAdapter.sessionIds`).
 */
export async function issueRunSessionIds(
  run: IssueRun,
  registry: IssueRunRegistry = getIssueRunRegistry()
): Promise<string[]> {
  if (!isActiveIssueRunStatus(run.status)) return []
  const adapter = registry.get(run.adapterId)
  if (!adapter?.sessionIds) return []
  return adapter.sessionIds(run)
}

export interface SteerIssueRunDeps {
  registry?: IssueRunRegistry
  /** Defaults to `steerSession` in `lib/claude/ipc`, which runs its own PII gate. */
  steer?: (sessionId: string, text: string) => Promise<unknown>
}

/**
 * Deliver `text` into an active run's live session. Resolves `true` when the
 * session acknowledged it, `false` when the run has no steerable session or
 * the steer was refused (provider without a live-input lane, PII gate, the
 * turn already closed its input). Never throws for a refusal: the caller has
 * a fallback, and a refusal is the ordinary case for two of three engines.
 */
export async function steerIssueRun(
  run: IssueRun,
  text: string,
  deps: SteerIssueRunDeps = {}
): Promise<boolean> {
  const sessions = await issueRunSessionIds(run, deps.registry)
  const sessionId = sessions[0]
  if (!sessionId) return false
  const steer =
    deps.steer ??
    (async (id: string, prompt: string) => {
      const { steerSession } = await import("@/lib/claude/ipc")
      return steerSession(id, prompt)
    })
  try {
    await steer(sessionId, text)
    return true
  } catch {
    return false
  }
}

export type CheckInIssueRunResult =
  | { status: "checked-in"; run: IssueRun }
  | { status: "refused"; reason: "not-found" | "not-active" | "not-periodic-wakeup" }

/**
 * Settle a periodic wakeup's run with a note and leave the issue where it was.
 *
 * Starting the run moved the issue to `in_progress`; a check-in delivered
 * nothing to review, so instead of advancing to `in_review` the issue goes
 * back to the column the run took it from (`runStatusBefore`). This goes
 * through the same one-transaction settle as every other outcome, so a PR
 * the run opened before checking in is still linked onto the issue. The
 * hand-back only leaves `in_progress`, so an issue a person moved meanwhile
 * stays where they put it.
 *
 * The engine keeps running until its turn ends; its later terminal poll is
 * never made (the run is no longer active). A new dispatch may claim the
 * issue in the meantime — that is the next run, with its own engine item,
 * and the old one can no longer write to the issue.
 *
 * Who may call this is the caller's question (`issue.wakeup_checkin` checks
 * the calling session is the run's own).
 */
export async function checkInIssueRun(
  runId: string,
  note: string,
  now = Date.now()
): Promise<CheckInIssueRunResult> {
  const run = await getIssueRun(runId)
  if (!run) return { status: "refused", reason: "not-found" }
  if (!isActiveIssueRunStatus(run.status)) return { status: "refused", reason: "not-active" }
  if (!run.wakeup?.periodic) return { status: "refused", reason: "not-periodic-wakeup" }
  const settled = await settleIssueRunAndIssue(
    runId,
    { status: "succeeded", mode: "checkin", note },
    now
  )
  if (!settled) return { status: "refused", reason: "not-active" }
  return { status: "checked-in", run: settled }
}

/** Trail kinds that end a run. */
const RUN_END_KINDS: ReadonlySet<string> = new Set([
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_checked_in",
])

function runIdOfEvent(event: { payload: object }): string | undefined {
  return "runId" in event.payload && typeof event.payload.runId === "string"
    ? event.payload.runId
    : undefined
}

export interface RepairStrandedIssuesResult {
  repaired: string[]
}

/**
 * Finish the issue half of settles a crash interrupted.
 *
 * Before `settleIssueRunAndIssue` was one transaction, a run could be settled
 * and the window close before its issue moved: the issue then sat in
 * `in_progress` with no active run, and nothing ever looked at it again
 * (the reconciler polls active runs only). Run once at boot, before the first
 * reconcile.
 *
 * An issue is stranded only when all of this holds: it is in `in_progress`,
 * it has no active run, its newest run was bound to an engine and is
 * terminal, and the trail's last status change put it in `in_progress`
 * while that run held it (between the run's `run_started` and its ending
 * entry — a window in which the run lock kept everyone but the bridge out of
 * that column). An
 * issue a person moved into `in_progress` before pressing Run, or after a run
 * settled, fails that test and is left alone; so does an issue whose claim
 * failed before its engine accepted (the issue never moved for it). The repair is what the settle would have done: a
 * check-in or a cancel hands back to `statusBefore`, anything else advances
 * to `in_review`.
 */
export async function repairStrandedIssues(): Promise<RepairStrandedIssuesResult> {
  const repaired: string[] = []
  const issues = await listIssues({ statuses: ["in_progress"] })
  for (const issue of issues) {
    const runs = await listIssueRuns({ issueId: issue.id })
    if (runs.some((run) => isActiveIssueRunStatus(run.status))) continue
    const latest = runs[0]
    if (!latest || latest.endedAt === undefined || isUnboundIssueRun(latest)) continue
    // Order by the trail's own clock: its `ts` is monotonic and may run a
    // millisecond ahead of the wall clock the run row's times come from.
    const events = [...(await listIssueEvents({ issueId: issue.id }))].sort((a, b) => a.ts - b.ts)
    const started = events.find(
      (event) => event.payload.kind === "run_started" && event.payload.runId === latest.id
    )
    const ended = events.find(
      (event) => RUN_END_KINDS.has(event.payload.kind) && runIdOfEvent(event) === latest.id
    )
    const lastMove = events.findLast((event) => event.payload.kind === "status_changed")
    if (!started || !ended || !lastMove || lastMove.payload.kind !== "status_changed") continue
    if (lastMove.payload.to !== "in_progress") continue
    if (lastMove.ts < started.ts || lastMove.ts > ended.ts) continue
    const actor = runtimeActorFor(latest)
    const checkedIn = ended.payload.kind === "run_checked_in"
    if (checkedIn || latest.status === "cancelled") {
      await handBackRuntimeIssueStatus(issue.id, runStatusBefore(latest), actor)
    } else {
      await applyRuntimeIssueStatus(issue.id, "in_review", actor)
    }
    repaired.push(issue.id)
  }
  return { repaired }
}
