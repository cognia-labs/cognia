import { ohMyPiGatewayProfile } from "./oh-my-pi-gateway"
import type { GatewayLaunchContext } from "@cognia/agent-contracts/gateway-task"
import { GATEWAY_TOKEN_ENV } from "@cognia/agent-runtime-kit/gateway-task"

describe("ohMyPiGatewayProfile", () => {
  const baseConfig = {
    id: "saved",
    name: "oh-my-pi",
    enabled: true,
    protocol: "acp" as const,
    transport: "stdio" as const,
    process: { command: "omp", args: ["acp"], env: {} },
    metadata: { preset: "oh-my-pi" },
  }

  it("projects JSON-in-YAML models.yml and config.yml without leaking the lease secret", () => {
    const before = JSON.stringify(baseConfig)
    const context = {
      config: baseConfig,
      binding: { providerId: "test", modelId: "model" },
      taskId: "task",
      endpoint: "http://127.0.0.1:9999/v1",
      secret: "fixture-lease",
      model: "model",
      meta: {
        id: "model",
        contextLength: 128000,
        maxInputTokens: 96000,
        maxOutputTokens: 8192,
        supportsReasoning: true,
        supportsVision: true,
      },
      modelMetadataFor: (id: string) => ({ id }),
      reasoningEffortsFor: () => [],
      parseFrontmatter: (content: string) => ({ data: {}, body: content }),
    } as GatewayLaunchContext

    const projection = ohMyPiGatewayProfile.project(context)
    expect(projection.model).toBe("cognia/model")
    expect(projection.env).toEqual({})
    expect(projection.args).toEqual([])
    expect(JSON.stringify(projection.files)).not.toContain("fixture-lease")
    expect(JSON.stringify(baseConfig)).toBe(before)

    const models = JSON.parse(projection.files["omp/models.yml"])
    expect(models).toEqual({
      providers: {
        cognia: {
          baseUrl: "http://127.0.0.1:9999/v1",
          api: "openai-completions",
          // OMP resolves env var names bare (without a leading `$`)
          apiKey: GATEWAY_TOKEN_ENV,
          models: [
            {
              id: "model",
              name: "model",
              contextWindow: 96000,
              maxTokens: 8192,
              reasoning: true,
              input: ["text", "image"],
            },
          ],
        },
      },
    })

    const cfg = JSON.parse(projection.files["omp/config.yml"])
    expect(cfg).toEqual({
      models: {
        default: "cognia/model",
        smol: "cognia/model",
        slow: "cognia/model",
      },
    })
  })

  it("accepts only local stdio oh-my-pi ACP configs", () => {
    const entry = {
      runtimeId: "oh-my-pi",
      protocol: "acp",
    } as GatewayLaunchContext["entry"]

    expect(ohMyPiGatewayProfile.accepts(baseConfig, entry)).toBe(true)
    expect(ohMyPiGatewayProfile.accepts(baseConfig, undefined)).toBe(false)
    expect(
      ohMyPiGatewayProfile.accepts(
        { ...baseConfig, network: { endpoint: "https://remote" } },
        entry
      )
    ).toBe(false)
    expect(ohMyPiGatewayProfile.accepts({ ...baseConfig, transport: "http" }, entry)).toBe(false)
  })
})
