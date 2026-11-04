/** Host model facts and authority supplied to package-owned launch recipes. */
import { resolveModelMeta } from "@/lib/ai/model-options"
import { reasoningTiersFor } from "@cognia/provider-core/providers/reasoning-tiers"
import { isHeadlessHost } from "@/lib/platform/detect"
import { parseFrontmatter } from "@/lib/claude/subagent-importers/_parse-helpers"
import type { AppSettings } from "@cognia/agent-config-types"
import {
  createGatewayTaskTools,
  type GatewayTaskBuildInput,
} from "@cognia/agent-runtime-kit/gateway-task"
import {
  opencodeGatewayProfile,
  openCodeSubagentModelBindings as openCodeBindings,
} from "@cognia/agent-opencode/gateway-config"
import type { GatewayRuntimeConfig } from "@cognia/agent-contracts/gateway-task"
import { gatewayRuntimeProfiles } from "../integrations/gateway"
import { cogniaModelReasoningFacts } from "./cognia-model-options"
import { findRuntimeForConfig } from "./install-catalog"
export * from "@cognia/agent-runtime-kit/gateway-task"
export { CLAUDE_GATEWAY_TASK_SETTINGS } from "@cognia/agent-claude-code/gateway-config"
export { COPILOT_NO_GITHUB_AUTH } from "@cognia/agent-acp/vendors/copilot-gateway"
const tools = createGatewayTaskTools({ profiles: gatewayRuntimeProfiles, findRuntimeForConfig })
export const {
  GATEWAY_RUNTIME_TRAITS,
  cogniaGatewayRuntime,
  cogniaGatewaySupport,
  gatewayRuntimeTraits,
  canUseCogniaModels,
  nativeSubagentModelBindings,
} = tools
export function gatewayModelSlots(config: GatewayRuntimeConfig) {
  return tools.gatewayModelSlots(config)
}
export function openCodeSubagentModelBindings(config: GatewayRuntimeConfig, providerId: string) {
  return opencodeGatewayProfile.accepts(config, findRuntimeForConfig(config))
    ? openCodeBindings(config, providerId)
    : {}
}
export function buildGatewayTaskConfig(
  input: Omit<
    GatewayTaskBuildInput,
    "modelMetadataFor" | "reasoningEffortsFor" | "parseFrontmatter"
  > & { settings: Pick<AppSettings, "providerSettings" | "customProviders"> }
) {
  const { settings, binding } = input
  const metadataFor = (id: string, route?: { providerId?: string; modelId?: string }) => ({
    id,
    ...resolveModelMeta(
      route?.providerId ?? binding.providerId,
      route?.modelId ?? id,
      settings.providerSettings,
      settings.customProviders
    ),
  })
  let facts: ReturnType<typeof cogniaModelReasoningFacts> | undefined
  let resolved = false
  return tools.buildGatewayTaskConfig({
    ...input,
    modelMetadataFor: metadataFor,
    reasoningEffortsFor: (id) => {
      if (!resolved) {
        facts = isHeadlessHost()
          ? undefined
          : cogniaModelReasoningFacts(binding.providerId, settings)
        resolved = true
      }
      return facts
        ? facts.modelEffortValues(id)
        : reasoningTiersFor({ providerId: binding.providerId, modelId: id, reasoning: true })
    },
    parseFrontmatter,
  })
}
