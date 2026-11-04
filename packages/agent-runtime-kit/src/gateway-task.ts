/** Generic assembly of package-authored gateway launch recipes. */
import { normalizeCogniaModelBinding } from "@cognia/agent-contracts/external-agent"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type { ExternalAgentRuntimeCatalogEntry } from "@cognia/agent-contracts/external-agent-lifecycle"
import type {
  GatewayRuntimeConfig,
  GatewayRuntimeProfile,
  GatewayEnvironmentRules,
  GatewayLaunchContext,
  GatewayTaskPayload,
  ExternalAgentCogniaModelBinding,
  TaskModelPlan,
  GatewayModelMetadata,
} from "@cognia/agent-contracts/gateway-task"
export type * from "@cognia/agent-contracts/gateway-task"
export { normalizeCogniaModelBinding } from "@cognia/agent-contracts/external-agent"
export const GATEWAY_TASK_ENV = "COGNIA_GATEWAY_TASK_CONFIG"
export const GATEWAY_TOKEN_ENV = "COGNIA_GATEWAY_TOKEN"
const SESSION_PREFIX = "cognia-gateway:"
export interface GatewayTaskBuildInput {
  config: ExternalAgentConfig
  binding: ExternalAgentCogniaModelBinding
  taskId: string
  endpoint: string
  secret: string
  model: string
  ownerAccountId: string | null
  modelMetadata?: GatewayModelMetadata
  modelMetadataById?: Record<string, GatewayModelMetadata>
  modelPlan?: TaskModelPlan
  originDeviceId?: string | null
  rebind?: boolean
  modelMetadataFor(
    id: string,
    route?: Pick<ExternalAgentCogniaModelBinding, "providerId" | "modelId">
  ): GatewayModelMetadata
  reasoningEffortsFor(id: string): readonly string[]
  parseFrontmatter: GatewayLaunchContext["parseFrontmatter"]
}
export function createGatewayTaskTools(deps: {
  profiles: readonly GatewayRuntimeProfile[]
  findRuntimeForConfig(config: GatewayRuntimeConfig): ExternalAgentRuntimeCatalogEntry | undefined
}) {
  const profileFor = (config: GatewayRuntimeConfig) => {
    const entry = deps.findRuntimeForConfig(config)
    return deps.profiles.find((profile) => profile.accepts(config, entry))
  }
  const traits = Object.fromEntries(
    deps.profiles.flatMap((profile) => [
      [profile.runtime, profile.traits],
      ...Object.entries(profile.traitVariants ?? {}),
    ])
  ) as Record<string, GatewayRuntimeProfile["traits"]>
  const cogniaGatewayRuntime = (config: GatewayRuntimeConfig) => profileFor(config)?.runtime
  const cogniaGatewaySupport = (
    config: GatewayRuntimeConfig
  ):
    | { supported: true; runtime: string }
    | {
        supported: false
        reason: import("@cognia/agent-contracts/gateway-task").CogniaGatewayUnsupportedReason
      } => {
    const profile = profileFor(config)
    if (profile)
      return { supported: true, runtime: profile.supportKey?.(config) ?? profile.runtime }
    if (config.network?.endpoint)
      return {
        supported: false,
        reason: deps.profiles.some((profile) => profile.attachedServer?.(config))
          ? "remote-server"
          : "network-endpoint",
      }
    if (
      !config.process?.command &&
      !deps.profiles.some((profile) =>
        profile.allowsUnresolvedCommand?.(deps.findRuntimeForConfig(config))
      )
    )
      return { supported: false, reason: "no-process" }
    return { supported: false, reason: "unsupported-runtime" }
  }
  return {
    profileFor,
    GATEWAY_RUNTIME_TRAITS: traits,
    cogniaGatewayRuntime,
    cogniaGatewaySupport,
    gatewayRuntimeTraits(config: GatewayRuntimeConfig) {
      const support = cogniaGatewaySupport(config)
      return support.supported ? traits[support.runtime] : undefined
    },
    canUseCogniaModels: (config: GatewayRuntimeConfig) => Boolean(profileFor(config)),
    gatewayModelSlots: (config: GatewayRuntimeConfig) => profileFor(config)?.slots?.(config) ?? [],
    nativeSubagentModelBindings: (
      config: GatewayRuntimeConfig,
      primary: ExternalAgentCogniaModelBinding
    ) => profileFor(config)?.nativeModels?.(config, primary) ?? {},
    buildGatewayTaskConfig(input: GatewayTaskBuildInput): {
      config: ExternalAgentConfig
      model: string | undefined
    } {
      const { config, binding, taskId, secret } = input
      const modelPlan =
        input.modelPlan &&
        (Object.keys(input.modelPlan.slots).length ||
          input.modelPlan.allowedSpawnModels !== undefined)
          ? input.modelPlan
          : undefined
      if (input.modelPlan && input.model !== input.modelPlan.primaryModelId)
        throw new Error("Gateway model and model plan primary model differ")
      const model = modelPlan?.primaryModelId ?? input.model
      const profile = profileFor(config)
      if (!profile)
        throw new Error("This external agent does not support isolated Cognia gateway tasks")
      const meta =
        input.modelMetadataById?.[model] ?? input.modelMetadata ?? input.modelMetadataFor(model)
      if (meta.supportsTools === false || meta.supportsStreaming === false)
        throw new Error(
          "The selected model does not support the tools and streaming this agent requires"
        )
      const entry = deps.findRuntimeForConfig(config)
      const launch = customizedGatewayLaunch(config, profile, entry)
      const projection = profile.project({ ...input, model, meta, modelPlan, entry })
      const env: Record<string, string> = {
        ...customizationEnvironment(config, profile.environment),
        [GATEWAY_TOKEN_ENV]: secret,
      }
      for (const key of [
        "COGNIA_TOOLHOST_SOCKET",
        "COGNIA_TOOLHOST_TOKEN",
        "COGNIA_TOOLHOST_SERVER",
      ]) {
        const value = config.process?.env?.[key]
        if (value) env[key] = value
      }
      Object.assign(env, projection.env)
      env[GATEWAY_TASK_ENV] = JSON.stringify({
        taskId,
        ownerAccountId: input.ownerAccountId,
        binding,
        runtime: profile.runtime,
        ...(input.originDeviceId ? { originDeviceId: input.originDeviceId } : {}),
        ...(input.rebind ? { rebind: true as const } : {}),
        files: projection.files,
        ...(projection.codexModelCatalog
          ? { codexModelCatalog: projection.codexModelCatalog }
          : {}),
      } satisfies GatewayTaskPayload)
      return {
        model: projection.model,
        config: {
          ...config,
          id: "gateway-task-" + taskId,
          cogniaModel: null,
          network: undefined,
          process: {
            ...config.process!,
            command: launch.command,
            args: [...(projection.prependArgs ?? []), ...launch.args, ...projection.args],
            env,
          },
          metadata: {
            ...config.metadata,
            cogniaGatewayTask: taskId,
            ...projection.metadata,
            piExtensionPolicy: "isolated",
            port: 0,
          },
        },
      }
    },
  }
}

function customizedGatewayLaunch(
  config: ExternalAgentConfig,
  profile: GatewayRuntimeProfile,
  entry: ExternalAgentRuntimeCatalogEntry | undefined
): { command: string; args: string[] } {
  if (profile.passthroughLaunch)
    return { command: config.process?.command ?? "", args: [...(config.process?.args ?? [])] }
  const command = config.process?.command || (profile.fallbackCommand ?? "")
  const basename = command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd)$/i, "")
  const systemCommand = entry?.systemCommand ?? profile.fallbackCommand
  const legacyLaunch = entry?.legacyLaunches?.find((launch) => launch.command === basename)
  if (basename !== systemCommand && !legacyLaunch) {
    throw new Error(
      "Cognia model customization requires an executable matching the selected runtime"
    )
  }
  const required = [...(legacyLaunch?.args ?? entry?.launchArgs ?? [])]
  const configured = config.process?.args ?? required
  if (basename === "npx" && required[0] === "-y") {
    if (configured[0] === "--yes" || configured[0] === "--no-install") required[0] = configured[0]
    else if (configured[0] === required[1]) required.shift()
  }
  const args: string[] = []
  let prefixIndex = 0
  const grammar = profile.arguments(config, entry)
  for (let i = 0; i < configured.length; i++) {
    const token = configured[i]
    if (token === required[prefixIndex]) {
      args.push(token)
      prefixIndex++
      continue
    }
    // npx package selection is fixed before any agent-owned option is parsed.
    if (basename === "npx" && prefixIndex < required.length) {
      throw new Error("Cognia model customization cannot replace the catalogued package launch")
    }
    const separator = token.indexOf("=")
    const flag = separator < 0 ? token : token.slice(0, separator)
    if (grammar.assignment?.flags.includes(flag)) {
      const value = separator < 0 ? configured[++i] : token.slice(separator + 1)
      grammar.assignment.validate(value)
      args.push(token)
      if (separator < 0) args.push(value!)
      continue
    }
    if (grammar.switches.includes(flag) && separator < 0) {
      args.push(token)
      continue
    }
    if (grammar.values.includes(flag)) {
      const value = separator < 0 ? configured[++i] : token.slice(separator + 1)
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error(`Cognia model customization argument ${flag} requires a value`)
      }
      args.push(token)
      if (separator < 0) args.push(value)
      continue
    }
    // Do not echo arbitrary values: a rejected argument may contain a secret.
    throw new Error(
      "Unsupported Cognia model customization argument; use the Agent's own model route for unrestricted launch options"
    )
  }
  if (prefixIndex !== required.length) {
    throw new Error(
      "Cognia model customization must retain the runtime's protocol launch arguments"
    )
  }
  return { command, args }
}

function customizationEnvironment(
  config: ExternalAgentConfig,
  rules: GatewayEnvironmentRules
): Record<string, string> {
  const preserved = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR"])
  for (const key of rules.preserved ?? []) preserved.add(key)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.process?.env ?? {})) {
    if (preserved.has(key) || rules.preservedPrefixes?.some((prefix) => key.startsWith(prefix)))
      env[key] = value
    // These values belong to the selected route or the task-owned home. Their
    // replacement is deliberate, unlike silently throwing away custom flags.
    else if (
      [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "CODEX_HOME",
        "CODEX_CONFIG",
        "MODEL_PROVIDER",
        "DEFAULT_AUTH_REQUEST",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CONFIG_DIR",
        "QWEN_HOME",
        "QWEN_API_KEY",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "COGNIA_GATEWAY_TASK_CONFIG",
        "COGNIA_GATEWAY_TOKEN",
        "COGNIA_TOOLHOST_SOCKET",
        "COGNIA_TOOLHOST_TOKEN",
        "COGNIA_TOOLHOST_SERVER",
        ...(rules.routeOwned ?? []),
      ].includes(key) ||
      rules.routeOwnedPrefixes?.some((prefix) => key.startsWith(prefix))
    )
      continue
    else throw new Error(`Unsupported Cognia model environment customization: ${key}`)
  }
  return env
}

export function admittedNativeModel(
  plan: TaskModelPlan | undefined,
  slot: string,
  selected: ExternalAgentCogniaModelBinding,
  primaryProvider: string,
  allowed: readonly string[]
): string {
  const selector = plan?.slots[slot]?.modelId ?? selected.modelId
  const binding = plan?.bindings?.[selector]
  if (
    !allowed.includes(selector) ||
    (binding
      ? binding.providerId !== selected.providerId || binding.modelId !== selected.modelId
      : selected.providerId !== primaryProvider || selector !== selected.modelId)
  )
    throw new Error("Native subagent model is not admitted by this Cognia task")
  return selector
}

export function gatewaySessionId(
  taskId: string,
  nativeSessionId: string,
  binding?: ExternalAgentCogniaModelBinding
): string {
  return `${SESSION_PREFIX}${taskId}:${encodeURIComponent(nativeSessionId)}${binding ? `:${encodeURIComponent(JSON.stringify(binding))}` : ""}`
}
export function parseGatewaySessionId(
  sessionId?: string
):
  | { taskId: string; nativeSessionId: string; binding?: ExternalAgentCogniaModelBinding }
  | undefined {
  if (!sessionId?.startsWith(SESSION_PREFIX)) return undefined
  const rest = sessionId.slice(SESSION_PREFIX.length)
  const separator = rest.indexOf(":")
  const taskId = rest.slice(0, separator)
  if (separator < 0 || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId))
    throw new Error("Invalid gateway task session")
  const [encodedSession, encodedBinding] = rest.slice(separator + 1).split(":")
  const nativeSessionId = decodeURIComponent(encodedSession)
  const binding = encodedBinding
    ? (normalizeCogniaModelBinding(JSON.parse(decodeURIComponent(encodedBinding))) ?? undefined)
    : undefined
  if (!nativeSessionId) throw new Error("Invalid gateway task session")
  return { taskId, nativeSessionId, ...(binding ? { binding } : {}) }
}
