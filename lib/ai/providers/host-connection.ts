/** A real, bounded model probe over the paired channel; no generic HTTP access. */
import type { ApiTestResult } from "@cognia/provider-core/providers/api-test"
import type { ApiFlavor } from "@cognia/provider-types"
import { getBuiltInProviderProtocol } from "@cognia/provider-types/built-in-provider-catalog"
import { createProviderSettingsSnapshot, resolveFeatureProvider } from "../provider-consumption"
import { createHostLlmClient } from "../host-llm-client"

export interface HostConnectionConfig {
  apiKey: string
  baseURL?: string
  defaultModel?: string
  protocol?: string
  apiFlavor?: ApiFlavor
  customHeaders?: Record<string, string>
}

export async function testHostProviderConnection(
  providerId: string,
  config: HostConnectionConfig
): Promise<ApiTestResult> {
  const start = Date.now()
  try {
    const resolution = resolveFeatureProvider(
      {
        featureId: "provider-connection-test",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId,
        fallbackMode: "none",
      },
      createProviderSettingsSnapshot({
        defaultProvider: providerId,
        providerSettings: { [providerId]: { ...config, enabled: true } },
        customProviders: getBuiltInProviderProtocol(providerId)
          ? undefined
          : [
              {
                id: providerId,
                ...config,
                enabled: true,
                protocol: config.protocol ?? "openai",
              },
            ],
      })
    )
    if (resolution.kind !== "resolved" || !resolution.model) {
      throw new Error(
        resolution.kind !== "resolved"
          ? resolution.reason
          : "Select a model before testing through Host"
      )
    }
    const text = await createHostLlmClient(
      { ...resolution, model: resolution.model },
      "provider-connection-test"
    ).complete("Reply with OK.", { maxTokens: 16, temperature: 0 })
    if (!text.trim()) throw new Error("Host provider returned an empty response")
    return {
      success: true,
      outcome: "verified",
      authoritative: true,
      message: "Connected successfully through Host.",
      latency_ms: Date.now() - start,
      model_info: resolution.model,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Host connection test failed"
    return {
      success: false,
      outcome: "failed",
      authoritative: true,
      message: config.apiKey ? message.replaceAll(config.apiKey, "[redacted]") : message,
      latency_ms: Date.now() - start,
    }
  }
}
