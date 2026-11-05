/**
 * The tracker's programmatic face (spec 2026-09-06 D9).
 *
 * Workflow nodes, the /issue slash command, the plugin `ctx.issues` API and
 * the External Bridge all want the same handful of operations: find an
 * issue by id or printed identifier, create one into a container, apply one
 * board action through the same gate the board itself uses, and list. They
 * used to each reach into `lib/db/issues.ts` and reimplement the defaults.
 * This module is the one place those defaults live, so every caller refuses
 * the same moves for the same reasons (`canApplyBulkAction`), resolves
 * `MERC-12` the same way, and stamps the same provenance.
 *
 * No React, no stores beyond the active-workspace read. Writes never bypass
 * the trail: creation and every action append `issueEvents`, which also
 * publishes on `lib/issues/event-bus.ts`.
 *
 * It is also the components' only door (plan 2026-11-05 §6): nothing under
 * `components/`, `app/` or `hooks/` imports a write from `lib/db/issue*`
 * (`scripts/gates/check-issue-write-boundary.mjs`). Every write a surface
 * offers lives here, validates what it is handed, and does the follow-up the
 * write implies (the GitHub refresh schedule after a binding changes), so two
 * surfaces cannot disagree about either.
 */

import {
  createIssueCycle,
  deleteIssueCycle,
  getIssueCycle,
  updateIssueCycle,
  type CreateIssueCycleInput,
  type IssueCycleUpdatePatch,
} from "@/lib/db/issue-cycles"
import {
  addIssueProjectResource,
  createIssueProject,
  deleteIssueProject,
  getIssueProject,
  getIssueProjectByKey,
  listIssueProjects,
  removeIssueProjectResource,
  updateIssueProject,
  type CreateIssueProjectInput,
  type IssueProjectUpdatePatch,
} from "@/lib/db/issue-projects"
import { acceptIssueDeliverable, listActiveIssueRunIssueIds } from "@/lib/db/issue-runs"
import {
  createIssue,
  getIssue,
  getIssueByIdentifier,
  linkIssueToGithub,
  listIssues,
  moveIssue,
  reorderIssues,
  type CreateIssueInput,
} from "@/lib/db/issues"
import { getDb } from "@/lib/db/schema"
import { matchesIssueText } from "./board-model"
import { applyIssueBulkAction, type IssueBulkAction, type IssueBulkOutcome } from "./bulk-actions"
import type { IssueMoveError } from "./state-machine"
import { toUnifiedIssue } from "./sources/local-source"
import { isSyncedResource } from "./sync/bindings"
import { ensureIssueLabels } from "./sync/apply"
import {
  ISSUE_CYCLE_KINDS,
  ISSUE_CYCLE_STATUSES,
  ISSUE_PRIORITIES,
  ISSUE_PROJECT_STATUSES,
  ISSUE_STATUSES,
  ISSUE_TRIAGE_STATES,
  isIssueStage,
  type Issue,
  type IssueActor,
  type IssueCycle,
  type IssueGithubRef,
  type IssuePriority,
  type IssueProject,
  type IssueProjectResource,
  type IssueStatus,
  type IssueTriageState,
} from "@/types/issues"
import { makeUnifiedIssueId } from "@/types/issues/unified"
import type {
  CreateIssueRequest,
  IssueQuery,
  IssueWire,
} from "@cognia/plugin-contract/lib/issues/service"
export type {
  CreateIssueRequest,
  IssueQuery,
  IssueWire,
} from "@cognia/plugin-contract/lib/issues/service"

/** The active workspace, or null outside a signed-in shell. */
export async function activeWorkspaceId(): Promise<string | null> {
  const { useProjectStore } = await import("@/stores/project/project-store")
  return useProjectStore.getState().activeProjectId ?? null
}

/** `MERC-12` or a row id. Identifiers are case-insensitive. */
export async function resolveIssue(ref: string): Promise<Issue | undefined> {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  const byId = await getIssue(trimmed)
  if (byId) return byId
  return getIssueByIdentifier(trimmed.toUpperCase())
}

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value)
}

export function isIssuePriority(value: unknown): value is IssuePriority {
  return typeof value === "string" && (ISSUE_PRIORITIES as readonly string[]).includes(value)
}

export function isIssueTriageState(value: unknown): value is IssueTriageState {
  return typeof value === "string" && (ISSUE_TRIAGE_STATES as readonly string[]).includes(value)
}

export { isIssueStage }

const ISSUE_ACTOR_KINDS: readonly string[] = ["human", "agent", "team"]

/** A well-formed actor: one of the three kinds, with string `id`/`label` when present. */
export function isIssueActor(value: unknown): value is IssueActor {
  if (!value || typeof value !== "object") return false
  const actor = value as { kind?: unknown; id?: unknown; label?: unknown }
  return (
    typeof actor.kind === "string" &&
    ISSUE_ACTOR_KINDS.includes(actor.kind) &&
    (actor.id === undefined || typeof actor.id === "string") &&
    (actor.label === undefined || typeof actor.label === "string")
  )
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value))
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * Check an action handed over from outside TypeScript (a paired phone, a
 * plugin, the bridge) field by field before it reaches the gate. Returns the
 * action typed, or throws naming the field that is wrong. The gate itself
 * (`canApplyBulkAction`, `moveIssue`) still decides whether it may apply.
 */
export function parseIssueAction(raw: unknown): IssueBulkAction {
  if (!raw || typeof raw !== "object") throw new Error("Issue action must be an object")
  const action = raw as Record<string, unknown> & { kind?: unknown }
  const fail = (field: string): never => {
    throw new Error(`Issue action "${String(action.kind)}" has an invalid ${field}`)
  }
  switch (action.kind) {
    case "status":
      if (!isIssueStatus(action.to)) fail("to")
      return { kind: "status", to: action.to as IssueStatus }
    case "priority":
      if (!isIssuePriority(action.to)) fail("to")
      return { kind: "priority", to: action.to as IssuePriority }
    case "title":
      if (!nonEmptyString(action.to)) fail("to")
      return { kind: "title", to: action.to as string }
    case "description":
      if (typeof action.to !== "string") fail("to")
      return { kind: "description", to: action.to as string }
    case "assignee":
      if (action.to !== null && !isIssueActor(action.to)) fail("to")
      return { kind: "assignee", to: action.to as IssueActor | null }
    case "addLabel":
    case "removeLabel":
      if (!nonEmptyString(action.labelId)) fail("labelId")
      return { kind: action.kind, labelId: action.labelId as string }
    case "project":
      if (!nonEmptyString(action.issueProjectId)) fail("issueProjectId")
      return { kind: "project", issueProjectId: action.issueProjectId as string }
    case "cycle":
      if (action.cycleId !== null && !nonEmptyString(action.cycleId)) fail("cycleId")
      return { kind: "cycle", cycleId: action.cycleId as string | null }
    case "dueDate":
    case "estimate":
      if (!isNullableFiniteNumber(action.to)) fail("to")
      return { kind: action.kind, to: action.to as number | null }
    case "stage":
      if (action.to !== null && !isIssueStage(action.to)) fail("to")
      return { kind: "stage", to: action.to as number | null }
    case "triage":
      if (action.to !== null && !isIssueTriageState(action.to)) fail("to")
      return { kind: "triage", to: action.to as IssueTriageState | null }
    case "parent":
      if (action.parentId !== null && !nonEmptyString(action.parentId)) fail("parentId")
      return { kind: "parent", parentId: action.parentId as string | null }
    case "addBlocker":
    case "removeBlocker":
      if (!nonEmptyString(action.blockerId)) fail("blockerId")
      return { kind: action.kind, blockerId: action.blockerId as string }
    case "linkExternal":
    case "unlinkExternal": {
      const ref = action.ref as { provider?: unknown; externalId?: unknown } | null | undefined
      if (!ref || !nonEmptyString(ref.provider) || !nonEmptyString(ref.externalId)) fail("ref")
      return action.kind === "linkExternal"
        ? {
            kind: "linkExternal",
            ref: action.ref as Extract<IssueBulkAction, { kind: "linkExternal" }>["ref"],
          }
        : {
            kind: "unlinkExternal",
            ref: { provider: ref!.provider as string, externalId: ref!.externalId as string },
          }
    }
    case "comment": {
      if (!nonEmptyString(action.body)) fail("body")
      const mentions = action.mentions
      if (
        mentions !== undefined &&
        (!Array.isArray(mentions) || !mentions.every((id) => typeof id === "string"))
      ) {
        fail("mentions")
      }
      return {
        kind: "comment",
        body: action.body as string,
        ...(mentions ? { mentions: mentions as string[] } : {}),
      }
    }
    case "delete":
      return { kind: "delete" }
    default:
      throw new Error(`Unknown issue action "${String(action.kind)}"`)
  }
}

/**
 * Resolve the container a caller named, or the workspace's first one. Throws
 * a readable error rather than creating an orphan row.
 */
export async function resolveIssueContainer(input: {
  projectId?: string
  issueProjectId?: string
  projectKey?: string
}): Promise<{ projectId: string; issueProjectId: string }> {
  if (input.issueProjectId) {
    // A named container carries its workspace, so a caller outside the shell
    // (the bridge, a headless job) does not need an active workspace.
    const container = await getIssueProject(input.issueProjectId)
    if (!container) throw new Error(`No project with id ${input.issueProjectId}`)
    if (input.projectId && container.projectId !== input.projectId) {
      throw new Error(`Project ${input.issueProjectId} is not in workspace ${input.projectId}`)
    }
    return { projectId: container.projectId, issueProjectId: container.id }
  }
  const projectId = input.projectId ?? (await activeWorkspaceId())
  if (!projectId) throw new Error("No active workspace to file the issue in")
  if (input.projectKey) {
    const byKey = await getIssueProjectByKey(input.projectKey.trim().toUpperCase())
    if (!byKey || byKey.projectId !== projectId) {
      throw new Error(
        `No project with key ${input.projectKey.trim().toUpperCase()} in this workspace`
      )
    }
    return { projectId, issueProjectId: byKey.id }
  }
  const containers = await listIssueProjects({ projectId })
  const first = containers[0]
  if (!first) throw new Error("Create a project first: issues need somewhere to live")
  return { projectId, issueProjectId: first.id }
}

/**
 * Refuse a create request whose fields are not what they claim to be. Callers
 * outside TypeScript (plugins, the bridge, a paired phone) can hand over
 * anything, and a row written with a made-up status or an assignee of an
 * unknown kind breaks every board that reads it.
 */
function assertCreateRequest(request: CreateIssueRequest): void {
  if (typeof request.title !== "string" || !request.title.trim()) {
    throw new Error("Issue title is required")
  }
  if (request.description !== undefined && typeof request.description !== "string") {
    throw new Error("Issue description must be text")
  }
  if (request.status !== undefined && !isIssueStatus(request.status)) {
    throw new Error(`Unknown issue status '${String(request.status)}'`)
  }
  if (request.priority !== undefined && !isIssuePriority(request.priority)) {
    throw new Error(`Unknown issue priority '${String(request.priority)}'`)
  }
  if (request.assignee !== undefined && !isIssueActor(request.assignee)) {
    throw new Error("Issue assignee must be a person, an agent or a team")
  }
  if (request.triage !== undefined && !isIssueTriageState(request.triage)) {
    throw new Error(`Unknown triage state '${String(request.triage)}'`)
  }
  if (request.stage !== undefined && !isIssueStage(request.stage)) {
    throw new Error(`Invalid sub-issue stage '${String(request.stage)}'`)
  }
  if (!isOptionalFiniteNumber(request.dueDate)) throw new Error("Issue due date must be a time")
  if (!isOptionalFiniteNumber(request.estimate)) throw new Error("Issue estimate must be a number")
  for (const [field, ids] of [
    ["labelIds", request.labelIds],
    ["labels", request.labels],
    ["blockedBy", request.blockedBy],
  ] as const) {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))) {
      throw new Error(`Issue ${field} must be a list of strings`)
    }
  }
}

export async function createIssueRecord(request: CreateIssueRequest): Promise<Issue> {
  assertCreateRequest(request)
  const title = request.title.trim()
  const { projectId, issueProjectId } = await resolveIssueContainer(request)
  if (request.cycleId) {
    // The check `setIssueCycle` makes on a later edit.
    const cycle = await getIssueCycle(request.cycleId)
    if (!cycle) throw new Error(`Unknown cycle: ${request.cycleId}`)
    if (cycle.projectId !== projectId) throw new Error("Cycle must be in the same workspace")
  }
  const labelIds = new Set<string>(request.labelIds ?? [])
  if (request.labels?.length) {
    for (const row of await ensureIssueLabels(request.labels)) labelIds.add(row.id)
  }
  const input: CreateIssueInput = {
    projectId,
    issueProjectId,
    title,
    createdBy: request.by,
    ...(request.description?.trim() ? { description: request.description.trim() } : {}),
    ...(request.status ? { status: request.status } : {}),
    ...(request.priority ? { priority: request.priority } : {}),
    ...(request.assignee ? { assignee: request.assignee } : {}),
    ...(labelIds.size ? { labelIds: [...labelIds] } : {}),
    ...(request.parentId ? { parentId: request.parentId } : {}),
    ...(request.blockedBy?.length ? { blockedBy: [...request.blockedBy] } : {}),
    ...(request.cycleId ? { cycleId: request.cycleId } : {}),
    ...(request.dueDate !== undefined ? { dueDate: request.dueDate } : {}),
    ...(request.estimate !== undefined ? { estimate: request.estimate } : {}),
    ...(request.stage !== undefined ? { stage: request.stage } : {}),
    ...(request.triage ? { triage: request.triage } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
  }
  return createIssue(input)
}

/**
 * One board action on one local issue, through the board's own gate. The
 * outcome says whether it applied, was skipped (and why) or failed, exactly
 * as a bulk selection would report it.
 */
export async function applyIssueAction(
  issue: Issue,
  action: IssueBulkAction,
  by: IssueActor
): Promise<IssueBulkOutcome> {
  const running = await listActiveIssueRunIssueIds(issue.projectId)
  const runningUnified = new Set([...running].map((id) => makeUnifiedIssueId("local", id)))
  return applyIssueBulkAction([toUnifiedIssue(issue)], action, by, runningUnified)
}

/**
 * One board drop onto a column. The legality decision belongs to `moveIssue`,
 * which reads the run lock inside its own write; the result is its denial
 * (null when it moved, or there was nothing to move).
 */
export async function moveIssueRecord(input: {
  id: string
  to: IssueStatus
  by: IssueActor
}): Promise<IssueMoveError | null> {
  if (!isIssueStatus(input.to)) throw new Error(`Unknown issue status '${String(input.to)}'`)
  return moveIssue(input)
}

/** Persist a drag within a column. Orders must be finite numbers. */
export async function reorderIssueRecords(
  changes: ReadonlyArray<{ sourceId: string; order: number }>
): Promise<void> {
  for (const change of changes) {
    if (!nonEmptyString(change.sourceId) || !Number.isFinite(change.order)) {
      throw new Error("Issue reorder needs an issue id and a finite order")
    }
  }
  await reorderIssues(changes)
}

const GITHUB_REPO_FULL_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/**
 * Bind a local issue to an existing GitHub issue. The URL is derived, never
 * asked for: it is a pure function of the repository and the number, and
 * asking would invite a mismatch.
 */
export async function linkIssueGithubRecord(
  issueId: string,
  target: { repoFullName: string; number: number },
  by: IssueActor
): Promise<IssueGithubRef> {
  const repoFullName = target.repoFullName.trim()
  if (!GITHUB_REPO_FULL_NAME.test(repoFullName)) {
    throw new Error(`"${repoFullName}" is not an owner/repository name`)
  }
  if (!Number.isInteger(target.number) || target.number <= 0) {
    throw new Error("A GitHub issue number is a positive whole number")
  }
  if (!(await getIssue(issueId))) throw new Error(`No issue with id ${issueId}`)
  const ref: IssueGithubRef = {
    repoFullName,
    number: target.number,
    htmlUrl: `https://github.com/${repoFullName}/issues/${target.number}`,
  }
  await linkIssueToGithub(issueId, ref, by)
  return ref
}

/** Accept one delivered version on a run. Returns when it was accepted. */
export async function acceptIssueDeliverableRecord(
  runId: string,
  deliveryId: string,
  expectedDigest: string
): Promise<number> {
  if (!nonEmptyString(runId) || !nonEmptyString(deliveryId) || !nonEmptyString(expectedDigest)) {
    throw new Error("Accepting a delivery needs its run, delivery id and digest")
  }
  return acceptIssueDeliverable(runId, deliveryId, expectedDigest)
}

// ── Projects (issue containers) ────────────────────────────────────────────

function assertProjectFields(fields: {
  status?: unknown
  priority?: unknown
  lead?: unknown
  startDate?: unknown
  targetDate?: unknown
}): void {
  if (
    fields.status !== undefined &&
    !(ISSUE_PROJECT_STATUSES as readonly unknown[]).includes(fields.status)
  ) {
    throw new Error(`Unknown project status '${String(fields.status)}'`)
  }
  if (fields.priority !== undefined && !isIssuePriority(fields.priority)) {
    throw new Error(`Unknown project priority '${String(fields.priority)}'`)
  }
  if (fields.lead !== undefined && fields.lead !== null && !isIssueActor(fields.lead)) {
    throw new Error("A project lead must be a person, an agent or a team")
  }
  for (const [field, value] of [
    ["start date", fields.startDate],
    ["target date", fields.targetDate],
  ] as const) {
    if (value !== undefined && value !== null && !isOptionalFiniteNumber(value)) {
      throw new Error(`A project ${field} must be a time`)
    }
  }
  if (
    typeof fields.startDate === "number" &&
    typeof fields.targetDate === "number" &&
    fields.targetDate < fields.startDate
  ) {
    throw new Error("A project cannot be due before it starts")
  }
}

/**
 * Create a container. The key check and the insert share one transaction, so
 * two surfaces creating `MERC` at once cannot both win.
 */
export async function createIssueProjectRecord(
  input: CreateIssueProjectInput
): Promise<IssueProject> {
  if (!nonEmptyString(input.projectId)) throw new Error("A project needs a workspace")
  assertProjectFields(input)
  const db = getDb()
  return db.transaction("rw", db.issueProjects, () => createIssueProject(input))
}

/**
 * Create a container and its first issue together: the create surface's
 * "new project" branch. One transaction, so a refused issue (a bad field, a
 * stale parent) leaves no empty container behind.
 */
export async function createIssueProjectWithFirstIssue(
  project: CreateIssueProjectInput,
  issue: Omit<CreateIssueRequest, "projectId" | "issueProjectId" | "projectKey" | "labels">
): Promise<{ project: IssueProject; issue: Issue }> {
  if (!nonEmptyString(project.projectId)) throw new Error("A project needs a workspace")
  assertProjectFields(project)
  assertCreateRequest(issue)
  const db = getDb()
  // `labels` (names, created on demand) is excluded from the request type:
  // creating labels would pull another table into the transaction for a
  // surface that only ever passes ids.
  return db.transaction(
    "rw",
    [db.issueProjects, db.issues, db.issueEvents, db.issueCounters, db.issueCycles],
    async () => {
      const container = await createIssueProject(project)
      const created = await createIssueRecord({
        ...issue,
        projectId: container.projectId,
        issueProjectId: container.id,
      })
      return { project: container, issue: created }
    }
  )
}

export async function updateIssueProjectRecord(
  id: string,
  patch: IssueProjectUpdatePatch
): Promise<void> {
  if (patch.name !== undefined && !nonEmptyString(patch.name)) {
    throw new Error("Project name is required")
  }
  assertProjectFields(patch)
  const existing = await getIssueProject(id)
  if (!existing) throw new Error(`No project with id ${id}`)
  // A patch carrying one date is checked against the other one already stored.
  const startDate = patch.startDate === undefined ? existing.startDate : patch.startDate
  const targetDate = patch.targetDate === undefined ? existing.targetDate : patch.targetDate
  if (typeof startDate === "number" && typeof targetDate === "number" && targetDate < startDate) {
    throw new Error("A project cannot be due before it starts")
  }
  await updateIssueProject(id, patch)
}

/** The background GitHub refresh follows the synced bindings that exist. */
async function reconcileGithubRefresh(): Promise<void> {
  const { syncGithubIssueSchedule } = await import("./github-sync-schedule")
  await syncGithubIssueSchedule()
}

/** Delete a container with its issues, and retire its refresh if it held the last binding. */
export async function deleteIssueProjectRecord(id: string): Promise<void> {
  const existing = await getIssueProject(id)
  if (!existing) throw new Error(`No project with id ${id}`)
  await deleteIssueProject(id)
  if (existing.resources.some(isSyncedResource)) await reconcileGithubRefresh()
}

/**
 * Bind a resource (or replace `previous` with it). Binding the first synced
 * resource is what brings the background refresh into existence.
 */
export async function attachProjectResource(
  issueProjectId: string,
  resource: IssueProjectResource,
  previous?: IssueProjectResource
): Promise<void> {
  if (!resource || typeof resource !== "object" || !nonEmptyString(resource.kind)) {
    throw new Error("A project resource needs a kind")
  }
  if (!(await getIssueProject(issueProjectId))) {
    throw new Error(`No project with id ${issueProjectId}`)
  }
  await addIssueProjectResource(issueProjectId, resource, previous)
  if (isSyncedResource(resource) || (previous && isSyncedResource(previous))) {
    await reconcileGithubRefresh()
  }
}

/** Unbind a resource. Unbinding the last synced one retires the background refresh. */
export async function detachProjectResource(
  issueProjectId: string,
  resource: IssueProjectResource
): Promise<void> {
  if (!(await getIssueProject(issueProjectId))) {
    throw new Error(`No project with id ${issueProjectId}`)
  }
  await removeIssueProjectResource(issueProjectId, resource)
  if (isSyncedResource(resource)) await reconcileGithubRefresh()
}

// ── Cycles and milestones ──────────────────────────────────────────────────

async function assertCycleContainer(
  workspaceId: string,
  issueProjectId: string | null | undefined
): Promise<void> {
  if (!issueProjectId) return
  const container = await getIssueProject(issueProjectId)
  if (!container) throw new Error(`No project with id ${issueProjectId}`)
  // A cycle scoped to another workspace's container would be invisible on both.
  if (container.projectId !== workspaceId) {
    throw new Error(`Project ${issueProjectId} is not in workspace ${workspaceId}`)
  }
}

export async function createIssueCycleRecord(input: CreateIssueCycleInput): Promise<IssueCycle> {
  if (!nonEmptyString(input.projectId)) throw new Error("A cycle needs a workspace")
  if (!(ISSUE_CYCLE_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new Error(`Unknown cycle kind '${String(input.kind)}'`)
  }
  if (
    input.status !== undefined &&
    !(ISSUE_CYCLE_STATUSES as readonly unknown[]).includes(input.status)
  ) {
    throw new Error(`Unknown cycle status '${String(input.status)}'`)
  }
  if (!isOptionalFiniteNumber(input.startsAt) || !isOptionalFiniteNumber(input.endsAt)) {
    throw new Error("Cycle dates must be times")
  }
  await assertCycleContainer(input.projectId, input.issueProjectId)
  return createIssueCycle(input)
}

export async function updateIssueCycleRecord(
  id: string,
  patch: IssueCycleUpdatePatch
): Promise<void> {
  const existing = await getIssueCycle(id)
  if (!existing) throw new Error(`No cycle with id ${id}`)
  // `updateIssueCycle` keeps the old name for a blank one; say so instead.
  if (patch.name !== undefined && !nonEmptyString(patch.name)) {
    throw new Error("Cycle name is required")
  }
  if (
    patch.status !== undefined &&
    !(ISSUE_CYCLE_STATUSES as readonly unknown[]).includes(patch.status)
  ) {
    throw new Error(`Unknown cycle status '${String(patch.status)}'`)
  }
  for (const value of [patch.startsAt, patch.endsAt]) {
    if (value !== undefined && value !== null && !Number.isFinite(value)) {
      throw new Error("Cycle dates must be times")
    }
  }
  await assertCycleContainer(existing.projectId, patch.issueProjectId)
  await updateIssueCycle(id, patch)
}

export async function deleteIssueCycleRecord(id: string): Promise<void> {
  if (!(await getIssueCycle(id))) throw new Error(`No cycle with id ${id}`)
  await deleteIssueCycle(id)
}

export async function queryIssues(query: IssueQuery = {}): Promise<Issue[]> {
  const projectId = query.projectId ?? (await activeWorkspaceId()) ?? undefined
  let issueProjectId = query.issueProjectId
  if (!issueProjectId && query.projectKey) {
    const container = await getIssueProjectByKey(query.projectKey.trim().toUpperCase())
    if (!container) return []
    issueProjectId = container.id
  }
  const { projectKey: _key, text, limit, ...rest } = query
  void _key
  let rows = await listIssues({
    ...rest,
    ...(projectId ? { projectId } : {}),
    ...(issueProjectId ? { issueProjectId } : {}),
  })
  if (text?.trim()) rows = rows.filter((issue) => matchesIssueText(issue, text))
  return limit !== undefined ? rows.slice(0, Math.max(0, limit)) : rows
}

export function toIssueWire(issue: Issue): IssueWire {
  const { externalKeys: _keys, ...wire } = issue
  void _keys
  return wire
}

// ── Collaboration conflicts ────────────────────────────────────────────────

export type CollabConflictChoice = "discard" | "rebase"

/**
 * Settle a collaboration write the server refused as conflicting: drop the
 * pending change, or re-apply it on top of the server's current revision.
 */
export async function resolveCollabConflict(
  id: string,
  choice: CollabConflictChoice
): Promise<void> {
  const { discardCollabConflict, rebaseCollabConflict } =
    await import("@/lib/db/mobile-outbound-queue")
  if (choice === "discard") return discardCollabConflict(id)
  if (choice === "rebase") {
    await rebaseCollabConflict(id)
    return
  }
  throw new Error(`Unknown conflict choice '${String(choice)}'`)
}

export type { IssueBulkAction, IssueBulkOutcome }
