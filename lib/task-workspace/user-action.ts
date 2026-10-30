/**
 * The approval seam for user-triggered task-workspace mutations.
 *
 * # Why this exists
 *
 * `authorize_approval` (`src-tauri/src/companion_api/remote_execution.rs`)
 * refuses any `approval: "interactive"` command that does not carry a valid
 * `adminLease`. Workspace lifecycle mutations carrying that flag include:
 * `task_workspace_managed_delete`, `_archive`, `_restore`, `_pin`,
 * `_permanent`, `_adopt`, `task_workspace_environment_adopt`,
 * `_create_branch`, `task_workspace_policy_set`, and explicit port-lease
 * releases. Port-lease ensure commands are idempotent execution bookkeeping:
 * they require `workspace.write` but no admin lease, and never open a host port.
 *
 * `lib/task-workspace/client.ts` called `transport.call` bare, so every one of
 * those actions answered `interactive_approval_required` from a paired phone
 * or browser. The reads (`approval: "none"`, capability `host.observe`) always
 * worked, which is why the inventory rendered and every button on it failed.
 *
 * The git plane solved this already. `runGitUserAction`
 * (`lib/git/commands.ts`) resolves per-command availability, mints a lease,
 * and parks it for the outbound call to pick up. This module is that same
 * shape for task-workspace, sharing `resolveUserActionAvailability` so the two
 * planes cannot answer the same lease question differently.
 *
 * Remote approvals retain an explicit Host transport, including on a desktop
 * whose runtime snapshot has no companion target.
 */

import { transport as baseTransport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import {
  resolveUserActionAvailability,
  type OperationAvailability,
} from "@/lib/runtime/operation-availability"
import {
  captureTaskWorkspaceOrigin,
  openTaskWorkspaceOrigin,
  sameTaskWorkspaceOrigin,
  type TaskWorkspaceAuthority,
} from "./origin"
import type { TaskWorkspaceOrigin } from "./types"

interface PendingApproval {
  command: string
  token: string
  authority: TaskWorkspaceAuthority
}

/**
 * Leases minted but not yet consumed, keyed by command.
 *
 * A queue rather than a single slot because two inventory rows can be acted on
 * concurrently, and each lease is bound to one exact command. Entries are
 * removed in `finally`, so an operation that throws does not strand its lease
 * for a later call to pick up by mistake.
 */
const pendingApprovals: PendingApproval[] = []

/**
 * Attach a pending lease to one outbound call's arguments.
 *
 * Called by the transport shim in `client.ts` rather than by each wrapper, so
 * a new write command cannot be added without the lease riding along.
 */
export function applyWorkspaceApproval(
  command: string,
  args?: unknown,
  origin: TaskWorkspaceOrigin = captureTaskWorkspaceOrigin()
): Record<string, unknown> | undefined {
  const index = pendingApprovals.findIndex(
    (approval) =>
      approval.command === command && sameTaskWorkspaceOrigin(approval.authority.origin, origin)
  )
  if (index < 0) return args as Record<string, unknown> | undefined
  const [approval] = pendingApprovals.splice(index, 1)
  return { ...((args as Record<string, unknown>) ?? {}), adminLease: approval.token }
}

/** Whether `command` can run right now, and if not, the reason to show. */
export function getWorkspaceOperationAvailability(command: string): OperationAvailability {
  return resolveUserActionAvailability(getRuntimeSnapshot(), command)
}

/**
 * Thrown instead of issuing a call the host would refuse.
 *
 * Carries the structured availability so a surface can render the reason
 * rather than a stringified state name.
 */
export class WorkspaceOperationUnavailableError extends Error {
  readonly availability: OperationAvailability

  constructor(command: string, availability: OperationAvailability) {
    super(`Workspace operation unavailable: ${command} (${availability.reason})`)
    this.name = "WorkspaceOperationUnavailableError"
    this.availability = availability
  }
}

/** Bind one exact 120-second approval lease to a user-triggered workspace mutation. */
export async function runWorkspaceUserAction<T>(
  command: string,
  operation: () => Promise<T>,
  origin: TaskWorkspaceOrigin = captureTaskWorkspaceOrigin()
): Promise<T> {
  const snapshot = getRuntimeSnapshot()

  // No client target means this shell IS the execution host: the Tauri desktop
  // or the headless brain. It approves itself and there is nobody to ask.
  //
  // Deliberately not `isTauri()`, which the git plane uses. `isTauri()` is also
  // false in the headless host, so that check would have sent a headless run
  // off to mint a lease from a host that does not exist.
  if (!snapshot.target && origin.kind === "local") return operation()

  const availability = resolveUserActionAvailability(snapshot, command)
  if (snapshot.target && availability.state !== "available") {
    // Refuse before the call. Issuing it would spend a round trip to learn
    // what the manifest already said, and return a host error that names the
    // wire failure instead of the missing grant.
    throw new WorkspaceOperationUnavailableError(command, availability)
  }

  // A standalone client runs against its own in-browser executor, and a
  // non-interactive command needs no approval. Only the interactive-over-a-
  // companion pair actually requires a lease.
  if (origin.kind !== "remote" || getCommandDescriptor(command)?.approval !== "interactive") {
    return operation()
  }

  const authority = await openTaskWorkspaceOrigin(origin)
  try {
    authority.assertCurrent()
    const lease = await issueHostAdminLease([command], 120, authority.transport)
    authority.assertCurrent()
    const approval: PendingApproval = { command, token: lease.token, authority }
    pendingApprovals.push(approval)
    try {
      return await operation()
    } finally {
      const index = pendingApprovals.indexOf(approval)
      if (index >= 0) pendingApprovals.splice(index, 1)
    }
  } finally {
    authority.close()
  }
}

/**
 * The task-workspace commands ONE chat turn issues while it holds a managed
 * working copy.
 *
 * Every one of them is `approval: "interactive"`, so on a companion each was
 * refused with `a current device-bound approval lease is required` and the
 * turn died before the model was ever called. Wrapping them individually in
 * {@link runWorkspaceUserAction} would mint a lease per tool event, and the
 * settle happens long after the send call returns, so a one-shot lease is the
 * wrong shape here. The gesture being approved is pressing Send once.
 */
export const WORKSPACE_TURN_COMMANDS = Object.freeze([
  "task_workspace_bundle_acquire",
  "task_workspace_bundle_turn_begin",
  "task_workspace_bundle_turn_settle",
  "task_workspace_bundle_turn_abort",
  "task_workspace_record_tool_event",
  "task_workspace_begin",
  "task_workspace_settle",
])

/** How long a scope's lease runs before it is re-minted on the next call. */
const SCOPE_LEASE_TTL_SECONDS = 15 * 60
/** Re-mint this far ahead of expiry so a call in flight cannot outlive it. */
const SCOPE_RENEW_MARGIN_MS = 30_000

interface ApprovalScope {
  commands: readonly string[]
  token: string
  expiresAt: number
  closed: boolean
  authority: TaskWorkspaceAuthority
}

/**
 * Standing approvals, newest last. Unlike {@link pendingApprovals} these are
 * NOT consumed by a call: one scope covers every command it names for as long
 * as the work it was opened for is running.
 */
const approvalScopes: ApprovalScope[] = []

export function hasWorkspaceApprovalScope(command: string, origin: TaskWorkspaceOrigin): boolean {
  return approvalScopes.some(
    (scope) =>
      !scope.closed &&
      scope.commands.includes(command) &&
      sameTaskWorkspaceOrigin(scope.authority.origin, origin)
  )
}

/** A standing approval held open by {@link openWorkspaceApprovalScope}. */
export interface WorkspaceApprovalScope {
  readonly origin?: TaskWorkspaceOrigin
  close(): void
}

/**
 * Hold one approval open across a piece of multi-call work.
 *
 * Returns `null` when nothing needs approving: this shell IS the execution
 * host, or its host does not gate these commands. Throws
 * {@link WorkspaceOperationUnavailableError} when the device cannot mint a
 * lease at all, so a surface can say which grant is missing instead of showing
 * the host's wire refusal.
 *
 * The caller MUST `close()` it. A scope left open keeps a step-up token usable
 * by later work the user never asked for, which is the whole thing the lease
 * exists to prevent.
 */
export async function openWorkspaceApprovalScope(
  commands: readonly string[] = WORKSPACE_TURN_COMMANDS,
  origin: TaskWorkspaceOrigin = captureTaskWorkspaceOrigin()
): Promise<WorkspaceApprovalScope | null> {
  const snapshot = getRuntimeSnapshot()
  if (origin.kind === "local") return null
  const gated = commands.filter(
    (command) => getCommandDescriptor(command)?.approval === "interactive"
  )
  if (gated.length === 0) return null
  for (const command of gated) {
    const availability = resolveUserActionAvailability(snapshot, command)
    if (snapshot.target && availability.state !== "available") {
      throw new WorkspaceOperationUnavailableError(command, availability)
    }
  }

  const authority = await openTaskWorkspaceOrigin(origin)
  let lease
  try {
    authority.assertCurrent()
    lease = await issueHostAdminLease([...gated], SCOPE_LEASE_TTL_SECONDS, authority.transport)
    authority.assertCurrent()
  } catch (error) {
    authority.close()
    throw error
  }
  const scope: ApprovalScope = {
    commands: gated,
    token: lease.token,
    expiresAt: lease.expiresAt,
    closed: false,
    authority,
  }
  approvalScopes.push(scope)
  return {
    origin,
    close() {
      if (scope.closed) return
      scope.closed = true
      const index = approvalScopes.indexOf(scope)
      if (index >= 0) approvalScopes.splice(index, 1)
      authority.close()
    },
  }
}

/**
 * The scope opened for one bundle turn, keyed by that turn's id.
 *
 * `openWorkspaceApprovalScope`'s contract is that the caller MUST `close()` it,
 * and the chat controller could not honour that: it takes the alias and run id
 * off the lease and drops the handle, because a chat turn is settled from the
 * status edge in `lib/code-adoption/turn-tracker.ts`, nowhere near the send
 * call that opened the scope. So `settle`/`abort` — the only closures that
 * close the scope — were never called, and every managed chat turn on a
 * companion left a 15-minute step-up token covering all of
 * {@link WORKSPACE_TURN_COMMANDS} usable by work the user never approved.
 * Exactly what the lease exists to prevent.
 *
 * Keying the scope by turn id is what lets any settle path close it, rather
 * than only the one that happens to still hold the lease object. The turn id is
 * the right key because the scope's lifetime IS the turn's: it is opened to
 * cover one turn's workspace calls and is worthless the moment that turn ends.
 */
const turnScopes = new Map<
  string,
  { turnId: string; origin: TaskWorkspaceOrigin; scope: WorkspaceApprovalScope }
>()

/**
 * Hand a turn's scope to whoever ends that turn.
 *
 * A `null` scope (this shell is its own host, or its host does not gate these
 * commands) binds nothing, so {@link closeApprovalScopeForTurn} stays a no-op
 * for it.
 */
export function bindApprovalScopeToTurn(
  bundleTurnId: string,
  scope: WorkspaceApprovalScope | null
): void {
  if (!scope) return
  // A turn id is minted per turn, so a collision means the previous turn under
  // this id never closed. Close it rather than orphan it.
  const origin = scope.origin ?? captureTaskWorkspaceOrigin()
  const key = JSON.stringify([bundleTurnId, origin])
  turnScopes.get(key)?.scope.close()
  turnScopes.set(key, { turnId: bundleTurnId, origin, scope })
}

/**
 * Close the scope opened for one bundle turn. Idempotent, and safe for a turn
 * that never had one.
 */
export function closeApprovalScopeForTurn(
  bundleTurnId: string,
  origin?: TaskWorkspaceOrigin
): void {
  for (const [key, entry] of turnScopes) {
    if (entry.turnId !== bundleTurnId || (origin && !sameTaskWorkspaceOrigin(entry.origin, origin)))
      continue
    turnScopes.delete(key)
    entry.scope.close()
  }
}

/** Which turns still hold an approval scope. Exported for its tests. */
export function boundApprovalScopeTurnIds(): string[] {
  return [...new Set([...turnScopes.values()].map((entry) => entry.turnId))]
}

/**
 * The live scope covering `command`, re-minting it when it is about to expire.
 *
 * A managed turn can outrun any single lease, and losing one mid-turn means the
 * settle that releases the working copy is refused. Renewal keeps the same
 * scope alive rather than widening its TTL, so an abandoned scope still stops
 * being usable.
 */
async function scopeLeaseFor(
  command: string,
  origin: TaskWorkspaceOrigin
): Promise<ApprovalScope | undefined> {
  const scope = [...approvalScopes]
    .reverse()
    .find(
      (candidate) =>
        !candidate.closed &&
        candidate.commands.includes(command) &&
        sameTaskWorkspaceOrigin(candidate.authority.origin, origin)
    )
  if (!scope) return undefined
  scope.authority.assertCurrent()
  if (scope.expiresAt - Date.now() > SCOPE_RENEW_MARGIN_MS) return scope
  const renewed = await issueHostAdminLease(
    [...scope.commands],
    SCOPE_LEASE_TTL_SECONDS,
    scope.authority.transport
  )
  scope.authority.assertCurrent()
  if (scope.closed) return undefined
  scope.token = renewed.token
  scope.expiresAt = renewed.expiresAt
  return scope
}

/**
 * The transport `client.ts` writes through. Reads may use the base transport
 * directly, writes must come through here or they lose the lease.
 */
export const approvalAwareTransport = {
  async call<T>(command: string, args?: unknown, explicitOrigin?: TaskWorkspaceOrigin): Promise<T> {
    const origin = explicitOrigin ?? captureTaskWorkspaceOrigin()
    const pending = pendingApprovals.find(
      (entry) =>
        entry.command === command && sameTaskWorkspaceOrigin(entry.authority.origin, origin)
    )
    let authority = pending?.authority
    let next = applyWorkspaceApproval(command, args, origin)
    if (next?.adminLease === undefined) {
      // A one-shot lease wins: it was minted for this exact call. Only when
      // there is none does the standing scope answer.
      const scoped = await scopeLeaseFor(command, origin)
      if (scoped) {
        authority = scoped.authority
        next = { ...((next ?? args ?? {}) as Record<string, unknown>), adminLease: scoped.token }
      }
    }
    // Preserve the caller's arity. A few commands take no arguments at all,
    // and forwarding an explicit `undefined` changes the call the transport
    // sees for no benefit.
    const temporary =
      !authority && (explicitOrigin || origin.kind === "remote")
        ? await openTaskWorkspaceOrigin(origin)
        : undefined
    authority ??= temporary
    try {
      authority?.assertCurrent()
      const target = authority?.transport ?? baseTransport
      const result = await (next === undefined
        ? target.call<T>(command)
        : target.call<T>(command, next))
      authority?.assertCurrent()
      return result
    } finally {
      temporary?.close()
    }
  },
}
