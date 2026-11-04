import { gatewayRuntimeProfiles } from "./gateway"
import { buildGatewayTaskConfig, cogniaGatewayRuntime } from "../config/gateway-task"
import { getPresetConfig } from "../config/presets"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"

it.each([
  ["codex-app-server", "codex-app-server", "codex"],
  ["opencode-acp", "acp", "opencode"],
  ["pi-rpc", "pi-rpc", "pi"],
  ["claude-code", "acp", "claude"],
  ["qwen-code", "acp", "qwen"],
  ["deepseek-harness-acp", "acp", "dsh"],
  ["kimi", "acp", "kimi"],
  ["goose", "acp", "goose"],
  ["copilot-cli", "acp", "copilot"],
  ["aider", "aider-cli", "aider"],
])("binds the %s package recipe through the production registry", (preset, protocol, runtime) => {
  const config = {
    ...getPresetConfig(preset),
    id: "saved",
    name: "Agent",
    enabled: true,
    protocol,
    transport: "stdio",
    metadata: { preset },
  } as ExternalAgentConfig
  expect(cogniaGatewayRuntime(config)).toBe(runtime)
  expect(gatewayRuntimeProfiles.filter((p) => p.runtime === runtime)).toHaveLength(1)
  const prepared = buildGatewayTaskConfig({
    config,
    binding: { providerId: "test", modelId: "model" },
    taskId: "task",
    endpoint: "http://127.0.0.1:9999/v1",
    secret: "fixture-lease",
    model: "model",
    settings: { providerSettings: {}, customProviders: [] },
    ownerAccountId: null,
    modelMetadata: { id: "model", supportsTools: true, supportsStreaming: true },
  })
  const payload = JSON.parse(prepared.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)
  expect(payload.runtime).toBe(runtime)
  expect(JSON.stringify(payload.files)).not.toContain("fixture-lease")
})
