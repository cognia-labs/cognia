/** Host configuration helpers. These write-only operations are never on ctx. */
import {
  invokePluginApi,
  isPluginGatewayAvailable,
  PluginGatewayError,
} from "@/lib/plugin/core/transport"

/** Existing gateway taxonomy, with a specific recoverable auth configuration reason. */
export function isClientSecretRequired(error: unknown): boolean {
  const value = error as { code?: unknown; details?: { reason?: unknown } } | null
  return (
    value?.code === "NOT_FOUND" &&
    (value.details?.reason === "client-secret-missing" ||
      value.details?.reason === "client-secret-ambiguous")
  )
}

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
  clientId: string,
  value: string,
  issuer?: string
): Promise<void> {
  return invokeClientSecretOp(pluginId, "auth:setClientSecret", {
    providerId,
    clientId,
    issuer,
    value,
  })
}

export function clearProviderClientSecret(
  pluginId: string,
  providerId: string,
  clientId: string,
  issuer?: string
): Promise<void> {
  return invokeClientSecretOp(pluginId, "auth:clearClientSecret", { providerId, clientId, issuer })
}

export function hasProviderClientSecret(
  pluginId: string,
  providerId: string,
  clientId: string,
  issuer?: string
): Promise<boolean> {
  return invokeClientSecretOp(pluginId, "auth:hasClientSecret", { providerId, clientId, issuer })
}
