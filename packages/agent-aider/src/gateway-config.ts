import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"

export const aiderGatewayProfile: GatewayRuntimeProfile = {
  runtime: "aider",
  traits: { ingress: "openai-chat", continuity: "transcript" },
  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["aider"].includes(entry.runtimeId)
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
      "--edit-format",
      "--editor-edit-format",
      "--reasoning-effort",
      "--thinking-tokens",
      "--max-chat-history-tokens",
      "--timeout",
    ],
    switches: [],
  }),
  environment: {
    preserved: [
      "AIDER_EDIT_FORMAT",
      "AIDER_EDITOR_EDIT_FORMAT",
      "AIDER_REASONING_EFFORT",
      "AIDER_THINKING_TOKENS",
    ],
    routeOwned: ["AIDER_MODEL", "AIDER_WEAK_MODEL", "AIDER_EDITOR_MODEL", "OPENAI_API_BASE"],
  },
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, secret } = ctx

    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    // LiteLLM's OpenAI-compatible route: `openai/<model>` against the given
    // API base, key from OPENAI_API_KEY. Weak and editor models default to
    // provider-specific models, so they are pinned to the task model too.
    selectedModel = `openai/${model}`
    env.OPENAI_API_KEY = secret
    launchArgs.push(
      "--model",
      selectedModel,
      "--weak-model",
      selectedModel,
      "--editor-model",
      selectedModel,
      "--openai-api-base",
      endpoint
    )

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
