import type {
  GatewayRuntimeProfile,
  GatewayLaunchContext,
  AgentModelSlotDescriptor,
} from "@cognia/agent-contracts/gateway-task"

export const CLAUDE_GATEWAY_TASK_SETTINGS = Object.freeze({
  includeCoAuthoredBy: false,
  attribution: Object.freeze({ commit: "", pr: "" }),
})

const CLAUDE_EVIDENCE = "claude-code v2.1.304 (sub-agents, model-config)"
const CLAUDE_SLOTS: readonly AgentModelSlotDescriptor[] = [
  { id: "subagent.default", kind: "child-default", evidence: CLAUDE_EVIDENCE },
  { id: "tier.haiku", kind: "tier", evidence: CLAUDE_EVIDENCE },
  { id: "tier.sonnet", kind: "tier", evidence: CLAUDE_EVIDENCE },
  { id: "tier.opus", kind: "tier", evidence: CLAUDE_EVIDENCE },
]
export const claudeGatewayProfile: GatewayRuntimeProfile = {
  runtime: "claude",
  traits: { ingress: "anthropic", continuity: "native-resume" },
  slots: () => CLAUDE_SLOTS,

  accepts(config, entry) {
    if (
      !config.process ||
      config.network?.endpoint ||
      !entry ||
      !["claude-agent-acp"].includes(entry.runtimeId)
    )
      return false
    return (
      Boolean(config.process.command) &&
      entry.protocol === config.protocol &&
      config.transport === "stdio"
    )
  },
  arguments: (_config, _entry) => ({ values: [], switches: [] }),
  environment: {},
  project(ctx: GatewayLaunchContext) {
    const { model, endpoint, secret, meta, modelPlan } = ctx
    const subagent = modelPlan?.slots["subagent.default"]
    const files: Record<string, string> = {}
    const env: Record<string, string> = {}
    const launchArgs: string[] = []
    const selectedModel: string | undefined = model

    env.ANTHROPIC_BASE_URL = endpoint.replace(/\/v1\/?$/, "")
    env.ANTHROPIC_AUTH_TOKEN = secret
    env.ANTHROPIC_MODEL = model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelPlan?.slots["tier.opus"]?.modelId ?? model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelPlan?.slots["tier.sonnet"]?.modelId ?? model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelPlan?.slots["tier.haiku"]?.modelId ?? model
    if (subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = subagent.modelId
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    files["claude/settings.json"] = JSON.stringify(CLAUDE_GATEWAY_TASK_SETTINGS)
    if (meta.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(meta.maxOutputTokens)

    return { model: selectedModel, env, files, args: launchArgs }
  },
}
