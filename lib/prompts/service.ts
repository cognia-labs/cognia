/**
 * Write orchestration for code-owned prompt overrides (ADR-0236).
 *
 * The persistence layer enforces concurrency; this layer enforces the
 * definition's contract. Publishing validates the body against the current
 * definition, records which shipped default it was written against, commits,
 * and only reports success once this context's resolver snapshot carries the
 * new revision, so "published" in the editor means the next operation here
 * uses it. Drafts are saved unvalidated: unfinished work is allowed to be
 * unfinished, it just cannot be published.
 *
 * Every write is pinned to one account database: the one the caller read the
 * slot from (`database`, which `readPromptSlot` reports), else the one active
 * when the call starts. A switch while it awaits makes the storage layer refuse
 * it (`PromptOverrideAccountChangedError`) rather than write the edit into the
 * account that is active by then.
 */

import { digestPrompt } from "@/lib/agent/composition/digest"
import { activeDatabaseName } from "@/lib/db/schema"
import {
  deletePromptOverrideBinding,
  discardPromptOverrideDraft,
  getPromptOverrideBinding,
  getPromptOverrideRevision,
  listPromptOverrideBindingsFor,
  listPromptOverrideRevisions,
  publishPromptOverride,
  publishPromptOverrideBatch,
  resetPromptOverride,
  savePromptOverrideDraft,
  type PromptOverrideBindingRow,
  type PromptOverrideRevisionRow,
  type PromptRevisionOrigin,
} from "@/lib/db/prompt-overrides"
import { invalidatePromptOverrideSnapshot, loadPromptOverrideSnapshot } from "./snapshot"
import { validatePromptBody, type PromptValidationIssue } from "./template"
import { PROMPT_SCOPE_SPECIFICITY, type PromptDefinitionV1, type PromptTargetRef } from "./types"

export class PromptValidationError extends Error {
  readonly code = "prompt_validation_failed"
  constructor(readonly issues: PromptValidationIssue[]) {
    super(`prompt body is not valid: ${issues.map((issue) => issue.code).join(", ")}`)
    this.name = "PromptValidationError"
  }
}

export class PromptScopeError extends Error {
  readonly code = "prompt_scope_unsupported"
  constructor(promptId: string, scope: string) {
    super(`prompt ${promptId} cannot be overridden at the ${scope} scope`)
    this.name = "PromptScopeError"
  }
}

/** Digest of the shipped body, stored with each revision for upgrade comparison. */
export function shippedBodyDigest(def: PromptDefinitionV1): Promise<string> {
  return digestPrompt(def.defaultBody)
}

function assertScope(def: PromptDefinitionV1, target: PromptTargetRef): void {
  if (def.operation === "inspect-only" || !def.scopes.includes(target.scope)) {
    throw new PromptScopeError(def.id, target.scope)
  }
  if (target.scope !== "account" && !target.targetId) {
    throw new PromptScopeError(def.id, `${target.scope} (no target)`)
  }
}

async function settle(binding: PromptOverrideBindingRow): Promise<PromptOverrideBindingRow> {
  invalidatePromptOverrideSnapshot()
  await loadPromptOverrideSnapshot()
  return binding
}

function mutationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mut_${Date.now().toString(36)}_${Math.random()}`
}

/** Who a write is for: the account database the caller read the slot from. */
interface PinnedRequest {
  /** Defaults to the database active when the call starts. */
  database?: string
}

function pinned(request: PinnedRequest): string {
  return request.database ?? activeDatabaseName()
}

export interface PromptWriteRequest extends PinnedRequest {
  def: PromptDefinitionV1
  target: PromptTargetRef
  body: string
  expectedRev: number
  origin?: PromptRevisionOrigin
  /** Supply to make a retried request idempotent. */
  mutationId?: string
}

export async function publishPromptBody(
  request: PromptWriteRequest
): Promise<PromptOverrideBindingRow> {
  const expectDatabase = pinned(request)
  const { def, target, body } = request
  assertScope(def, target)
  const issues = validatePromptBody(def, body)
  if (issues.length > 0) throw new PromptValidationError(issues)
  const binding = await publishPromptOverride({
    expectDatabase,
    promptId: def.id,
    target,
    body,
    contractVersion: def.contractVersion,
    baseDigest: await shippedBodyDigest(def),
    expectedRev: request.expectedRev,
    mutationId: request.mutationId ?? mutationId(),
    origin: request.origin ?? "editor",
  })
  return settle(binding)
}

export async function publishPromptBodyBatch(
  requests: readonly PromptWriteRequest[],
  options: PinnedRequest = {}
): Promise<{ applied: number; conflictedIndices: number[] }> {
  const expectDatabase = pinned({
    database: options.database ?? requests[0]?.database,
  })
  for (const request of requests) {
    assertScope(request.def, request.target)
    const issues = validatePromptBody(request.def, request.body)
    if (issues.length > 0) throw new PromptValidationError(issues)
  }
  const digests = new Map<string, string>()
  await Promise.all(
    [...new Map(requests.map((request) => [request.def.id, request.def])).values()].map(
      async (def) => {
        digests.set(def.id, await shippedBodyDigest(def))
      }
    )
  )
  const inputs = requests.map((request) => ({
    expectDatabase: request.database ?? expectDatabase,
    promptId: request.def.id,
    target: request.target,
    body: request.body,
    contractVersion: request.def.contractVersion,
    baseDigest: digests.get(request.def.id)!,
    expectedRev: request.expectedRev,
    mutationId: request.mutationId ?? mutationId(),
    origin: request.origin ?? "editor",
  }))
  const result = await publishPromptOverrideBatch(inputs, { expectDatabase })
  invalidatePromptOverrideSnapshot()
  if (activeDatabaseName() === expectDatabase) {
    await loadPromptOverrideSnapshot().catch(() => undefined)
  }
  return result
}

export async function savePromptDraft(
  request: PromptWriteRequest
): Promise<PromptOverrideBindingRow> {
  const expectDatabase = pinned(request)
  const { def, target, body } = request
  assertScope(def, target)
  if (body.length > def.maxChars) {
    throw new PromptValidationError([
      { code: "too-long", limit: def.maxChars, length: body.length },
    ])
  }
  return savePromptOverrideDraft({
    expectDatabase,
    promptId: def.id,
    target,
    body,
    contractVersion: def.contractVersion,
    baseDigest: await shippedBodyDigest(def),
    expectedRev: request.expectedRev,
    mutationId: request.mutationId ?? mutationId(),
    origin: request.origin ?? "editor",
  })
}

/** Return the slot to inheritance (the next less specific override, or the shipped body). */
export async function resetPromptToInherited(
  request: PinnedRequest & {
    def: PromptDefinitionV1
    target: PromptTargetRef
    expectedRev: number
    origin?: PromptRevisionOrigin
  }
): Promise<PromptOverrideBindingRow> {
  const expectDatabase = pinned(request)
  assertScope(request.def, request.target)
  const binding = await resetPromptOverride({
    expectDatabase,
    promptId: request.def.id,
    target: request.target,
    expectedRev: request.expectedRev,
    mutationId: mutationId(),
    origin: request.origin ?? "editor",
    contractVersion: request.def.contractVersion,
    baseDigest: await shippedBodyDigest(request.def),
  })
  return settle(binding)
}

export async function discardPromptDraft(
  request: PinnedRequest & {
    def: PromptDefinitionV1
    target: PromptTargetRef
    expectedRev: number
  }
): Promise<PromptOverrideBindingRow> {
  return discardPromptOverrideDraft({
    expectDatabase: pinned(request),
    promptId: request.def.id,
    target: request.target,
    expectedRev: request.expectedRev,
    mutationId: mutationId(),
    origin: "editor",
  })
}

/**
 * Republish an earlier revision's body as a new revision. A `reset` revision
 * restores inheritance. The body is validated against the definition as it is
 * now, so restoring text written for an older contract is refused, not
 * silently activated.
 */
export async function restorePromptRevision(
  request: PinnedRequest & {
    def: PromptDefinitionV1
    target: PromptTargetRef
    revisionId: string
    expectedRev: number
  }
): Promise<PromptOverrideBindingRow> {
  const database = pinned(request)
  const revision = await getPromptOverrideRevision(request.revisionId)
  if (!revision || revision.promptId !== request.def.id) {
    throw new Error(`revision ${request.revisionId} does not belong to ${request.def.id}`)
  }
  if (revision.kind === "reset") {
    return resetPromptToInherited({ ...request, database, origin: "restore" })
  }
  return publishPromptBody({
    def: request.def,
    target: request.target,
    body: revision.body,
    expectedRev: request.expectedRev,
    origin: "restore",
    database,
  })
}

/** Remove a binding entirely (orphaned or unknown prompt ids). */
export async function removePromptBinding(
  binding: PromptOverrideBindingRow,
  request: PinnedRequest = {}
): Promise<void> {
  await deletePromptOverrideBinding(binding.id, binding.rev, { expectDatabase: pinned(request) })
  invalidatePromptOverrideSnapshot()
  await loadPromptOverrideSnapshot()
}

export interface PromptSlotState {
  /** The account database the slot was read from; a write made from it names this. */
  database: string
  binding?: PromptOverrideBindingRow
  active?: PromptOverrideRevisionRow
  draft?: PromptOverrideRevisionRow
}

/** The stored state of one slot. */
export async function readPromptSlot(
  promptId: string,
  target: PromptTargetRef
): Promise<PromptSlotState> {
  const database = activeDatabaseName()
  const binding = await getPromptOverrideBinding(promptId, target)
  if (!binding) return { database }
  const [active, draft] = await Promise.all([
    binding.activeRevisionId ? getPromptOverrideRevision(binding.activeRevisionId) : undefined,
    binding.draftRevisionId ? getPromptOverrideRevision(binding.draftRevisionId) : undefined,
  ])
  return { database, binding, active, draft }
}

/** Every slot of one prompt with its active revision, for the detail view, broadest scope first. */
export async function listPromptSlots(promptId: string): Promise<PromptSlotState[]> {
  const bindings = (await listPromptOverrideBindingsFor(promptId)).sort(
    (a, b) =>
      PROMPT_SCOPE_SPECIFICITY.indexOf(a.scope) - PROMPT_SCOPE_SPECIFICITY.indexOf(b.scope) ||
      a.targetId.localeCompare(b.targetId)
  )
  return Promise.all(bindings.map((binding) => readPromptSlot(promptId, binding)))
}

export { listPromptOverrideRevisions }
