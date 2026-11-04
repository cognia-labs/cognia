import {
  createGatewayTaskTools,
  gatewaySessionId,
  parseGatewaySessionId,
  type GatewayTaskBuildInput,
} from "./gateway-task"
import type { GatewayRuntimeProfile } from "@cognia/agent-contracts/gateway-task"

it("assembles a registered recipe only after validating the route and arguments", () => {
  const project = jest.fn(() => ({
    model: "bound",
    files: { "recipe.json": "{}" },
    env: { ROUTE: "fixture" },
    args: ["--model", "bound"],
  }))
  const profile: GatewayRuntimeProfile = {
    runtime: "aider",
    traits: { ingress: "openai-chat", continuity: "transcript" },
    accepts: () => true,
    arguments: () => ({ values: [], switches: [] }),
    environment: {},
    project,
  }
  const tools = createGatewayTaskTools({
    profiles: [profile],
    findRuntimeForConfig: () => ({ systemCommand: "agent", launchArgs: [] }) as never,
  })
  const input = {
    config: {
      id: "saved",
      name: "Agent",
      enabled: true,
      protocol: "acp",
      transport: "stdio",
      process: { command: "agent", env: { OPENAI_API_KEY: "ambient" } },
    },
    binding: { providerId: "p", modelId: "model" },
    taskId: "task",
    endpoint: "http://local",
    secret: "fixture",
    model: "model",
    ownerAccountId: null,
    modelMetadataFor: () => ({ id: "model" }),
    reasoningEffortsFor: () => [],
    parseFrontmatter: (content: string) => ({ data: {}, body: content }),
  } as GatewayTaskBuildInput
  const prepared = tools.buildGatewayTaskConfig(input)
  expect(prepared.config.process?.env?.OPENAI_API_KEY).toBeUndefined()
  expect(prepared.model).toBe("bound")
  expect(prepared.config.process?.args).toEqual(["--model", "bound"])
  expect(JSON.parse(prepared.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)).toMatchObject({
    taskId: "task",
    files: { "recipe.json": "{}" },
  })
  input.config.process!.args = ["--api-key", "unapproved"]
  expect(() => tools.buildGatewayTaskConfig(input)).toThrow(/Unsupported/)
  expect(project).toHaveBeenCalledTimes(1)
})
it("preserves public gateway session encoding and rejects malformed task ids", () => {
  const binding = { providerId: "p", modelId: "m", accountId: "a" }
  expect(parseGatewaySessionId(gatewaySessionId("task", "native:session", binding))).toEqual({
    taskId: "task",
    nativeSessionId: "native:session",
    binding,
  })
  expect(() => parseGatewaySessionId("cognia-gateway:../task:native")).toThrow()
})
