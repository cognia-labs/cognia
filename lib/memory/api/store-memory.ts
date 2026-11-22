/**
 * Shared deliberate-write path for the long-term memory store — the single
 * implementation behind every non-conversational write surface: the workflow
 * `action.memory.store` node, the plugin `ctx.memory.store` API, the MCP
 * bridge `memory_store` tool, and the companion RPC `memory_store` command.
 *
 * Mirrors the `/remember` explicit-capture contract: the text IS the memory
 * (no extraction LLM), but it still flows through the SAME consolidator so it
 * dedupes / updates / supersedes instead of blindly piling up. When no utility
 * LLM client is available it degrades to a direct Dexie insert + best-effort
 * vector upsert (`consolidated: false`) — the memory is never silently dropped.
 *
 * Trust model (ADR-0069):
 *   - `procedural` requires `user`/`explicit` provenance — API surfaces and
 *     automated workflows may not silently rewrite agent behavior.
 *   - The PII gate is mandatory. External surfaces get "block" only (they
 *     cannot consent to redaction on the user's behalf); the workflow node
 *     additionally supports "redact".
 *   - Policy blocks (disabled / temporary / PII) return a structured result;
 *     caller programming errors (empty text, bad scope combo, untrusted
 *     procedural) throw.
 */

import type {
  MemoryProvenance,
  MemoryScope,
  MemorySourceChannel,
  MemoryType,
} from "@/types/memory/memory"
import { memoryRowWithinNamespaces, type TrustedMemoryCaller } from "@cognia/memory/types/caller"
import { captureDatabaseScope, type DatabaseScopeSnapshot } from "@/lib/db/schema"
import { localUserCaller, resolveMemoryCaller } from "./caller"
import {
  consolidationCorroboratedId,
  consolidationOpMemoryId,
  type ConsolidationOp,
} from "@/lib/memory/consolidate/consolidator"
import { withConsolidationTarget } from "@/lib/memory/write/guarded-consolidation-write"
import type {
  StoreExternalMemoryInput,
  StoreMemoryCoreResult,
} from "@cognia/plugin-contract/lib/memory/api/store-memory"
export type {
  StoreExternalMemoryInput,
  StoreMemoryCoreResult,
} from "@cognia/plugin-contract/lib/memory/api/store-memory"

export interface MemoryAttribution {
  channel: MemorySourceChannel
  /** Set when `channel === "plugin"`. */
  pluginId?: string
}

export interface StoreMemoryCoreInput {
  text: string
  scope?: MemoryScope
  /** Required when `scope === "character"`. */
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  type?: MemoryType
  /** Stable key for procedural dedupe / "always X" overrides. */
  key?: string
  /** 1..10, clamped (default 7 — /remember's explicit-capture weight). */
  importance?: number
  tags?: string[]
  provenance: MemoryProvenance
  /** PII gate mode; external surfaces must use "block". */
  piiGate?: "block" | "redact"
  source?: { sessionId?: string; messageId?: string }
  attribution?: MemoryAttribution
  /** Agent whose CRUD/scope policy governs this write. */
  policyCharacterId?: string
  /**
   * Host-bound session for policy resolution. Kept separate from
   * `source.sessionId`: `source` is provenance (which conversation produced
   * the fact), this is the session whose memory toggles the caller is bound
   * to — external callers must not choose it themselves.
   *
   * `null` means "no session binding, explicitly": without it, an absent
   * value falls back to `source.sessionId`, which would let a request pick
   * the session whose toggles govern the write.
   */
  policySessionId?: string | null
  /**
   * Why the caller chose this scope, from `resolveMemoryWriteTarget`. Persisted
   * so the inspector can explain a narrowed scope. Callers that already know
   * their exact target (workflow node, plugin, MCP, RPC) leave it unset.
   */
  scopeRationale?: string
  /**
   * Host-bound caller identity (`lib/memory/api/caller.ts`). When present, its
   * `policyCharacterId` / `sessionId` govern policy resolution and a
   * `namespaces` set constrains which namespace the write may land in —
   * request fields can only narrow, never grant. Absent on in-process callers
   * acting as the account owner (slash command, /remember).
   */
  caller?: TrustedMemoryCaller
  /** Originating database partition/epoch scope, captured at command entry. */
  databaseScope?: DatabaseScopeSnapshot
  /** Composite `${principalId}:${operationId}` stamped on audit rows for crash recovery. */
  operationKey?: string
  /** Optional transactional envelope committing canonical Dexie writes and receipt together. */
  withCanonicalCommit?: <T>(apply: () => Promise<T>) => Promise<T>
  /** Invoked inside the canonical Dexie transaction once the outcome is known. */
  onCanonicalApplied?: (outcome: {
    stored: boolean
    consolidated: boolean
    memoryId?: string
    applied: ConsolidationOp["op"][]
    piiRedacted?: boolean
  }) => Promise<void>
}

export function clampImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 7
  return Math.min(10, Math.max(1, Math.round(value)))
}

/** Only this failure proves that retrying cannot duplicate a canonical write. */
export class MemoryPreWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "MemoryPreWriteError"
  }
}

export async function storeMemoryCore(input: StoreMemoryCoreInput): Promise<StoreMemoryCoreResult> {
  let writeStarted = false
  try {
    return await applyStoreMemory(input, () => {
      writeStarted = true
    })
  } catch (error) {
    // A consolidator may commit one candidate before a later step throws.
    // Never infer rollback from its rejection (or from a direct insert's).
    if (!writeStarted) throw new MemoryPreWriteError(error)
    throw error
  }
}

async function applyStoreMemory(
  input: StoreMemoryCoreInput,
  beforeWrite: () => void
): Promise<StoreMemoryCoreResult> {
  const dbScope = input.databaseScope ?? captureDatabaseScope()
  dbScope.assertActive()
  const rawText = input.text.trim()
  if (!rawText) throw new Error("memory store requires a non-empty 'text'")
  const scope = input.scope ?? "global"
  if (scope === "character" && !input.characterId) {
    throw new Error("memory store: 'characterId' is required when scope is 'character'")
  }
  if (scope === "workspace" && !input.projectId) {
    throw new Error("memory store: 'projectId' is required when scope is 'workspace'")
  }
  if (scope === "agent" && !input.agentId) {
    throw new Error("memory store: 'agentId' is required when scope is 'agent'")
  }
  const type: MemoryType = input.type ?? "semantic"
  if (type === "procedural" && input.provenance !== "user" && input.provenance !== "explicit") {
    throw new Error(
      "memory store: procedural memories require user/explicit provenance — " +
        "API surfaces and automated workflows may not silently rewrite agent behavior."
    )
  }

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings()
  dbScope.assertActive()
  const config = resolveMemoryConfig(settings?.memory)
  const caller = resolveMemoryCaller(input.caller ?? localUserCaller(), config)
  if (type === "procedural" && caller.pairedReader === "member") {
    return { ok: false, reason: "policy_denied" }
  }
  // A bound caller constrains the write's namespace — request fields narrow
  // the caller's authorization set, they can never widen it.
  if (
    caller.namespaces &&
    !memoryRowWithinNamespaces(
      {
        scope,
        projectId: input.projectId,
        characterId: input.characterId,
        agentId: input.agentId,
      },
      caller.namespaces
    )
  ) {
    return { ok: false, reason: "unauthorized_namespace" }
  }

  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }
  const { resolvePersistedAgentMemoryPolicy, scopeAllowedByAgentMemoryPolicy } =
    await import("@/lib/memory/agent-policy")
  const policy = await resolvePersistedAgentMemoryPolicy({
    config,
    // The governing Agent comes from the caller binding first — a request's
    // `agentId`/`characterId` namespace fields are only the fallback for
    // unbound in-process callers.
    characterId:
      input.caller?.policyCharacterId ??
      input.policyCharacterId ??
      input.agentId ??
      input.characterId,
    // Session binding precedence: an explicit `null` suppresses; a bound
    // caller contributes ONLY its own sessionId — when it has none, the
    // request's `source.sessionId` (caller-chosen provenance) must NOT leak
    // in as the policy session. Only caller-less in-process writes inherit
    // provenance, matching the pre-binding behavior.
    sessionId:
      input.policySessionId === null
        ? undefined
        : input.caller
          ? (input.caller.sessionId ?? undefined)
          : (input.policySessionId ?? input.source?.sessionId),
  })
  if (!policy.canCreate) return { ok: false, reason: "policy_denied" }
  if (!scopeAllowedByAgentMemoryPolicy(policy, "create", scope)) {
    return { ok: false, reason: "scope_denied" }
  }

  // PII gate — mandatory on the write path (memory text persists durably).
  const { hasNoLeakingPii, redactText } = await import("@cognia/redact")
  // Audit the block so the settings pane can report "N writes withheld".
  // Content-free by construction: only the provenance and the reason, never the
  // text that tripped the gate. Fires only on a block, so this is not a hot path.
  const auditPiiBlock = async () => {
    const { appendMemoryAuditEvent } = await import("@/lib/db/memory-governance")
    await appendMemoryAuditEvent({
      action: "learn-denied",
      sessionId: input.source?.sessionId,
      reason: "pii_blocked",
      metadata: { provenance: input.provenance, type },
    }).catch(() => undefined)
  }
  let text = rawText
  let piiRedacted = false
  if ((input.piiGate ?? "block") === "block") {
    if (!hasNoLeakingPii(rawText)) {
      await auditPiiBlock()
      return { ok: false, reason: "pii_blocked" }
    }
  } else {
    const result = redactText(rawText)
    text = result.redacted
    piiRedacted = Object.keys(result.map).length > 0
    if (!hasNoLeakingPii(text)) {
      await auditPiiBlock()
      return { ok: false, reason: "pii_blocked" }
    }
  }

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const candidate = {
    type,
    text,
    importance: clampImportance(input.importance),
    ...(input.key ? { key: input.key } : {}),
  }
  const characterId = scope === "character" ? input.characterId : undefined
  const projectId = input.projectId
  const agentId = scope === "agent" ? input.agentId : undefined
  const expectedNamespace = {
    scope,
    characterId,
    projectId,
    agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
  }

  // Preferred path: the shared consolidator (dedupe / ADD / UPDATE / DELETE).
  const { buildAutoExtractionDeps } = await import("@/lib/memory/write/run-memory-extraction")
  const runCommit = input.withCanonicalCommit ?? (<T>(apply: () => Promise<T>) => apply())
  const auditMetadata = {
    ...(input.operationKey ? { operationKey: input.operationKey, consolidated: true } : {}),
    ...(piiRedacted ? { piiRedacted: true } : {}),
  }
  let canonicalReceiptWritten = false
  const deps = await buildAutoExtractionDeps(
    {
      session: null,
      appSettings: settings,
      ...(input.withCanonicalCommit
        ? {
            withCanonicalWrite: (write) => runCommit(write),
            recordCanonicalOperation: async (op) => {
              const id = consolidationOpMemoryId(op)
              if (!id) return
              const governance = await import("@/lib/db/memory-governance")
              if (Object.keys(postAddPatch).length > 0 && op.op === "ADD") {
                await memDb.updateMemory(id, postAddPatch)
              }
              await memDb.updateMemory(id, {
                evidenceState: "supported",
                reviewStatus:
                  op.op === "CONFLICT"
                    ? "conflict"
                    : input.provenance === "explicit"
                      ? "verified"
                      : "unreviewed",
                contaminationState: input.provenance === "external" ? "external-context" : "clean",
                sensitivity: "normal",
              })
              await governance.createMemoryEvidence({
                memoryId: id,
                kind: input.provenance === "external" ? "external" : "manual",
                sourceId:
                  input.source?.messageId ??
                  input.source?.sessionId ??
                  input.attribution?.pluginId ??
                  input.attribution?.channel ??
                  `manual:${id}`,
                sessionId: input.source?.sessionId,
                messageId: input.source?.messageId,
                contaminationState: input.provenance === "external" ? "external-context" : "clean",
                reviewed: input.provenance === "explicit",
              })
              await governance.appendMemoryAuditEvent({
                action:
                  op.op === "CONFLICT" ? "conflict" : op.op === "UPDATE" ? "revised" : "created",
                memoryId: id,
                sessionId: input.source?.sessionId,
                reason: op.op === "CONFLICT" ? (op.reason ?? input.provenance) : input.provenance,
                ...(Object.keys(auditMetadata).length > 0 ? { metadata: auditMetadata } : {}),
              })
              await input.onCanonicalApplied?.({
                stored: true,
                consolidated: true,
                memoryId: op.op === "ADD" || op.op === "CONFLICT" ? id : undefined,
                applied: [op.op],
                ...(piiRedacted ? { piiRedacted: true } : {}),
              })
              canonicalReceiptWritten = true
            },
          }
        : {}),
    },
    config
  )
  const memDb = await import("@/lib/db/memories")
  const postAddPatch = {
    ...(tags.length > 0 ? { tags } : {}),
    ...(input.scopeRationale ? { scopeRationale: input.scopeRationale } : {}),
  }
  dbScope.assertActive()
  if (deps) {
    beforeWrite()
    const { applied } = await deps.consolidate({
      permissions: {
        canUpdate: policy.canUpdate,
        canForget: policy.canForget,
        scopeAllowed: (operation, targetScope) =>
          scopeAllowedByAgentMemoryPolicy(policy, operation, targetScope),
      },
      candidates: [candidate],
      scope,
      characterId,
      projectId,
      agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      provenance: input.provenance,
      source: input.source,
      attribution: input.attribution,
    })
    if (!canonicalReceiptWritten && Object.keys(postAddPatch).length > 0) {
      for (const op of applied) {
        if (op.op === "ADD" && op.memory?.id) {
          try {
            await withConsolidationTarget(
              op.memory.id,
              { expected: expectedNamespace },
              "update",
              () => memDb.updateMemory(op.memory.id, postAddPatch)
            )
          } catch {
            // Best-effort, the memory row itself already landed.
          }
        }
      }
    }
    const added = applied.find(
      (op): op is Extract<ConsolidationOp, { op: "ADD" | "CONFLICT" }> =>
        op.op === "ADD" || op.op === "CONFLICT"
    )
    const memoryId = added?.memory?.id
    const governedIds = applied.flatMap((op) => {
      const id = consolidationOpMemoryId(op)
      return id ? [id] : []
    })
    if (!canonicalReceiptWritten && governedIds.length > 0 && dbScope.isActive()) {
      try {
        const governance = await import("@/lib/db/memory-governance")
        for (const id of governedIds) {
          // Consolidation committed before vector I/O. A later relocation must
          // also fence these follow-up patches to the original target.
          await withConsolidationTarget(
            id,
            {
              expected: expectedNamespace,
              ...(applied.some((op) => op.op === "UPDATE" && op.targetId === id)
                ? {
                    permissions: {
                      canUpdate: policy.canUpdate,
                      canForget: policy.canForget,
                      scopeAllowed: (operation, targetScope) =>
                        scopeAllowedByAgentMemoryPolicy(policy, operation, targetScope),
                    },
                  }
                : {}),
            },
            "update",
            async () => {
              await memDb.updateMemory(id, {
                evidenceState: "supported",
                reviewStatus: applied.some((op) => op.op === "CONFLICT" && op.memory.id === id)
                  ? "conflict"
                  : input.provenance === "explicit"
                    ? "verified"
                    : "unreviewed",
                contaminationState: input.provenance === "external" ? "external-context" : "clean",
                sensitivity: "normal",
              })
              await governance.createMemoryEvidence({
                memoryId: id,
                kind: input.provenance === "external" ? "external" : "manual",
                sourceId:
                  input.source?.messageId ??
                  input.source?.sessionId ??
                  input.attribution?.pluginId ??
                  input.attribution?.channel ??
                  `manual:${id}`,
                sessionId: input.source?.sessionId,
                messageId: input.source?.messageId,
                contaminationState: input.provenance === "external" ? "external-context" : "clean",
                reviewed: input.provenance === "explicit",
              })
              await governance.appendMemoryAuditEvent({
                action: applied.some((op) => op.op === "CONFLICT" && op.memory.id === id)
                  ? "conflict"
                  : applied.some((op) => op.op === "UPDATE" && op.targetId === id)
                    ? "revised"
                    : "created",
                memoryId: id,
                sessionId: input.source?.sessionId,
                reason:
                  applied.find(
                    (op): op is Extract<ConsolidationOp, { op: "CONFLICT" }> =>
                      op.op === "CONFLICT" && op.memory.id === id
                  )?.reason ?? input.provenance,
                ...(Object.keys(auditMetadata).length > 0 ? { metadata: auditMetadata } : {}),
              })
            }
          )
        }
      } catch {
        // The canonical memory already landed; governance persistence retries separately.
      }
    }
    // A deliberate capture of something already remembered is a new witness
    // for that memory (belief strength), not an edit of it.
    const corroboratedIds = applied.flatMap((op) => {
      const id = consolidationCorroboratedId(op)
      return id ? [id] : []
    })
    if (corroboratedIds.length > 0 && dbScope.isActive()) {
      await runCommit(async () => {
        const { recordMemoryCorroboration } =
          await import("@/lib/memory/lifecycle/record-memory-outcome")
        for (const id of corroboratedIds) {
          await recordMemoryCorroboration({
            memoryId: id,
            sessionId: input.source?.sessionId,
            contaminationState: input.provenance === "external" ? "external-context" : "clean",
            evidence: {
              kind: input.provenance === "external" ? "external" : "manual",
              sourceId:
                input.source?.messageId ??
                input.source?.sessionId ??
                input.attribution?.pluginId ??
                input.attribution?.channel ??
                `manual:${id}`,
            },
          })
        }
      })
    }
    return {
      ok: true,
      stored: applied.some((op) => op.op !== "NOOP"),
      consolidated: true,
      ...(memoryId ? { memoryId } : {}),
      applied: applied.map((op) => op.op),
      ...(piiRedacted ? { piiRedacted: true } : {}),
    }
  }

  // Degraded path: no utility LLM client → direct insert (BM25-findable) +
  // best-effort vector upsert. The fact still lands; only dedupe is skipped.
  const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
  const governance = await import("@/lib/db/memory-governance")
  dbScope.assertActive()
  let degradedCommitted = false
  const applyDegradedGovernance = async (created: { id: string }) => {
    await input.onCanonicalApplied?.({
      stored: true,
      consolidated: false,
      memoryId: created.id,
      applied: ["ADD"],
      ...(piiRedacted ? { piiRedacted: true } : {}),
    })
    await governance.createMemoryEvidence({
      memoryId: created.id,
      kind: input.provenance === "external" ? "external" : "manual",
      sourceId:
        input.source?.messageId ??
        input.source?.sessionId ??
        input.attribution?.pluginId ??
        input.attribution?.channel ??
        `manual:${created.id}`,
      sessionId: input.source?.sessionId,
      messageId: input.source?.messageId,
      contaminationState: input.provenance === "external" ? "external-context" : "clean",
      reviewed: input.provenance === "explicit",
    })
    const degradedAuditMeta = {
      ...(input.operationKey ? { operationKey: input.operationKey, consolidated: false } : {}),
      ...(piiRedacted ? { piiRedacted: true } : {}),
    }
    await governance.appendMemoryAuditEvent({
      action: "created",
      memoryId: created.id,
      sessionId: input.source?.sessionId,
      reason: input.provenance,
      ...(Object.keys(degradedAuditMeta).length > 0 ? { metadata: degradedAuditMeta } : {}),
    })
    degradedCommitted = true
  }
  const createDraft = {
    scope,
    characterId,
    projectId,
    agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
    type,
    text,
    importance: candidate.importance,
    key: input.key,
    tags,
    provenance: input.provenance,
    sourceSessionId: input.source?.sessionId,
    sourceMessageId: input.source?.messageId,
    sourceChannel: input.attribution?.channel,
    sourcePluginId: input.attribution?.pluginId,
    evidenceState: "supported" as const,
    reviewStatus: input.provenance === "explicit" ? ("verified" as const) : ("unreviewed" as const),
    contaminationState:
      input.provenance === "external" ? ("external-context" as const) : ("clean" as const),
    sensitivity: "normal" as const,
    ...(input.scopeRationale ? { scopeRationale: input.scopeRationale } : {}),
  }
  beforeWrite()
  const row = input.withCanonicalCommit
    ? await memDb.createMemory(createDraft, async (created) => {
        await runCommit(() => applyDegradedGovernance(created))
      })
    : await memDb.createMemory(createDraft)
  if (!degradedCommitted) {
    await runCommit(() => applyDegradedGovernance(row))
  }
  const sink = await tryBuildMemoryVectorSink(config)
  if (sink) {
    try {
      await sink.upsert(row.id, row.text)
      if (dbScope.isActive()) {
        await memDb.updateMemory(row.id, { vectorDocId: row.id })
      }
    } catch {
      // BM25 recall still works without the vector, but the row is now missing
      // from the index. Report the drift so the reconcile threshold can fire.
      if (dbScope.isActive()) {
        const { noteMemoryVectorFailure } = await import("@/lib/memory/lifecycle/enqueue-reconcile")
        if (dbScope.isActive()) noteMemoryVectorFailure()
      }
    }
  }
  return {
    ok: true,
    stored: true,
    consolidated: false,
    memoryId: row.id,
    applied: ["ADD"],
    ...(piiRedacted ? { piiRedacted: true } : {}),
  }
}

/**
 * The external-surface wrapper: provenance `external`, block-only PII gate,
 * semantic/episodic only. Used by the plugin API, MCP handler, and RPC bridge.
 *
 * `caller` is the host-bound identity (`lib/memory/api/caller.ts`): its
 * `policyCharacterId` / `sessionId` govern policy resolution, and when it
 * carries a `namespaces` set the target namespace must sit inside it — a
 * request can never write a memory into a namespace the caller was not
 * authorized for.
 */
export async function storeExternalMemory(
  input: StoreExternalMemoryInput,
  attribution: MemoryAttribution,
  caller?: TrustedMemoryCaller
): Promise<StoreMemoryCoreResult> {
  if ((input.type as MemoryType | undefined) === "procedural") {
    throw new Error("memory store: external surfaces may not create procedural memories.")
  }
  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  caller = resolveMemoryCaller(
    caller ?? localUserCaller(),
    resolveMemoryConfig((await getSettings())?.memory)
  )
  if (
    caller?.namespaces &&
    !memoryRowWithinNamespaces(
      {
        scope: input.scope ?? "global",
        projectId: input.projectId,
        characterId: input.characterId,
        agentId: input.agentId,
      },
      caller.namespaces
    )
  ) {
    return { ok: false, reason: "unauthorized_namespace" }
  }

  // Idempotent replay + mutual exclusion: the create cannot share
  // `runMemoryMutation`'s transaction (the consolidator runs async work), so
  // the operation key is RESERVED before executing — a concurrent identical
  // call observes `in_flight` and waits for our receipt instead of running a
  // second consolidation. A recorded receipt replays; a conflicting one
  // refuses.
  const principalId = caller?.principalId ?? "local-user"
  const operationId = input.operationId
  const operationKey = operationId ? `${principalId}:${operationId}` : undefined
  let requestHash: string | undefined
  if (operationId) {
    const ledger = await import("@/lib/db/memory-operations")
    const { operationId: _operationId, ...request } = input
    // Hash the EFFECTIVE request, not the raw payload — the core trims text
    // and tags and clamps importance before apply, so requests differing only
    // in those normalizations are the same operation, not a conflict.
    requestHash = await ledger.memoryOperationRequestHash("store", {
      ...request,
      text: request.text.trim(),
      importance: clampImportance(request.importance),
      ...(request.tags ? { tags: request.tags.map((t) => t.trim()).filter(Boolean) } : {}),
    })
    // Replay the receipt's RECORDED outcome, not a generic success shape — a
    // first call that degraded to a direct insert must still answer
    // `consolidated: false` on the retry.
    const replay = (receipt: {
      memoryId: string
      resultConsolidated?: boolean
      resultStored?: boolean
      resultApplied?: string[]
    }) => ({
      ok: true as const,
      stored: receipt.resultStored ?? true,
      consolidated: receipt.resultConsolidated ?? true,
      ...(receipt.memoryId ? { memoryId: receipt.memoryId } : {}),
      applied: (receipt.resultApplied ?? []) as ConsolidationOp["op"][],
    })
    const binding = {
      principalId,
      operationId,
      requestHash,
      kind: "store" as const,
    }
    let reservation = await ledger.reserveMemoryOperation(binding)
    if (reservation.state === "in_flight") {
      const settled = await ledger.awaitMemoryOperation(principalId, operationId)
      if (settled) {
        reservation = { state: "replay", receipt: settled }
      } else {
        const reconciled = await ledger.reconcilePendingMemoryOperation(binding)
        if (reconciled.state === "conflict") {
          return { ok: false, reason: "idempotency_key_reused" }
        }
        if (reconciled.state === "recovered") {
          return replay(reconciled.receipt)
        }
        reservation = await ledger.reserveMemoryOperation(binding, {
          allowReclaim: reconciled.state === "unapplied",
        })
      }
    }
    if (reservation.state === "conflict") {
      return { ok: false, reason: "idempotency_key_reused" }
    }
    if (reservation.state === "replay") return replay(reservation.receipt)
    if (reservation.state === "in_flight") {
      throw new Error("memory_store: operation still in flight")
    }
  }

  const ledger = operationId ? await import("@/lib/db/memory-operations") : undefined
  const releaseInFlight =
    operationKey && ledger
      ? ledger.markMemoryOperationInFlight(operationKey, requestHash)
      : undefined
  let receiptCommitted = false
  let atomicEnvelopeUsed = false
  let result: StoreMemoryCoreResult
  try {
    result = await storeMemoryCore({
      text: input.text,
      type: input.type ?? "semantic",
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      key: input.key,
      importance: input.importance,
      tags: input.tags,
      provenance: "external",
      piiGate: "block",
      source: input.source,
      // The caller binding drives policy resolution inside the core: a bound
      // caller without a sessionId yields NO policy session — the request's
      // `source.sessionId` provenance can never substitute for it.
      caller,
      attribution,
      ...(operationKey && operationId && requestHash && ledger
        ? {
            operationKey,
            withCanonicalCommit: async <T>(apply: () => Promise<T>) => {
              atomicEnvelopeUsed = true
              return ledger.withMemoryStoreTransaction(apply)
            },
            onCanonicalApplied: async (appliedOutcome) => {
              await ledger.recordMemoryOperation({
                id: operationKey,
                principalId,
                operationId,
                kind: "store",
                requestHash: requestHash!,
                memoryId: appliedOutcome.memoryId ?? "",
                resultCode: "ok",
                resultStored: appliedOutcome.stored,
                resultConsolidated: appliedOutcome.consolidated,
                resultApplied: appliedOutcome.applied,
                createdAt: Date.now(),
              })
              receiptCommitted = true
            },
          }
        : {}),
    })
  } catch (error) {
    releaseInFlight?.()
    // Atomic canonical+receipt rollback or pre-write validation left zero side effects.
    if (
      (atomicEnvelopeUsed || error instanceof MemoryPreWriteError) &&
      operationId &&
      requestHash &&
      ledger
    ) {
      await ledger
        .releaseMemoryOperation(principalId, operationId, requestHash)
        .catch(() => undefined)
    }
    throw error
  } finally {
    releaseInFlight?.()
  }

  if (operationId && requestHash && ledger) {
    if (result.ok && result.stored) {
      if (receiptCommitted) {
        ledger.clearStagedMemoryOperation(operationKey!)
        return result
      }
      const receipt = {
        id: operationKey!,
        principalId,
        operationId,
        kind: "store" as const,
        requestHash,
        memoryId: result.memoryId ?? "",
        resultCode: "ok" as const,
        resultStored: result.stored,
        resultConsolidated: result.consolidated,
        resultApplied: result.applied,
        createdAt: Date.now(),
      }
      let receiptError: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await ledger.recordMemoryOperation(receipt)
          ledger.clearStagedMemoryOperation(operationKey!)
          return result
        } catch (error) {
          receiptError = error
        }
      }
      ledger.stageAppliedMemoryOperation(receipt)
      const { MemoryReceiptCommitError } = await import("./manage-for-caller")
      throw new MemoryReceiptCommitError(receiptError, "memory_store")
    } else {
      await ledger
        .releaseMemoryOperation(principalId, operationId, requestHash)
        .catch(() => undefined)
    }
  }
  return result
}
