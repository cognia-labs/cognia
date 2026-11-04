import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
  ExternalAgentCogniaModelBinding,
  TaskModelPlan,
  AgentModelSlotDescriptor,
} from "@cognia/agent-contracts/gateway-task"
import { GATEWAY_TOKEN_ENV, admittedNativeModel } from "@cognia/agent-runtime-kit/gateway-task"
import { z } from "zod"

const openCodeAction = z.enum(["allow", "deny", "ask"])
const openCodePermission = z.union([
  openCodeAction,
  z.record(z.string(), z.union([openCodeAction, z.record(z.string(), openCodeAction)])),
])
const openCodePermissions = z
  .array(
    z
      .object({
        action: z.string(),
        resource: z.string(),
        effect: openCodeAction,
      })
      .strict()
  )
  .max(256)
const openCodeAgentFields = {
  model: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  hidden: z.boolean().optional(),
  color: z
    .string()
    .regex(/^(#[0-9a-fA-F]{6}|primary|secondary|accent|success|warning|error|info)$/)
    .optional(),
  steps: z.number().int().positive().optional(),
}
const openCodeCommand = z
  .object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  .strict()
const openCodeCommon = {
  default_agent: z.string().min(1).optional(),
  instructions: z.array(z.string().min(1)).max(128).optional(),
}
const openCodeV1Customization = z
  .object({
    ...openCodeCommon,
    agent: z
      .record(
        z.string(),
        z
          .object({
            ...openCodeAgentFields,
            prompt: z.string().optional(),
            temperature: z.number().finite().optional(),
            top_p: z.number().finite().optional(),
            disable: z.boolean().optional(),
            tools: z.record(z.string(), z.boolean()).optional(),
            permission: openCodePermission.optional(),
          })
          .strict()
      )
      .optional(),
    command: z.record(z.string(), openCodeCommand).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    permission: openCodePermission.optional(),
    skills: z
      .object({ paths: z.array(z.string()).optional(), urls: z.array(z.string()).optional() })
      .strict()
      .optional(),
    snapshot: z.boolean().optional(),
  })
  .strict()
const openCodeV2Customization = z
  .object({
    ...openCodeCommon,
    agents: z
      .record(
        z.string(),
        z
          .object({
            ...openCodeAgentFields,
            model: z
              .union([
                z.string().min(1),
                z
                  .object({
                    providerID: z.string().min(1),
                    model: z.string().min(1),
                    variant: z.string().min(1).optional(),
                  })
                  .strict(),
              ])
              .optional(),
            system: z.string().optional(),
            disabled: z.boolean().optional(),
            permissions: openCodePermissions.optional(),
          })
          .strict()
      )
      .optional(),
    commands: z.record(z.string(), openCodeCommand).optional(),
    permissions: openCodePermissions.optional(),
    skills: z.array(z.string()).max(128).optional(),
    snapshots: z.boolean().optional(),
  })
  .strict()

/** Parse once with the same schema at admission and launch. */
function readOpenCodeCustomization(
  config: Pick<ExternalAgentConfig, "process" | "protocol">
): Record<string, unknown> {
  const source = config.process?.env
  if (source?.OPENCODE_CONFIG || source?.OPENCODE_CONFIG_DIR)
    throw new Error(
      "Cognia model customization requires inline OpenCode settings instead of an external configuration path"
    )
  const raw = source?.OPENCODE_CONFIG_CONTENT
  const invalid = () => new Error("Invalid or unsupported Cognia model OpenCode customization")
  let input: Record<string, unknown>
  try {
    if (raw && raw.length > 65_536) throw invalid()
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid()
    input = { ...parsed }
  } catch {
    throw invalid()
  }
  for (const key of [
    "$schema",
    "model",
    "small_model",
    "provider",
    "providers",
    "enabled_providers",
    "disabled_providers",
  ])
    delete input[key]
  const v2 = config.protocol === "opencode-v2"
  const result = (v2 ? openCodeV2Customization : openCodeV1Customization).safeParse(input)
  if (!result.success) throw invalid()
  return { ...result.data }
}

/** Implicit built-in primary agents must not receive a child default. */
function isOpenCodeSubagent(name: string, entry: Record<string, unknown>): boolean {
  if (entry.mode !== undefined) return entry.mode !== "primary"
  return !["build", "plan", "compaction", "title", "summary"].includes(name)
}

function isOpenCodeChildCommand(
  entry: Record<string, unknown>,
  agents: Record<string, Record<string, unknown>>
): boolean {
  const name = entry.agent
  return (
    typeof name === "string" &&
    (Object.hasOwn(agents, name) || name === "general" || name === "explore") &&
    isOpenCodeSubagent(name, agents[name] ?? {})
  )
}

function openCodeModelBinding(
  value: unknown,
  providerId: string,
  v2: boolean
): ExternalAgentCogniaModelBinding & { variant?: string } {
  let provider: string
  let modelId: string
  let variant: string | undefined
  if (typeof value === "string") {
    const slash = value.indexOf("/")
    provider = value.slice(0, slash)
    modelId = value.slice(slash + 1)
    if (slash <= 0) throw new Error("Invalid Cognia model OpenCode subagent model reference")
    if (v2 && modelId.includes("#")) {
      const hash = modelId.indexOf("#")
      variant = modelId.slice(hash + 1)
      modelId = modelId.slice(0, hash)
    }
  } else {
    const selection = value as { providerID: string; model: string; variant?: string }
    provider = selection.providerID
    modelId = selection.model
    variant = selection.variant
  }
  if (
    [provider, modelId, ...(variant !== undefined ? [variant] : [])].some(
      (part) => !part.trim() || part !== part.trim()
    )
  )
    throw new Error("Invalid Cognia model OpenCode subagent model reference")
  return {
    providerId: provider === "cognia" ? providerId : provider,
    modelId,
    ...(variant !== undefined ? { variant } : {}),
  }
}

/** Models declared by individual children must enter the lease, not only the launch JSON. */
export function openCodeSubagentModelBindings(
  config: Pick<ExternalAgentConfig, "protocol" | "transport" | "process" | "metadata" | "network">,
  providerId: string
): Record<string, ExternalAgentCogniaModelBinding & { variant?: string }> {
  const custom = readOpenCodeCustomization(config)
  const v2 = config.protocol === "opencode-v2"
  const agents = custom[v2 ? "agents" : "agent"] as
    Record<string, Record<string, unknown>> | undefined
  const commands = custom[v2 ? "commands" : "command"] as
    Record<string, Record<string, unknown>> | undefined
  return Object.fromEntries([
    ...Object.entries(agents ?? {})
      .filter(([name, entry]) => isOpenCodeSubagent(name, entry) && entry.model !== undefined)
      .map(([name, entry]) => [
        `opencode.agent.${name}`,
        openCodeModelBinding(entry.model, providerId, v2),
      ]),
    ...Object.entries(commands ?? {})
      .filter(
        ([, entry]) => isOpenCodeChildCommand(entry, agents ?? {}) && entry.model !== undefined
      )
      .map(([name, entry]) => [
        `opencode.command.${name}`,
        openCodeModelBinding(entry.model, providerId, v2),
      ]),
  ])
}

function openCodeCustomization(
  config: ExternalAgentConfig,
  selectedModel: string,
  subagentModel: string | undefined,
  providerId: string,
  allowedModels: readonly string[],
  plan?: TaskModelPlan
): Record<string, unknown> {
  const output = readOpenCodeCustomization(config)
  const v2 = config.protocol === "opencode-v2"
  const agentKey = v2 ? "agents" : "agent"
  const agentDefinitions = (output[agentKey] ?? {}) as Record<string, Record<string, unknown>>
  for (const key of [agentKey, v2 ? "commands" : "command"]) {
    const entries = output[key] as Record<string, Record<string, unknown>> | undefined
    if (entries)
      output[key] = Object.fromEntries(
        Object.entries(entries).map(([name, entry]) => {
          const childCommand = key !== agentKey && isOpenCodeChildCommand(entry, agentDefinitions)
          // An omitted command model must let the named agent's own model win.
          if (childCommand && entry.model === undefined) return [name, entry]
          let model: unknown = selectedModel
          if ((key === agentKey && isOpenCodeSubagent(name, entry)) || childCommand) {
            model = subagentModel ?? selectedModel
            if (entry.model !== undefined) {
              const binding = openCodeModelBinding(entry.model, providerId, v2)
              const selector = admittedNativeModel(
                plan,
                `opencode.${key === agentKey ? "agent" : "command"}.${name}`,
                binding,
                providerId,
                allowedModels
              )
              model =
                typeof entry.model === "string"
                  ? `cognia/${selector}${binding.variant !== undefined ? `#${binding.variant}` : ""}`
                  : {
                      providerID: "cognia",
                      model: selector,
                      ...(binding.variant !== undefined ? { variant: binding.variant } : {}),
                    }
            }
          }
          return [
            name,
            {
              ...entry,
              model,
            },
          ]
        })
      )
  }
  if (subagentModel !== undefined) {
    const agents = (output[agentKey] ?? {}) as Record<string, Record<string, unknown>>
    for (const name of ["general", "explore"]) {
      if (!Object.hasOwn(agents, name)) agents[name] = { model: subagentModel }
    }
    output[agentKey] = agents
  }
  return output
}
const OPENCODE_EVIDENCE = "opencode v1.19.3 (tool/task.ts, v1 + v2 config schema)"
const OPENCODE_V1_SLOTS: readonly AgentModelSlotDescriptor[] = [
  { id: "subagent.default", kind: "child-default", evidence: OPENCODE_EVIDENCE },
  { id: "aux.small", kind: "auxiliary", evidence: OPENCODE_EVIDENCE },
]
const OPENCODE_V2_SLOTS: readonly AgentModelSlotDescriptor[] = [
  { id: "subagent.default", kind: "child-default", evidence: OPENCODE_EVIDENCE },
]
export const opencodeGatewayProfile: GatewayRuntimeProfile = {
  runtime: "opencode",
  traits: { ingress: "openai-chat", continuity: "native-resume" },
  fallbackCommand: "opencode",
  attachedServer: (config) => ["opencode", "opencode-v2"].includes(config.protocol),
  slots: (config) => (config.protocol === "opencode-v2" ? OPENCODE_V2_SLOTS : OPENCODE_V1_SLOTS),
  nativeModels: (config, primary) => openCodeSubagentModelBindings(config, primary.providerId),

  accepts(config, entry) {
    if (config.protocol === "opencode-v2")
      return !config.network?.endpoint || Boolean(config.process?.command)
    if (
      !config.process ||
      config.network?.endpoint ||
      !config.process.command ||
      !entry ||
      entry.protocol !== config.protocol
    )
      return false
    return (
      (entry.runtimeId === "opencode" && config.transport === "sse") ||
      (entry.runtimeId === "opencode-acp" && config.transport === "stdio")
    )
  },
  arguments: (_config, _entry) => ({ values: ["--log-level"], switches: ["--print-logs"] }),
  environment: {},
  project(ctx: GatewayLaunchContext) {
    const { config, binding, model, endpoint, meta, modelPlan } = ctx
    const subagent = modelPlan?.slots["subagent.default"]
    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    let selectedModel: string | undefined = model

    selectedModel = `cognia/${model}`
    const custom = openCodeCustomization(
      config,
      selectedModel,
      subagent ? `cognia/${subagent.modelId}` : undefined,
      binding.providerId,
      modelPlan?.models ?? [model],
      modelPlan
    )
    const modelEntry = (id: string, v2: boolean) => {
      const facts = id === model ? meta : (ctx.modelMetadataById?.[id] ?? ctx.modelMetadataFor(id))
      if (facts.supportsTools === false || facts.supportsStreaming === false)
        throw new Error(
          `The selected model ${id} does not support the tools and streaming this agent requires`
        )
      const limit = {
        ...(facts.contextLength ? { context: facts.contextLength } : {}),
        ...(facts.maxInputTokens ? { input: facts.maxInputTokens } : {}),
        ...(facts.maxOutputTokens ? { output: facts.maxOutputTokens } : {}),
      }
      const modalities = {
        input: facts.supportsVision ? ["text", "image"] : ["text"],
        output: ["text"],
      }
      return v2
        ? {
            name: id,
            ...(Object.keys(limit).length ? { limit } : {}),
            capabilities: { tools: true, ...modalities },
          }
        : {
            name: id,
            ...(facts.contextLength && facts.maxOutputTokens ? { limit } : {}),
            tool_call: true,
            reasoning: facts.supportsReasoning === true,
            modalities,
          }
    }
    const modelsFor = (v2: boolean) =>
      Object.fromEntries((modelPlan?.models ?? [model]).map((id) => [id, modelEntry(id, v2)]))
    // The bundled ACP executable is OpenCode V1; V2 provider declarations are
    // explicitly unsupported by its compatibility reader (v1.18.32).
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(
      config.protocol !== "opencode-v2"
        ? {
            ...custom,
            model: selectedModel,
            small_model: modelPlan?.slots["aux.small"]
              ? `cognia/${modelPlan.slots["aux.small"].modelId}`
              : selectedModel,
            enabled_providers: ["cognia"],
            provider: {
              cognia: {
                name: "Cognia",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: endpoint, apiKey: `{env:${GATEWAY_TOKEN_ENV}}` },
                models: modelsFor(false),
              },
            },
          }
        : {
            ...custom,
            model: selectedModel,
            providers: {
              cognia: {
                name: "Cognia",
                package: "@opencode/ai/providers/openai-compatible",
                env: [GATEWAY_TOKEN_ENV],
                settings: { baseURL: endpoint },
                models: modelsFor(true),
              },
            },
          }
    )
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
