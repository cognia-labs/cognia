/** Host consumers for presentation transforms and model-step decisions (ADR-0189). */
import { dispatchGuard, dispatchTransform, type InterceptorDispatchContext } from "./dispatch"
import type {
  AgentTurnDecisionInput,
  InterceptorGuardVerdict,
  PluginSurfaceProjection,
} from "./types"
import { InterceptorGuardDeniedError } from "./types"

export async function transformModelStreamPart<T>(
  part: T,
  context: InterceptorDispatchContext
): Promise<T> {
  context.signal?.throwIfAborted()
  if (!part || typeof part !== "object") return part
  const record = part as Record<string, unknown>
  if (record.type !== "text-delta" && record.type !== "reasoning-delta") return part
  const keys = ["text", "textDelta", "delta"].filter((key) => typeof record[key] === "string")
  if (!keys.length) return part
  const identity = { ...record }
  for (const key of keys) delete identity[key]
  const { value } = await dispatchTransform(
    "model.stream.transform",
    {
      sessionId: context.sessionId,
      operationId: context.operationId,
      identity,
      text: record[keys[0]] as string,
    },
    {
      ...context,
      invariantFields: ["sessionId", "operationId", "identity"],
      validateOutput: (value) => {
        if (typeof value.text !== "string") throw new Error("Stream projection must return text")
      },
    }
  )
  context.signal?.throwIfAborted()
  if (typeof value.text !== "string") throw new Error("Stream projection must return text")
  return { ...record, ...Object.fromEntries(keys.map((key) => [key, value.text])) } as T
}

export async function decideAgentTurn(
  payload: AgentTurnDecisionInput,
  context: InterceptorDispatchContext,
  requestApproval?: (
    verdict: Extract<InterceptorGuardVerdict, { decision: "requireApproval" }>
  ) => Promise<boolean>
): Promise<void> {
  const { verdict } = await dispatchGuard("agent.turn.decide", payload, {
    ...context,
    collectApprovals: true,
  })
  context.signal?.throwIfAborted()
  if (verdict.decision === "pass") return
  if (verdict.decision === "requireApproval") {
    let approved = false
    try {
      approved = (await requestApproval?.(verdict)) ?? false
    } catch {
      context.signal?.throwIfAborted()
    }
    if (approved) {
      context.signal?.throwIfAborted()
      return
    }
  }
  throw new InterceptorGuardDeniedError("agent.turn.decide", "host", verdict)
}

export type SurfaceProjection = PluginSurfaceProjection

export async function projectPluginSurface(
  value: SurfaceProjection,
  context: InterceptorDispatchContext
): Promise<SurfaceProjection> {
  const projected = await dispatchTransform("ui.surface.project", value, {
    ...context,
    invariantFields: ["point", "pluginId", "extensionId", "context"],
    validateOutput: (output) => {
      if (
        typeof output.presentation?.hidden !== "boolean" ||
        (output.presentation.title !== undefined && typeof output.presentation.title !== "string")
      )
        throw new Error("Invalid surface presentation")
    },
  })
  context.signal?.throwIfAborted()
  if (
    typeof projected.value.presentation?.hidden !== "boolean" ||
    (projected.value.presentation.title !== undefined &&
      typeof projected.value.presentation.title !== "string")
  )
    throw new Error("Invalid surface presentation")
  return projected.value
}
