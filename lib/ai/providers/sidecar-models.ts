/**
 * Sidecar-backed provider models: the Host's feature-call channel serves
 * Bedrock and diagnostic models, embeddings and Bedrock model discovery, so
 * credentials never leave the Host process.
 */
import type { EmbeddingModelV3, LanguageModelV3 } from "@ai-sdk/provider"
import type { FeatureCallCredentials } from "@cognia/agent-config-types"

import {
  defaultClient,
  type SidecarEmbeddingModelConfig,
  type SidecarLanguageModelConfig,
} from "@/lib/ai/agent/execution/sidecar-feature-client"

export function createBedrockSidecarLanguageModel(
  config: SidecarLanguageModelConfig
): LanguageModelV3 {
  return defaultClient.languageModel(config)
}

/** Generic sidecar-backed model used by provider diagnostics for real streaming. */
export function createSidecarLanguageModel(config: SidecarLanguageModelConfig): LanguageModelV3 {
  return defaultClient.languageModel(config)
}

export function createBedrockSidecarEmbeddingModel(
  config: SidecarEmbeddingModelConfig
): EmbeddingModelV3 {
  return defaultClient.embeddingModel(config)
}

export function createSidecarEmbeddingModel(config: SidecarEmbeddingModelConfig): EmbeddingModelV3 {
  return defaultClient.embeddingModel(config)
}

export interface BedrockDiscoveredModel {
  id: string
  name?: string
  provider?: string
  supportsVision?: boolean
  supportsStreaming?: boolean
}

export async function discoverBedrockModelsViaSidecar(
  credentials: FeatureCallCredentials,
  abortSignal?: AbortSignal
): Promise<BedrockDiscoveredModel[]> {
  const result = (await defaultClient.requestResult(
    {
      operation: "bedrock-discover",
      providerId: "bedrock",
      credentials,
    },
    abortSignal
  )) as { models?: BedrockDiscoveredModel[] }
  return result.models ?? []
}
