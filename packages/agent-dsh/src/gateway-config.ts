import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
} from "@cognia/agent-contracts/gateway-task"

export const dshGatewayProfile: GatewayRuntimeProfile = {
  runtime: "dsh",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  passthroughLaunch: true,
  allowsUnresolvedCommand: (entry) => entry?.runtimeId === "deepseek-harness",
  supportKey: (config) => (config.protocol === "dsh-sdk" ? "dsh-sdk" : "dsh"),
  traitVariants: { "dsh-sdk": { ingress: "openai-chat", continuity: "transcript" } },

  accepts(config, entry) {
    return (
      Boolean(config.process) &&
      !config.network?.endpoint &&
      entry?.runtimeId === "deepseek-harness" &&
      config.transport === "stdio" &&
      ["dsh-sdk", "acp"].includes(config.protocol)
    )
  },
  arguments: (_config, _entry) => ({ values: [], switches: [] }),
  environment: { routeOwned: ["DSH_HOME"], routeOwnedPrefixes: ["COGNIA_DSH_"] },
  slots: () => [{ id: "aux.vision", kind: "auxiliary", evidence: "ModLens v3.27.2 managed CLI" }],
  project(ctx: GatewayLaunchContext) {
    const { config, model, endpoint, secret, meta, modelPlan } = ctx

    const vision = modelPlan?.slots["aux.vision"]?.modelId
    if (vision && !modelPlan?.models.includes(vision))
      throw new Error("ModLens vision model is not admitted by this Cognia task")
    const visionBinding = vision ? modelPlan?.bindings?.[vision] : undefined
    const visionMeta = vision
      ? (ctx.modelMetadataById?.[vision] ??
        (vision === model ? meta : ctx.modelMetadataFor(vision, visionBinding)))
      : undefined
    if (vision && visionMeta?.supportsVision !== true)
      throw new Error("ModLens requires a vision-capable Cognia model")
    if (vision && (visionMeta?.supportsTools === false || visionMeta?.supportsStreaming === false))
      throw new Error(
        "ModLens vision model must meet the existing Cognia gateway tools and streaming requirements"
      )

    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    // Current DSH ACP config_options encodes the complete provider/model pair.
    selectedModel = config.protocol === "acp" ? JSON.stringify(["cognia", model]) : model
    // Preserve the certified managed launch and tool-host bridge, but rebuild
    // the provider route from the frozen gateway lease. Runtime paths remain
    // under the managed home; DSH sessions are globally unique UUIDs.
    for (const key of [
      "DSH_HOME",
      "COGNIA_DSH_RUNTIME_HOME",
      "COGNIA_DSH_WORKSPACE",
      "COGNIA_DSH_SESSION_ROOT",
      "COGNIA_DSH_MCP_SERVERS",
      "COGNIA_DSH_PERSONA",
    ]) {
      const value = config.process?.env?.[key]
      if (value) env[key] = value
    }
    const reasoningEffort = config.process?.env?.COGNIA_DSH_REASONING_EFFORT
    if (meta.supportsReasoning === true && reasoningEffort)
      env.COGNIA_DSH_REASONING_EFFORT = reasoningEffort
    env.COGNIA_DSH_GATEWAY_TOKEN = secret
    env.COGNIA_DSH_PROVIDER = "cognia"
    env.COGNIA_DSH_MODEL = model
    if (meta.contextLength) env.COGNIA_DSH_CONTEXT_WINDOW = String(meta.contextLength)
    if (meta.maxOutputTokens) env.COGNIA_DSH_MAX_TOKENS = String(meta.maxOutputTokens)
    env.COGNIA_DSH_GATEWAY_CONFIG = JSON.stringify({
      ...(vision || meta.supportsVision ? { visionModel: vision ?? model } : {}),
      providers: {
        cognia: {
          api: "openai-completions",
          baseURL: endpoint,
          apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
          displayName: "Cognia",
          compat: {
            supportsStore: false,
            maxTokensField: "max_tokens",
            supportsReasoningEffort: meta.supportsReasoning === true,
          },
          models: [
            {
              id: model,
              name: model,
              ...(meta.contextLength
                ? {
                    contextWindow: Math.min(
                      meta.contextLength,
                      meta.maxInputTokens ?? meta.contextLength
                    ),
                  }
                : {}),
              ...(meta.maxOutputTokens ? { maxTokens: meta.maxOutputTokens } : {}),
              ...(meta.supportsReasoning === true
                ? {
                    reasoningEfforts: {
                      off: null,
                      minimal: "minimal",
                      low: "low",
                      medium: "medium",
                      high: "high",
                      xhigh: "xhigh",
                      max: "max",
                    },
                  }
                : {}),
              input: meta.supportsVision ? ["text", "image"] : ["text"],
            },
            ...(vision && vision !== model
              ? [
                  {
                    id: vision,
                    name: vision,
                    input: ["text", "image"],
                    ...(visionMeta?.contextLength
                      ? { contextWindow: visionMeta.contextLength }
                      : {}),
                    ...(visionMeta?.maxOutputTokens
                      ? { maxTokens: visionMeta.maxOutputTokens }
                      : {}),
                  },
                ]
              : []),
          ],
        },
      },
    })

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
