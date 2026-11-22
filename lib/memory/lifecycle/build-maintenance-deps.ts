/**
 * Real-wiring factory for idle memory maintenance. Reuses
 * `buildAutoExtractionDeps` for the shared consolidator, a utility LLM client
 * for episodic distillation, and `lib/db/memories` for eviction.
 *
 * Returns `null` when no LLM client is available (the maintenance pass is then
 * skipped). Split into its own module so `maintenance.ts` can lazy-import it.
 */

import type { ChatSession, AppSettings } from "@cognia/agent-config-types"
import { classifySensitiveMemoryTopic } from "@cognia/memory/control-plane/sensitive-topics"
import type { MemoryConfig } from "@/types/memory/memory"
import type { MemoryMaintenanceDeps } from "./maintenance"
import {
  consolidationAuditAction,
  consolidationCorroboratedId,
  consolidationOpMemoryId,
} from "@/lib/memory/consolidate/consolidator"

export async function buildEpisodicMaintenanceDeps(
  params: {
    session: ChatSession | null | undefined
    appSettings: AppSettings | null | undefined
    /** Durable workers fence each canonical mutation in a source/claim transaction. */
    withCanonicalWrite?: <T>(write: () => Promise<T>) => Promise<T>
    /** Contamination state for canonical evidence bound inside `withCanonicalWrite`. */
    contaminationState?: import("@/types/memory/memory").MemoryContaminationState
  },
  config: MemoryConfig
): Promise<MemoryMaintenanceDeps | null> {
  const { buildUtilityLlmClient } = await import("@/lib/ai/generation/utility-client")
  const client = buildUtilityLlmClient({
    session: params.session ?? null,
    appSettings: params.appSettings ?? null,
    featureId: "memory-episodic-distill",
  })
  if (!client) return null

  const [
    { buildAutoExtractionDeps },
    { distillEpisodes },
    memDb,
    { createMemoryEvidence, appendMemoryAuditEvent },
    { recordMemoryCorroboration },
  ] = await Promise.all([
    import("@/lib/memory/write/run-memory-extraction"),
    import("@/lib/memory/write/run-episodic-distill"),
    import("@/lib/db/memories"),
    import("@/lib/db/memory-governance"),
    import("./record-memory-outcome"),
  ])

  const write = params.withCanonicalWrite ?? (<T>(operation: () => Promise<T>) => operation())
  const recordedMemoryIds = new Set<string>()
  const sessionId = params.session?.id
  const contamination = params.contaminationState ?? "clean"

  const applyOperationGovernance = async (
    operation: import("@/lib/memory/consolidate/consolidator").ConsolidationOp,
    targetSessionId: string | undefined,
    targetContamination: import("@/types/memory/memory").MemoryContaminationState
  ) => {
    const memoryId = consolidationOpMemoryId(operation)
    const auditAction = consolidationAuditAction(operation)
    if (!memoryId || !auditAction) return
    const text =
      operation.op === "ADD" || operation.op === "CONFLICT"
        ? (operation.memory.text ?? operation.candidate?.text ?? "")
        : ((await memDb.getMemory(memoryId).catch(() => undefined))?.text ?? "")
    const topic = classifySensitiveMemoryTopic(text)
    const quarantineSensitive = topic.sensitive && !config.allowSensitiveTopics
    await memDb.updateMemory(memoryId, {
      evidenceState: "supported",
      reviewStatus: operation.op === "CONFLICT" ? "conflict" : "unreviewed",
      contaminationState: targetContamination,
      sensitivity: topic.sensitive ? "sensitive" : "normal",
      ...(quarantineSensitive ? { trustState: "quarantined" } : {}),
    })
    await createMemoryEvidence({
      memoryId,
      kind: "message",
      sourceId: `session-distill:${targetSessionId ?? "unknown"}`,
      sessionId: targetSessionId,
      contaminationState: targetContamination,
      reviewed: false,
    })
    await appendMemoryAuditEvent({
      action: auditAction,
      memoryId,
      sessionId: targetSessionId,
      reason: quarantineSensitive ? "sensitive_topic_quarantined" : "session_distillation",
      ...(topic.sensitive ? { metadata: { sensitiveCategories: topic.categories.join(",") } } : {}),
    })
    recordedMemoryIds.add(memoryId)
  }

  const auto = await buildAutoExtractionDeps(
    {
      session: params.session,
      appSettings: params.appSettings,
      ...(params.withCanonicalWrite
        ? {
            withCanonicalWrite: params.withCanonicalWrite,
            recordCanonicalOperation: (operation) =>
              applyOperationGovernance(operation, sessionId, contamination),
          }
        : {}),
    },
    config
  )
  if (!auto) return null

  return {
    distillDeps: {
      ...(params.withCanonicalWrite ? { propagateErrors: true } : {}),
      distill: (transcript) => distillEpisodes(transcript, client),
      consolidate: auto.consolidate,
    },
    decayDeps: {
      listActive: (scope, namespace) =>
        memDb.listMemories({ scope, status: "active", ...namespace, exactNamespace: true }),
      invalidate: (id) => write(() => memDb.invalidateMemory(id)),
    },
    recordDistillation: async (input, operations) => {
      const contaminationState = input.contaminationState ?? contamination
      const pendingOps = operations.filter(
        (op) => !recordedMemoryIds.has(consolidationOpMemoryId(op) ?? "")
      )
      if (pendingOps.length === 0) return
      await write(async () => {
        for (const operation of pendingOps) {
          // An episode the judge found already recorded is a second witness for
          // it, not an edit: evidence only (see `recordMemoryCorroboration`).
          const corroborated = consolidationCorroboratedId(operation)
          if (corroborated) {
            await recordMemoryCorroboration({
              memoryId: corroborated,
              sessionId: input.source?.sessionId,
              contaminationState,
              evidence: {
                kind: "message",
                sourceId: `session-distill:${input.source?.sessionId ?? "unknown"}`,
              },
            })
            continue
          }
          await applyOperationGovernance(operation, input.source?.sessionId, contaminationState)
        }
      })
    },
    recordDecay: async ({ reason, memoryIds, sessionId: decaySessionId }) => {
      await write(async () => {
        for (const memoryId of memoryIds) {
          await appendMemoryAuditEvent({
            action: "invalidated",
            memoryId,
            sessionId: decaySessionId,
            reason,
          })
        }
      })
    },
  }
}
