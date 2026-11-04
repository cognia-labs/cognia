import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"

export const kimiGatewayProfile: GatewayRuntimeProfile = {
  runtime: "kimi",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["kimi"].includes(entry.runtimeId)
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
    preserved: ["KIMI_CODE_NO_AUTO_UPDATE", "KIMI_CLI_NO_AUTO_UPDATE", "KIMI_DISABLE_TELEMETRY"],
    preservedPrefixes: ["KIMI_MCP_", "KIMI_LOOP_"],
    routeOwned: [
      "KIMI_API_KEY",
      "KIMI_BASE_URL",
      "KIMI_CODE_BASE_URL",
      "KIMI_CODE_CUSTOM_HEADERS",
      "KIMI_CODE_HOME",
      "KIMI_SHARE_DIR",
      "KIMI_OAUTH_HOST",
      "KIMI_CODE_OAUTH_HOST",
    ],
    routeOwnedPrefixes: ["KIMI_MODEL_", "KIMI_SECONDARY_"],
  },
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, secret, meta } = ctx

    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    // Kimi Code's env-model provider (2.1.1 `applyEnvModelConfig`): an
    // OpenAI-compatible provider type speaks Chat Completions, the alias it
    // registers is the fixed `__kimi_env_model__`, and the key stays in this
    // process environment (stripped again before any config write).
    selectedModel = "__kimi_env_model__"
    env.KIMI_MODEL_PROVIDER_TYPE = "openai"
    env.KIMI_MODEL_BASE_URL = endpoint
    env.KIMI_MODEL_API_KEY = secret
    env.KIMI_MODEL_NAME = model
    env.KIMI_MODEL_DISPLAY_NAME = model
    const context = meta.contextLength
      ? Math.min(meta.contextLength, meta.maxInputTokens ?? meta.contextLength)
      : undefined
    if (context) env.KIMI_MODEL_MAX_CONTEXT_SIZE = String(context)
    if (meta.maxOutputTokens) env.KIMI_MODEL_MAX_OUTPUT_SIZE = String(meta.maxOutputTokens)
    // Without an explicit list Kimi assumes image input and thinking.
    env.KIMI_MODEL_CAPABILITIES = [
      "tool_use",
      ...(meta.supportsReasoning === true ? ["thinking"] : []),
      ...(meta.supportsVision === true ? ["image_in"] : []),
      ...(meta.supportsVideo === true ? ["video_in"] : []),
      ...(meta.supportsAudio === true ? ["audio_in"] : []),
    ].join(",")
    env.KIMI_CODE_NO_AUTO_UPDATE = "1"
    env.KIMI_DISABLE_TELEMETRY = "1"

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
