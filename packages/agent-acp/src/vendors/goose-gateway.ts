import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"

export const gooseGatewayProfile: GatewayRuntimeProfile = {
  runtime: "goose",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["goose"].includes(entry.runtimeId)
    )
      return false
    return (
      Boolean(config.process.command) &&
      entry.protocol === config.protocol &&
      config.transport === "stdio"
    )
  },
  arguments: (_config, _entry) => ({ values: ["--with-builtin"], switches: [] }),
  environment: {
    preserved: [
      "GOOSE_MODE",
      "GOOSE_TEMPERATURE",
      "GOOSE_SHELL",
      "GOOSE_STREAM_TIMEOUT",
      "GOOSE_SUBAGENT_MAX_TURNS",
      "GOOSE_CLI_MIN_PRIORITY",
    ],
    routeOwned: [
      "GOOSE_PROVIDER",
      "GOOSE_MODEL",
      "GOOSE_CONTEXT_LIMIT",
      "GOOSE_INPUT_LIMIT",
      "GOOSE_DISABLE_KEYRING",
      "GOOSE_TELEMETRY_OFF",
      "GOOSE_TELEMETRY_ENABLED",
      "GOOSE_TOOLSHIM",
      "GOOSE_TOOLSHIM_OLLAMA_MODEL",
      "GOOSE_CLIENT_CERT_PATH",
      "GOOSE_CLIENT_KEY_PATH",
    ],
    routeOwnedPrefixes: [
      "GOOSE_LEAD_",
      "GOOSE_PLANNER_",
      "GOOSE_SUBAGENT_PROVIDER",
      "GOOSE_SUBAGENT_MODEL",
      "OPENAI_",
    ],
  },
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, secret, meta } = ctx

    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    const selectedModel: string | undefined = model

    // Goose reads provider settings from the environment before its config
    // file. The keyring stays closed so another provider's stored secret is
    // never reachable from the task; the session model option reports the
    // plain model id.
    const url = new URL(endpoint)
    env.GOOSE_PROVIDER = "openai"
    env.GOOSE_MODEL = model
    env.OPENAI_HOST = url.origin
    env.OPENAI_BASE_PATH = [url.pathname.replace(/^\/+|\/+$/g, ""), "chat/completions"]
      .filter(Boolean)
      .join("/")
    env.OPENAI_API_KEY = secret
    env.GOOSE_DISABLE_KEYRING = "1"
    env.GOOSE_TELEMETRY_OFF = "1"
    if (meta.contextLength)
      env.GOOSE_CONTEXT_LIMIT = String(
        Math.min(meta.contextLength, meta.maxInputTokens ?? meta.contextLength)
      )

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
