/** Host-owned semantic seams reuse the lifecycle-hook round trip and permission waiter. */
import { randomUUID } from "node:crypto"
import { PLUGIN_INTERCEPTOR_REFUSED } from "@cognia/agent-config-types/plugin-interception"
import type { PendingPluginHooks } from "./kernel/types.ts"
import { runPluginHookHandler, PLUGIN_HOOK_BROADCAST } from "./handlers/plugin.ts"
import { awaitApproval, type PendingApproval } from "../policy/permission/approval.ts"

export class SemanticInterceptionError extends Error {
  readonly code = PLUGIN_INTERCEPTOR_REFUSED
  readonly pointId: "model.stream.transform" | "agent.turn.decide"
  constructor(pointId: "model.stream.transform" | "agent.turn.decide", reason: string) {
    super(reason)
    this.name = "SemanticInterceptionError"
    this.pointId = pointId
  }
}

export function createSemanticConsumers(input: {
  sessionId: string
  sendOptions: { semanticInterceptors?: readonly string[]; approvalTtlMs?: number }
  signal: AbortSignal
  pendingPluginHookCalls: PendingPluginHooks
  pendingApprovals: Map<string, PendingApproval>
  emit(frame: Record<string, unknown>): void
}) {
  const { signal, sendOptions, sessionId } = input
  const operationId = randomUUID()
  async function query(
    point: "model.stream.transform" | "agent.turn.decide",
    payload: Record<string, unknown>
  ) {
    signal.throwIfAborted()
    const execId = randomUUID()
    const cancel = () =>
      input.pendingPluginHookCalls.get(execId)?.resolve({ error: "Semantic operation cancelled" })
    signal.addEventListener("abort", cancel, { once: true })
    try {
      const outcome = await runPluginHookHandler(
        {
          type: "plugin",
          pluginId: PLUGIN_HOOK_BROADCAST,
          hookId: `interceptor:${point}`,
          timeout: point === "model.stream.transform" ? 2 : 6,
        },
        JSON.stringify({ ...payload, operationId }),
        {
          sessionId,
          pendingPluginHookCalls: input.pendingPluginHookCalls,
          emit: (frame) => input.emit({ ...frame }),
          newId: () => execId,
        }
      )
      signal.throwIfAborted()
      if (outcome.warning) throw new SemanticInterceptionError(point, outcome.warning)
      return outcome.pluginResult as Record<string, unknown> | undefined
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }
  return {
    async transform<T>(part: T): Promise<T> {
      const value = part as Record<string, unknown> | null
      if (
        !sendOptions.semanticInterceptors?.includes("model.stream.transform") ||
        (value?.type !== "text-delta" && value?.type !== "reasoning-delta")
      )
        return part
      const result = await query("model.stream.transform", { part })
      if (!result?.part || typeof result.part !== "object")
        throw new SemanticInterceptionError("model.stream.transform", "Missing stream projection")
      const projected = result.part as Record<string, unknown>
      const copy = { ...value }
      for (const key of ["text", "textDelta", "delta"])
        if (typeof value[key] === "string") {
          if (typeof projected[key] !== "string")
            throw new SemanticInterceptionError(
              "model.stream.transform",
              "Invalid stream projection text"
            )
          copy[key] = projected[key]
        }
      return copy as T
    },
    async beforeStep(step: number): Promise<void> {
      if (!sendOptions.semanticInterceptors?.includes("agent.turn.decide")) return
      let verdict: Record<string, unknown> | undefined
      try {
        verdict = await query("agent.turn.decide", { step })
      } catch (error) {
        signal.throwIfAborted()
        verdict = {
          decision: "requireApproval",
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      if (verdict?.decision === "pass") return
      const reason =
        typeof verdict?.reason === "string" ? verdict.reason : "Agent turn requires approval"
      if (verdict?.decision !== "requireApproval")
        throw new SemanticInterceptionError("agent.turn.decide", reason)
      const requestId = randomUUID()
      const approval = awaitApproval({
        pendingApprovals: input.pendingApprovals,
        requestId,
        signal,
        ttlMs: sendOptions.approvalTtlMs,
        entry: { input: { step }, suppressAlwaysAllowRule: true },
      })
      input.emit({
        type: "permission_request",
        sessionId,
        requestId,
        toolName: "agent.turn.decide",
        displayName: "agent.turn.decide",
        input: { step, reason },
        requiresApproval: true,
        requiresPerCallApproval: true,
        suppressAlwaysAllowRule: true,
        defaultToNo: true,
      })
      const answer = await approval
      signal.throwIfAborted()
      if (answer.behavior !== "allow")
        throw new SemanticInterceptionError("agent.turn.decide", reason)
    },
  }
}
