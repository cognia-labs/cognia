import { codexGatewayProfile } from "./gateway-config"
import type { GatewayLaunchContext } from "@cognia/agent-contracts/gateway-task"

it("projects the admitted route using only supplied facts and leaves its source config untouched", () => {
  const config = {
    id: "saved",
    name: "Agent",
    enabled: true,
    protocol: "acp",
    transport: "stdio",
    process: { command: "agent", env: {} },
    metadata: {},
  }
  const before = JSON.stringify(config)
  const context = {
    config,
    binding: { providerId: "test", modelId: "model" },
    taskId: "task",
    endpoint: "http://127.0.0.1:9999/v1",
    secret: "fixture-lease",
    model: "model",
    meta: { id: "model", contextLength: 32000, maxOutputTokens: 1000 },
    modelMetadataFor: (id: string) => ({ id }),
    reasoningEffortsFor: () => [],
    parseFrontmatter: (content: string) => ({ data: {}, body: content }),
  } as GatewayLaunchContext
  const projection = codexGatewayProfile.project(context)
  expect(projection.files).toEqual(expect.any(Object))
  expect(JSON.stringify(projection.files)).not.toContain("fixture-lease")
  expect(JSON.stringify(config)).toBe(before)
  expect(
    codexGatewayProfile.accepts(
      { ...config, network: { endpoint: "https://remote" } } as GatewayLaunchContext["config"],
      undefined
    )
  ).toBe(false)
})
