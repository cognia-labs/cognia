import type {
  GatewayLaunchContext,
  GatewayRuntimeProfile,
} from "@cognia/agent-contracts/gateway-task"
import { GATEWAY_TOKEN_ENV } from "@cognia/agent-runtime-kit/gateway-task"

export const ohMyPiGatewayProfile: GatewayRuntimeProfile = {
  runtime: "oh-my-pi",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["oh-my-pi"].includes(entry.runtimeId)
    )
      return false
    return (
      Boolean(config.process.command) &&
      entry.protocol === config.protocol &&
      config.transport === "stdio"
    )
  },
  arguments: (_config, _entry) => ({ values: [], switches: [] }),
  environment: {
    routeOwned: [
      "PI_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_PROFILE",
      "OMP_PROFILE",
    ],
    routeOwnedPrefixes: ["OMP_"],
  },
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, meta, modelPlan } = ctx
    const ids = [...new Set([model, ...(modelPlan?.models ?? [])])]
    const selectedModel = `cognia/${model}`

    // OMP 18.22.2 reads YAML 1.2 (which accepts JSON) from `<PI_CODING_AGENT_DIR>/models.yml`
    // and `<PI_CODING_AGENT_DIR>/config.yml`. Its `resolveConfigValue` checks
    // `process.env[apiKey]` directly (without stripping a leading `$`), so the
    // provider file names `COGNIA_GATEWAY_TOKEN` bare and never stores the lease.
    const provider = {
      baseUrl: endpoint,
      api: "openai-completions",
      apiKey: GATEWAY_TOKEN_ENV,
      models: ids.map((id) => {
        const facts =
          ctx.modelMetadataById?.[id] ?? (id === model ? meta : ctx.modelMetadataFor(id))
        return {
          id,
          name: id,
          ...(facts.contextLength
            ? {
                contextWindow: Math.min(
                  facts.contextLength,
                  facts.maxInputTokens ?? facts.contextLength
                ),
              }
            : {}),
          ...(facts.maxOutputTokens ? { maxTokens: facts.maxOutputTokens } : {}),
          ...(facts.supportsReasoning !== undefined ? { reasoning: facts.supportsReasoning } : {}),
          input: facts.supportsVision ? ["text", "image"] : ["text"],
        }
      }),
    }

    const files: Record<string, string> = {
      "omp/models.yml": JSON.stringify({
        providers: { cognia: provider },
      }),
      "omp/config.yml": JSON.stringify({
        models: {
          default: selectedModel,
          smol: selectedModel,
          slow: selectedModel,
        },
      }),
    }

    return { model: selectedModel, env: {}, files, args: [] }
  },
}
