/** Portable launch recipes; Host admission and filesystem authority are separate. */
import type { ExternalAgentConfig } from "./external-agent"
import type { ExternalAgentCogniaModelBinding } from "./model-binding"
import type { ExternalAgentRuntimeCatalogEntry } from "./external-agent-lifecycle"
export type { ExternalAgentCogniaModelBinding } from "./model-binding"
export type GatewayRuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network"
>

export type CogniaGatewayRuntime =
  "codex" | "opencode" | "pi" | "claude" | "qwen" | "dsh" | "kimi" | "goose" | "copilot" | "aider"

export type CogniaGatewayUnsupportedReason =
  "unsupported-runtime" | "remote-server" | "no-process" | "network-endpoint"

export interface CodexCatalogRequestModel {
  /** Exact Codex catalog slug and gateway model selector. */
  slug: string
  /** This model's context capacity in tokens, when known. */
  contextWindow?: number
  /** This model's input budget before Codex compacts its history. */
  autoCompactTokenLimit?: number
  /** Input kinds supported by this model; text is always included. */
  inputModalities: ("text" | "image")[]
  /** Offered effort values; omitted unless reasoning support is confirmed. */
  reasoningEfforts?: string[]
}

export interface GatewayTaskPayload {
  taskId: string
  ownerAccountId: string | null
  binding: ExternalAgentCogniaModelBinding
  runtime: CogniaGatewayRuntime
  /**
   * The paired device a Host-run task belongs to. The native host refuses to
   * resume (or rebind) a retained task for another device.
   */
  originDeviceId?: string
  /**
   * Replace the retained model binding of an existing task. Hosts accept this
   * only when the owner account, origin device and runtime are unchanged, so
   * the native history keeps one owner while it moves to another Cognia model.
   */
  rebind?: true
  /** Fixed relative file names only; native hosts derive the state root. No secrets. */
  files: Record<string, string>
  /** Small catalog request assembled from vendored Codex metadata by the task host. */
  codexModelCatalog?: { models: CodexCatalogRequestModel[] }
}
type ModelPlanSource = "call" | "subagent" | "config"
export interface TaskModelPlan {
  version: 2 | 3
  primaryModelId: string
  slots: Record<
    string,
    { modelId: string; reasoningEffort?: string; variant?: string; source: ModelPlanSource }
  >
  models: string[]
  allowedSpawnModels?: string[]
  /** Collision-safe client selectors mapped to their selected provider/account. */
  bindings?: Record<string, ExternalAgentCogniaModelBinding>
  fingerprint: string
}

export interface AgentModelSlotDescriptor {
  id: "subagent.default" | "tier.haiku" | "tier.sonnet" | "tier.opus" | "aux.small" | "aux.vision"
  /**
   * `child-default`: the model a native child (subagent) uses when its own
   * definition and the spawning call name none. `tier`: what a model alias
   * resolves to. `auxiliary`: a helper call (titles, summaries) that is not a
   * child task.
   */
  kind: "child-default" | "tier" | "auxiliary"
  /** Reasoning efforts this slot accepts; absent means effort is not projected. */
  reasoningEfforts?: readonly string[]
  supportsSpawnModelOverrides?: boolean
  evidence: string
}

export interface GatewayModelMetadata {
  id: string
  name?: string
  contextLength?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsReasoning?: boolean
  supportsVision?: boolean
  supportsAudio?: boolean
  supportsVideo?: boolean
  supportsStreaming?: boolean
  supportsStructuredOutput?: boolean
}
export interface GatewayArgumentGrammar {
  values: readonly string[]
  switches: readonly string[]
  assignment?: { flags: readonly string[]; validate(value: string | undefined): void }
}
export interface GatewayEnvironmentRules {
  preserved?: readonly string[]
  preservedPrefixes?: readonly string[]
  routeOwned?: readonly string[]
  routeOwnedPrefixes?: readonly string[]
}
export interface GatewayLaunchContext {
  config: ExternalAgentConfig
  binding: ExternalAgentCogniaModelBinding
  taskId: string
  endpoint: string
  secret: string
  model: string
  meta: GatewayModelMetadata
  modelPlan?: TaskModelPlan
  entry?: ExternalAgentRuntimeCatalogEntry
  modelMetadataById?: Record<string, GatewayModelMetadata>
  /** `route` resolves a selector admitted on another provider/model binding. */
  modelMetadataFor(
    id: string,
    route?: Pick<ExternalAgentCogniaModelBinding, "providerId" | "modelId">
  ): GatewayModelMetadata
  reasoningEffortsFor(id: string): readonly string[]
  parseFrontmatter(content: string): { data: Record<string, unknown>; body: string }
}
export interface GatewayLaunchProjection {
  model: string | undefined
  env: Record<string, string>
  files: Record<string, string>
  args: string[]
  prependArgs?: string[]
  codexModelCatalog?: GatewayTaskPayload["codexModelCatalog"]
  metadata?: Record<string, unknown>
}
export interface GatewayRuntimeProfile {
  runtime: CogniaGatewayRuntime
  traits: {
    ingress: "openai-responses" | "openai-chat" | "anthropic"
    continuity: "native-resume" | "transcript"
  }
  traitVariants?: Record<string, GatewayRuntimeProfile["traits"]>
  supportKey?(config: GatewayRuntimeConfig): string
  accepts(
    config: GatewayRuntimeConfig,
    entry: ExternalAgentRuntimeCatalogEntry | undefined
  ): boolean
  attachedServer?(config: GatewayRuntimeConfig): boolean
  fallbackCommand?: string
  passthroughLaunch?: boolean
  /** A managed runtime resolves its executable after Host admission. */
  allowsUnresolvedCommand?(entry: ExternalAgentRuntimeCatalogEntry | undefined): boolean
  arguments(
    config: ExternalAgentConfig,
    entry: ExternalAgentRuntimeCatalogEntry | undefined
  ): GatewayArgumentGrammar
  environment: GatewayEnvironmentRules
  project(context: GatewayLaunchContext): GatewayLaunchProjection
  slots?(config: GatewayRuntimeConfig): readonly AgentModelSlotDescriptor[]
  nativeModels?(
    config: GatewayRuntimeConfig,
    primary: ExternalAgentCogniaModelBinding
  ): Record<string, ExternalAgentCogniaModelBinding & { variant?: string }>
}
