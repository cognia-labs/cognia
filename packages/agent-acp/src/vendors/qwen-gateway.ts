import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"
import { GATEWAY_TOKEN_ENV } from "@cognia/agent-runtime-kit/gateway-task"

export const qwenGatewayProfile: GatewayRuntimeProfile = {
  runtime: "qwen",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["qwen-code"].includes(entry.runtimeId)
    )
      return false
    return (
      Boolean(config.process.command) &&
      entry.protocol === config.protocol &&
      config.transport === "stdio"
    )
  },
  arguments: (_config, _entry) => ({
    values: [
      "--include-directories",
      "--allowed-tools",
      "--allowed-mcp-server-names",
      "--mcp-config",
      "--extensions",
    ],
    switches: [],
  }),
  environment: {},
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, secret, meta } = ctx

    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    selectedModel = `${model}(openai)`
    // Qwen's startup auth preflight checks the standard env key even when the
    // provider model itself references a custom envKey.
    env.OPENAI_API_KEY = secret
    env.OPENAI_BASE_URL = endpoint
    env.OPENAI_MODEL = model
    files["qwen/settings.json"] = JSON.stringify({
      $version: 4,
      security: { auth: { selectedType: "openai" } },
      general: { enableAutoUpdate: false, disableAutoUpdate: true },
      telemetry: { enabled: false },
      privacy: { usageStatisticsEnabled: false },
      model: { name: model },
      fastModel: model,
      advisorModel: model,
      compactionModel: model,
      modelProviders: {
        openai: [
          {
            id: model,
            name: model,
            envKey: GATEWAY_TOKEN_ENV,
            baseUrl: endpoint,
            generationConfig: {
              ...(meta.contextLength
                ? {
                    contextWindowSize: Math.min(
                      meta.contextLength,
                      meta.maxInputTokens ?? meta.contextLength
                    ),
                  }
                : {}),
              ...(meta.maxOutputTokens
                ? { samplingParams: { max_tokens: meta.maxOutputTokens } }
                : {}),
              modalities: { image: meta.supportsVision === true },
            },
          },
        ],
      },
    })

    launchArgs.push("--auth-type", "openai", "--model", model, "--openai-base-url", endpoint)
    return { model: selectedModel, env, files, args: launchArgs }
  },
}
