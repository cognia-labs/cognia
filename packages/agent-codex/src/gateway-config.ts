import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
  GatewayTaskPayload,
  GatewayModelMetadata,
  AgentModelSlotDescriptor,
} from "@cognia/agent-contracts/gateway-task"
import { GATEWAY_TOKEN_ENV } from "@cognia/agent-runtime-kit/gateway-task"
import { parse as parseToml } from "smol-toml"

const CODEX_CUSTOM_CONFIG_KEYS = new Set([
  "developer_instructions",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "approval_policy",
  "sandbox_mode",
])
function codexCustomization(config: ExternalAgentConfig): Record<string, string> {
  const raw = config.process?.env?.CODEX_CONFIG
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Invalid Cognia model customization CODEX_CONFIG")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Cognia model customization CODEX_CONFIG")
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (CODEX_CUSTOM_CONFIG_KEYS.has(key) && typeof value === "string") result[key] = value
    else if (
      [
        "model",
        "review_model",
        "model_provider",
        "model_providers",
        "model_context_window",
        "model_auto_compact_token_limit",
      ].includes(key)
    )
      continue
    else throw new Error("Unsupported Cognia model customization CODEX_CONFIG field")
  }
  return result
}
function codexAutoCompactTokenLimit(
  meta: Pick<GatewayModelMetadata, "contextLength" | "maxInputTokens" | "maxOutputTokens">
): number | undefined {
  if (!meta.contextLength) return undefined
  return Math.max(
    1,
    Math.min(
      meta.maxInputTokens ?? meta.contextLength,
      meta.contextLength -
        (meta.maxOutputTokens ?? Math.min(16384, Math.floor(meta.contextLength / 4)))
    )
  )
}
const CODEX_EVIDENCE =
  "codex >= 0.145 ([agents] keys); task-owned model_catalog_json (rust-v0.163.0)"
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const
const CODEX_SLOTS: readonly AgentModelSlotDescriptor[] = [
  {
    id: "subagent.default",
    kind: "child-default",
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    supportsSpawnModelOverrides: true,
    evidence: CODEX_EVIDENCE,
  },
]
function validateAssignment(value: string | undefined) {
  const key = value?.split("=", 1)[0]?.trim()
  if (!key || !CODEX_CUSTOM_CONFIG_KEYS.has(key) || !value?.includes("="))
    throw new Error(
      "Cognia model customization cannot override provider, credentials or runtime configuration"
    )
  let valid = false
  try {
    const parsed = parseToml(value)
    valid = Object.keys(parsed).length === 1 && typeof parsed[key] === "string"
  } catch {}
  if (!valid) throw new Error("Invalid Cognia model customization configuration value")
}

export const codexGatewayProfile: GatewayRuntimeProfile = {
  runtime: "codex",
  traits: { ingress: "openai-responses", continuity: "native-resume" },
  slots: () => CODEX_SLOTS,

  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["codex-app-server", "codex-acp"].includes(entry.runtimeId)
    )
      return false
    return (
      Boolean(config.process.command) &&
      entry.protocol === config.protocol &&
      config.transport === "stdio"
    )
  },
  arguments: (_config, entry) => ({
    ...{ values: [], switches: [] },
    ...(entry?.runtimeId === "codex-app-server"
      ? { assignment: { flags: ["-c", "--config"], validate: validateAssignment } }
      : {}),
  }),
  environment: { preserved: ["CODEX_PATH", "NO_BROWSER", "INITIAL_AGENT_MODE", "APP_SERVER_LOGS"] },
  project(ctx: GatewayLaunchContext) {
    const { config, model, endpoint, meta, modelPlan } = ctx
    const subagent = modelPlan?.slots["subagent.default"]
    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    const selectedModel: string | undefined = model
    let codexModelCatalog: GatewayTaskPayload["codexModelCatalog"]
    let prependArgs: string[] | undefined
    if (modelPlan) {
      const ids = [...new Set([model, ...modelPlan!.models])]
      const localFacts = { modelEffortValues: ctx.reasoningEffortsFor }
      codexModelCatalog = {
        models: ids.map((id) => {
          const facts =
            ctx.modelMetadataById?.[id] ?? (id === model ? meta : ctx.modelMetadataFor(id))
          const autoCompactTokenLimit = codexAutoCompactTokenLimit(facts)
          return {
            slug: id,
            ...(facts.contextLength !== undefined ? { contextWindow: facts.contextLength } : {}),
            ...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
            inputModalities: facts.supportsVision ? ["text", "image"] : ["text"],
            ...(facts.supportsReasoning === true
              ? {
                  reasoningEfforts: [...localFacts.modelEffortValues(id)],
                }
              : {}),
          }
        }),
      }
      if (
        ids.length > 32 ||
        codexModelCatalog.models.some(
          (entry) =>
            [...entry.slug].length < 1 ||
            [...entry.slug].length > 256 ||
            /[\u0000-\u001f\u007f-\u009f]/.test(entry.slug) ||
            entry.reasoningEfforts?.some((effort) => !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))
        )
      )
        throw new Error("Invalid gateway task configuration")
    }

    const custom = codexCustomization(config)
    if (
      config.codexOptions?.stepModelSwitching !== undefined &&
      typeof config.codexOptions.stepModelSwitching !== "boolean"
    )
      throw new Error("Invalid Codex stepModelSwitching option")
    if (modelPlan?.allowedSpawnModels?.length) {
      const instructions = `When spawning native subagents, choose a model from this task's authorized model set: ${JSON.stringify(modelPlan.models)}. The default child model is ${JSON.stringify(subagent?.modelId ?? model)}. Use the native spawn tool's model and reasoning_effort fields when available. Existing V2 children cannot be directly switched.`
      custom.developer_instructions = [custom.developer_instructions, instructions]
        .filter(Boolean)
        .join("\n\n")
    }
    const agents = subagent
      ? {
          default_subagent_model: subagent.modelId,
          ...(subagent.reasoningEffort !== undefined
            ? { default_subagent_reasoning_effort: subagent.reasoningEffort }
            : {}),
        }
      : undefined
    files["codex/config.toml"] =
      [
        ...Object.entries(custom).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        `model = ${JSON.stringify(model)}`,
        'model_provider = "cognia"',
        `review_model = ${JSON.stringify(model)}`,
        ...(codexModelCatalog ? ['model_catalog_json = "model-catalog.json"'] : []),
        ...(!codexModelCatalog && meta.contextLength
          ? [`model_context_window = ${meta.contextLength}`]
          : []),
        ...(!codexModelCatalog && meta.contextLength
          ? [`model_auto_compact_token_limit = ${codexAutoCompactTokenLimit(meta)}`]
          : []),
        ...(config.codexOptions?.stepModelSwitching !== undefined
          ? [`[features]`, `step_model_switching = ${config.codexOptions.stepModelSwitching}`]
          : []),
        "[model_providers.cognia]",
        'name = "Cognia"',
        `base_url = ${JSON.stringify(endpoint)}`,
        `env_key = ${JSON.stringify(GATEWAY_TOKEN_ENV)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        ...(agents
          ? [
              "[agents]",
              ...Object.entries(agents).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
            ]
          : []),
      ].join("\n") + "\n"
    if (ctx.entry?.runtimeId === "codex-acp") {
      // The maintained ACP adapter forwards these overrides on both thread/start
      // and thread/resume, above project config, without serializing credentials.
      env.MODEL_PROVIDER = "cognia"
      env.CODEX_CONFIG = JSON.stringify({
        ...custom,
        model,
        review_model: model,
        model_provider: "cognia",
        ...(config.codexOptions?.stepModelSwitching !== undefined
          ? { features: { step_model_switching: config.codexOptions.stepModelSwitching } }
          : {}),
        ...(agents ? { agents } : {}),
        ...(!codexModelCatalog && meta.contextLength
          ? {
              model_context_window: meta.contextLength,
              model_auto_compact_token_limit: codexAutoCompactTokenLimit(meta),
            }
          : {}),
        model_providers: {
          cognia: {
            name: "Cognia",
            base_url: endpoint,
            env_key: GATEWAY_TOKEN_ENV,
            wire_api: "responses",
            requires_openai_auth: false,
          },
        },
      })
    }
    if (ctx.entry?.runtimeId === "codex-app-server") {
      let section = ""
      const overrides: string[] = []
      for (const line of files["codex/config.toml"].split("\n").filter(Boolean)) {
        if (line.startsWith("[")) section = line.slice(1, -1)
        else if (section || !line.startsWith("model_catalog_json ="))
          overrides.push("-c", (section ? section + "." : "") + line)
      }
      prependArgs = overrides
    }
    const metadata = modelPlan
      ? {
          cogniaModelPlanFingerprint: modelPlan.fingerprint,
          cogniaAllowedTaskModels: modelPlan.models,
        }
      : undefined
    return {
      model: selectedModel,
      env,
      files,
      args: launchArgs,
      ...(codexModelCatalog ? { codexModelCatalog } : {}),
      ...(prependArgs ? { prependArgs } : {}),
      ...(metadata ? { metadata } : {}),
    }
  },
}
