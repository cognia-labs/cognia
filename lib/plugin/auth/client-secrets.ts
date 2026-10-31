/** Host configuration helpers. These write-only operations are never on ctx. */
import {
  invokePluginApi,
  isPluginGatewayAvailable,
  PluginGatewayError,
} from "@/lib/plugin/core/transport"

function invokeClientSecretOp<T>(
  pluginId: string,
  api: string,
  payload: Record<string, unknown>
): Promise<T> {
  if (!isPluginGatewayAvailable()) {
    return Promise.reject(
      new PluginGatewayError({
        code: "NOT_SUPPORTED",
        message: "Client secret configuration requires a trusted Host.",
        details: { reason: "confidential-exchange-unavailable" },
        requestId: "",
        api,
        pluginId,
      })
    )
  }
  return invokePluginApi<T>(pluginId, api, payload)
}

export function setProviderClientSecret(
  pluginId: string,
  providerId: string,
  value: string
): Promise<void> {
  return invokeClientSecretOp(pluginId, "auth:setClientSecret", { providerId, value })
}

export function clearProviderClientSecret(pluginId: string, providerId: string): Promise<void> {
  return invokeClientSecretOp(pluginId, "auth:clearClientSecret", { providerId })
}

export function hasProviderClientSecret(pluginId: string, providerId: string): Promise<boolean> {
  return invokeClientSecretOp(pluginId, "auth:hasClientSecret", { providerId })
}
