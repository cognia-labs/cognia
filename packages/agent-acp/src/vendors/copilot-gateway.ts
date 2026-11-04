import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"

export const COPILOT_NO_GITHUB_AUTH = "cognia-gateway-task-no-github-auth"

export const copilotGatewayProfile: GatewayRuntimeProfile = {
  runtime: "copilot",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["copilot-cli"].includes(entry.runtimeId)
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
    preserved: [
      "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
      "PLAIN_DIFF",
      "USE_BUILTIN_RIPGREP",
      "USE_TGREP",
    ],
    routeOwned: [
      "COPILOT_MODEL",
      "COPILOT_OFFLINE",
      "COPILOT_AUTO_UPDATE",
      "COPILOT_AUTO_TIER",
      "COPILOT_HOME",
      "COPILOT_CACHE_HOME",
      "COPILOT_PKG_CACHE_HOME",
      "COPILOT_CLI_VERSION",
      "COPILOT_CLI_DIST_DIR",
      "COPILOT_GITHUB_TOKEN",
      "COPILOT_GH_HOST",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_HOST",
    ],
    routeOwnedPrefixes: ["COPILOT_PROVIDER_"],
  },
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, secret, meta } = ctx

    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    // Copilot CLI BYOK. It exposes no session model option on this route and a
    // resumed session keeps its recorded model unless `--model` is passed, so
    // the launch carries the model. The GitHub tokens are deliberate
    // placeholders: they outrank any stored Copilot login, so a build without
    // BYOK fails authentication instead of silently using GitHub's route.
    selectedModel = undefined
    env.COPILOT_PROVIDER_BASE_URL = endpoint
    env.COPILOT_PROVIDER_TYPE = "openai"
    env.COPILOT_PROVIDER_WIRE_API = "completions"
    env.COPILOT_PROVIDER_API_KEY = secret
    env.COPILOT_MODEL = model
    if (meta.maxInputTokens || meta.contextLength)
      env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(meta.maxInputTokens ?? meta.contextLength)
    if (meta.maxOutputTokens) env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = String(meta.maxOutputTokens)
    env.COPILOT_OFFLINE = "true"
    env.COPILOT_AUTO_UPDATE = "false"
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"])
      env[key] = COPILOT_NO_GITHUB_AUTH
    launchArgs.push("--model", model)

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
