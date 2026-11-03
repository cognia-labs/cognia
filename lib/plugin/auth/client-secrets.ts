import { currentExternalServiceRuntimeContext } from "@/lib/external-services/runtime-profile"
/** Host configuration helpers. These write-only operations are never on ctx. */
import { invokePluginApi, PluginGatewayError } from "@/lib/plugin/core/transport"
import {
  assertRuntimeSupported,
  RuntimeSupportError,
} from "@/lib/external-services/runtime-support"

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
  try {
    assertRuntimeSupported("auth:confidential-exchange", currentExternalServiceRuntimeContext())
  } catch (error) {
    if (!(error instanceof RuntimeSupportError)) throw error
    return Promise.reject(
      new PluginGatewayError({
        code: "NOT_SUPPORTED",
        message: "Client secret configuration requires a trusted Host.",
        details: { reason: error.reason, recovery: error.recovery },
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
