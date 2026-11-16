const languageModel = jest.fn()
const embeddingModel = jest.fn()
const requestResult = jest.fn()

jest.mock("@/lib/ai/agent/execution/sidecar-feature-client", () => ({
  defaultClient: {
    languageModel: (...args: unknown[]) => languageModel(...args),
    embeddingModel: (...args: unknown[]) => embeddingModel(...args),
    requestResult: (...args: unknown[]) => requestResult(...args),
  },
}))

import {
  createBedrockSidecarEmbeddingModel,
  createBedrockSidecarLanguageModel,
  createSidecarEmbeddingModel,
  createSidecarLanguageModel,
  discoverBedrockModelsViaSidecar,
} from "./sidecar-models"

const config = { modelId: "m", providerId: "bedrock", credentials: { apiKey: "k" } }

beforeEach(() => jest.clearAllMocks())

it("builds language models on the shared feature-call client", () => {
  const model = { modelId: "m" }
  languageModel.mockReturnValue(model)
  expect(createBedrockSidecarLanguageModel(config)).toBe(model)
  expect(createSidecarLanguageModel(config)).toBe(model)
  expect(languageModel).toHaveBeenCalledTimes(2)
  expect(languageModel).toHaveBeenCalledWith(config)
})

it("builds embedding models on the shared feature-call client", () => {
  const model = { modelId: "e" }
  embeddingModel.mockReturnValue(model)
  expect(createBedrockSidecarEmbeddingModel(config)).toBe(model)
  expect(createSidecarEmbeddingModel(config)).toBe(model)
  expect(embeddingModel).toHaveBeenCalledTimes(2)
  expect(embeddingModel).toHaveBeenCalledWith(config)
})

it("discovers Bedrock models through a bedrock-discover request", async () => {
  const signal = new AbortController().signal
  requestResult.mockResolvedValue({ models: [{ id: "anthropic.claude" }] })
  await expect(discoverBedrockModelsViaSidecar({ apiKey: "k" }, signal)).resolves.toEqual([
    { id: "anthropic.claude" },
  ])
  expect(requestResult).toHaveBeenCalledWith(
    { operation: "bedrock-discover", providerId: "bedrock", credentials: { apiKey: "k" } },
    signal
  )
})

it("returns no models when the sidecar reports none", async () => {
  requestResult.mockResolvedValue({})
  await expect(discoverBedrockModelsViaSidecar({})).resolves.toEqual([])
})
