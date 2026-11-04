import type { AgentRuntimePolicy } from "@cognia/agent-contracts/runtime-policy"
import { piRpcExtension } from "./rpc-client"
export const piRuntimePolicy: AgentRuntimePolicy = {
  discoverModels: async (adapter) => {
    const pi = piRpcExtension.resolve(adapter)
    if (!pi) return undefined
    const models = await pi.listAgentModelsViaRpc()
    if (models) return { kind: "session-models", models }
    const listing = await pi.listAgentModels()
    if (listing.status !== "ok") throw new Error("Pi's model listing was unreadable")
    return {
      kind: "catalog",
      models: listing.models.map((model) => ({
        id: model.provider + "/" + model.id,
        name: model.provider + "/" + model.id,
      })),
    }
  },
}

/** Host supplies scoped snapshot reads; the snapshot algorithm stays in this package. */
export function createPiRuntimePolicy(
  prepareTaskConfig: NonNullable<AgentRuntimePolicy["prepareTaskConfig"]>
): AgentRuntimePolicy {
  return { ...piRuntimePolicy, prepareTaskConfig }
}
