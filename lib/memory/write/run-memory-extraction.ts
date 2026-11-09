/**
 * Background memory-extraction orchestrator (the per-turn write path). Fire-and-
 * forget via the durable job queue after a turn completes. Failures propagate
 * to the worker's retry path; the foreground only enqueues and never waits.
 *
 * Pipeline (gates short-circuit cheaply, left → right):
 *   enabled/autoExtract/!temporary  →  provenance (inbound excluded)
 *   →  salience heuristic (no LLM unless worth it)  →  extract (LLM)
 *   →  PII gate (hasNoLeakingPii)  →  consolidate (ADD/UPDATE/DELETE/NOOP)
 *
 * The pure orchestrator (`runMemoryExtraction`) is dependency-injected for
 * testing; `buildAutoExtractionDeps` wires the real LLM client, retriever-backed
 * similarity, Dexie persistence, and (when embeddings are configured) vector
 * upsert so recalled memories are semantically searchable.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import type { MemoryConfig, MemoryProvenance, MemoryScope, MemoryType } from "@/types/memory/memory"
import { assessSalience } from "@/lib/memory/extract/salience"
import {
  extractMemories,
  MemoryExtractionError,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  type ExtractMemoriesInput,
  type MemoryCandidate,
} from "@/lib/memory/extract/extractor"
import {
  consolidate,
  CONSOLIDATE_DECIDE_SYSTEM_PROMPT,
  sameMemoryNamespace,
  type ConsolidateDeps,
  type ConsolidateInput,
  type ConsolidationOp,
} from "@/lib/memory/consolidate/consolidator"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"
import { hasNoLeakingPii, hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"

/**
 * The per-turn extractor's system prompt (ADR-0236). Account scope only: the
 * extract step receives the redacted turn and nothing that names its
 * workspace. The JSON shape the parser reads is asked for in the user prompt,
 * which stays code-owned.
 */
export const MEMORY_EXTRACT_PROMPT = definePrompt({
  id: "knowledge.memory.extract",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // Invalid protocol output is a retryable extraction failure.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  requiredFragments: ["JSON"],
  outputContract:
    "Sent as the system prompt of the per-turn extraction; the reply is parsed as JSON `memories` and a parse failure is retried by the durable job.",
  consumers: ["lib/memory/write/run-memory-extraction.ts"],
  defaultBody: MEMORY_EXTRACT_SYSTEM_PROMPT,
})

/**
 * The consolidation judge's system prompt (ADR-0236), shared by every write
 * path that consolidates (per-turn extraction, deliberate stores, episodic
 * distill, project mining). Account scope only, like the extractor.
 */
export const MEMORY_CONSOLIDATE_PROMPT = definePrompt({
  id: "knowledge.memory.consolidate",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // The verdict is parsed as JSON; an unusable one takes the failure mode.
  risk: "protocol",
  hosts: ["app"],
  maxChars: 4_000,
  requiredFragments: ["JSON"],
  outputContract:
    "Sent as the system prompt of the ADD/UPDATE/DELETE/CONFLICT/NOOP judge; the reply is parsed as JSON `op`/`targetId`/`mergedText`, and an unusable verdict adds the candidate (or quarantines it where the caller fails closed).",
  consumers: [
    "lib/memory/write/run-memory-extraction.ts",
    "lib/memory/write/run-project-mining.ts",
  ],
  defaultBody: CONSOLIDATE_DECIDE_SYSTEM_PROMPT,
})

/** The consolidation judge's system prompt for one consolidation. */
export async function resolveConsolidateSystemPrompt(): Promise<string> {
  return (await resolvePromptAsync(MEMORY_CONSOLIDATE_PROMPT)).text
}

export interface RunMemoryExtractionInput {
  rollingSummary?: string
  recentMessages?: { role: string; text: string }[]
  newPair: { userText: string; assistantText: string }
  scope: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  provenance: MemoryProvenance
  source?: { sessionId?: string; messageId?: string }
  config: MemoryConfig
}

export interface RunMemoryExtractionDeps {
  extract: (input: ExtractMemoriesInput) => Promise<MemoryCandidate[]>
  consolidate: (input: ConsolidateInput) => Promise<{ applied: ConsolidationOp[] }>
  /** PII gate; defaults to `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  /** Fail-closed gate for the complete redacted payload sent to the utility LLM. */
  isPayloadPiiSafe?: (value: unknown) => boolean
  /**
   * Redact PII from the extraction inputs *before* they reach the utility LLM.
   * Defaults to the twin redactor. The extraction model can differ from the
   * conversation model the user chose, so raw turn text must not be sent to it
   * verbatim — this matches the twin "redact before send" red-line.
   */
  redact?: (text: string) => string
}

/** Auto-extract emits semantic for everyone; procedural only for trusted provenance. */
function allowedTypes(provenance: MemoryProvenance): MemoryType[] {
  const types: MemoryType[] = ["semantic"]
  if (provenance === "user" || provenance === "explicit") types.push("procedural")
  return types
}

export async function runMemoryExtraction(
  input: RunMemoryExtractionInput,
  deps: RunMemoryExtractionDeps
): Promise<{ applied: ConsolidationOp[] }> {
  const empty = { applied: [] as ConsolidationOp[] }
  let phase: "extraction_provider_failed" | "extraction_consolidation_failed" =
    "extraction_provider_failed"
  try {
    const { config } = input
    if (!config.enabled || !config.autoExtract || config.temporary) return empty
    // Connector-inbound content is third-party — never auto-extracted.
    if (input.provenance === "inbound") return empty

    // Salience runs on the RAW text — it's a local heuristic (no model call) and
    // redaction would weaken its named-entity / specificity signals.
    const salience = assessSalience({
      userText: input.newPair.userText,
      assistantText: input.newPair.assistantText,
    })
    if (!salience.salient) return empty

    // Redact before the LLM extract call. PII spans become placeholders; the
    // rest of the turn is intact, so non-PII facts still extract normally.
    const redact = deps.redact ?? ((t: string) => redactText(t).redacted)
    const extractionInput: ExtractMemoriesInput = {
      rollingSummary: input.rollingSummary ? redact(input.rollingSummary) : undefined,
      recentMessages: input.recentMessages?.map((m) => ({ role: m.role, text: redact(m.text) })),
      newPair: {
        userText: redact(input.newPair.userText),
        assistantText: redact(input.newPair.assistantText),
      },
      allowTypes: allowedTypes(input.provenance),
    }
    const isPayloadPiiSafe = deps.isPayloadPiiSafe ?? hasNoLeakingPiiDeep
    if (!isPayloadPiiSafe(extractionInput)) return empty
    const candidates = await deps.extract(extractionInput)
    if (candidates.length === 0) return empty

    const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
    const safe = candidates.filter((c) => isPiiSafe(c.text))
    if (safe.length === 0) return empty

    phase = "extraction_consolidation_failed"
    return await deps.consolidate({
      candidates: safe,
      scope: input.scope,
      characterId: input.characterId,
      projectId: input.projectId,
      agentId: input.agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      provenance: input.provenance,
      source: input.source,
    })
  } catch (error) {
    if (error instanceof MemoryExtractionError) throw error
    throw new MemoryExtractionError(phase, error)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Real wiring
// ───────────────────────────────────────────────────────────────────────────

/**
 * Decide a session's provenance for auto-extraction. A session whose binding
 * marks it connector-driven is `inbound` (excluded); a plain local chat is
 * `user`.
 */
export function sessionProvenance(session: ChatSession | null | undefined): MemoryProvenance {
  return session?.platformBinding ? "inbound" : "user"
}

export interface BuildAutoExtractionDepsParams {
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Durable workers fence each canonical mutation in a source/claim transaction. */
  withCanonicalWrite?: <T>(write: () => Promise<T>) => Promise<T>
  /** Runs inside that same transaction, before any vector I/O or next candidate. */
  recordCanonicalOperation?: (operation: ConsolidationOp) => Promise<void>
}

/**
 * Wire the real extract + consolidate dependencies. Returns `null` when no
 * utility LLM client can be built (e.g. no model configured) — the caller then
 * skips extraction entirely.
 */
export async function buildAutoExtractionDeps(
  params: BuildAutoExtractionDepsParams,
  config: MemoryConfig
): Promise<RunMemoryExtractionDeps | null> {
  const { buildUtilityLlmClient } = await import("@/lib/ai/generation/utility-client")
  const client = buildUtilityLlmClient({
    session: params.session ?? null,
    appSettings: params.appSettings ?? null,
    featureId: "memory-extraction",
  })
  if (!client) return null

  const [
    { tryBuildMemoryDeps, tryBuildMemoryVectorSink, withPersonalMemoryVisibility },
    { retrieveMemories },
    memDb,
  ] = await Promise.all([
    import("@/lib/memory/runtime/build-deps"),
    import("@/lib/memory/retrieve/retriever"),
    import("@/lib/db/memories"),
  ])
  const [memDeps, vectorSink] = await Promise.all([
    tryBuildMemoryDeps(config),
    tryBuildMemoryVectorSink(config),
  ])

  const { resolvePersistedAgentMemoryPolicy, consolidationPermissionsForAgent } =
    await import("@/lib/memory/agent-policy")
  const permissions = consolidationPermissionsForAgent(
    await resolvePersistedAgentMemoryPolicy({
      config,
      characterId: params.session?.characterId,
      sessionId: params.session?.id,
    })
  )
  const write = params.withCanonicalWrite ?? (<T>(operation: () => Promise<T>) => operation())

  const consolidateDeps: ConsolidateDeps = {
    client,
    auditDowngrade: async (memoryId, targetId, reason) => {
      const { appendMemoryAuditEvent } = await import("@/lib/db/memory-governance")
      await write(() =>
        appendMemoryAuditEvent({ action: "conflict", memoryId, reason, metadata: { targetId } })
      )
    },
    findSimilar: async (candidate, namespace) => {
      if (!memDeps) return []
      const hits = await retrieveMemories(
        {
          queryText: candidate.text,
          reader: namespace,
          topK: 5,
          relevanceFloor: 0,
          types: [candidate.type],
          // CROSS-CORPUS GUARD, mirroring the project miner's. Without it the
          // judge can be shown a mined project claim and answer UPDATE, folding
          // a fact about the repo into a memory the user stated about
          // themselves — and the row keeps its personal identity, so it goes on
          // rendering under "What you remember about the user".
          claimFilter: "personal-only",
          // A similarity lookup for the judge, not a recall: the user's recall
          // preferences (LLM rerank, session routing, belief weight) do not apply.
          rerank: false,
          sessionRecallRouting: false,
          beliefRankingWeight: 0,
        },
        withPersonalMemoryVisibility(memDeps)
      ).catch(() => [])
      return hits.map((h) => h.memory).filter((memory) => sameMemoryNamespace(memory, namespace))
    },
    persist: async (pInput) => {
      const row = await write(async () => {
        const memory = await memDb.createMemory(pInput)
        const candidate = { type: pInput.type, text: pInput.text, importance: pInput.importance }
        const targetId = pInput.conflictWithIds?.[0]
        await params.recordCanonicalOperation?.(
          pInput.reviewStatus === "conflict" && targetId
            ? { op: "CONFLICT", memory, targetId, candidate }
            : { op: "ADD", memory, candidate }
        )
        return memory
      })
      // Make the new memory semantically searchable when embeddings are
      // configured. Best-effort: a vector failure must not lose the memory.
      if (vectorSink && hasNoLeakingPii(row.text)) {
        try {
          await vectorSink.upsert(row.id, row.text)
          await write(() =>
            memDb.updateMemory(row.id, {
              vectorDocId: row.id,
              vectorTextHash: hashContent(row.text),
            })
          )
        } catch {
          // BM25 recall still works without the vector.
        }
      }
      return row
    },
    update: async (id, text) => {
      if (!hasNoLeakingPii(text)) return
      await write(async () => {
        await memDb.updateMemory(id, { text, bumpVersion: true, revisionReason: "consolidation" })
        await params.recordCanonicalOperation?.({ op: "UPDATE", targetId: id })
      })
      if (vectorSink) {
        try {
          await vectorSink.upsert(id, text)
          await write(() =>
            memDb.updateMemory(id, { vectorDocId: id, vectorTextHash: hashContent(text) })
          )
        } catch {
          // ignore — keep the Dexie update
        }
      }
    },
    invalidate: (id, supersededById) => write(() => memDb.invalidateMemory(id, supersededById)),
    markConflict: (targetId, conflictId) =>
      write(async () => {
        const target = await memDb.getMemory(targetId)
        if (!target) return
        await memDb.updateMemory(targetId, {
          reviewStatus: "conflict",
          conflictWithIds: [...new Set([...(target.conflictWithIds ?? []), conflictId])],
        })
      }),
  }

  return {
    extract: async (eInput) =>
      extractMemories(
        { ...eInput, systemPrompt: (await resolvePromptAsync(MEMORY_EXTRACT_PROMPT)).text },
        client
      ),
    consolidate: async (cInput) =>
      consolidate(
        { ...cInput, permissions: cInput.permissions ?? permissions },
        {
          ...consolidateDeps,
          decideSystemPrompt: await resolveConsolidateSystemPrompt(),
        }
      ),
  }
}
