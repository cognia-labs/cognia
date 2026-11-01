import { getIntegrationAccount, updateIntegrationAccount } from "@/lib/db/integrations"
import { HOST_BACKGROUND, withPluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import type {
  IntegrationAccountStatus,
  IntegrationProviderContext,
  IntegrationResourcePage,
  IntegrationResourceQuery,
} from "@/types/plugin/plugin-integration"
import {
  authenticatedIntegrationRequest,
  integrationApiBaseUrl,
  integrationConnectionMetadata,
  type VerifiedBotAccount,
} from "./action-runner"
import {
  getIntegrationAccountStatusProvider,
  getIntegrationResourceProvider,
  getRegisteredIntegration,
} from "./registry"

async function providerContext(
  pluginId: string,
  integrationId: string,
  accountId: string,
  /** ADR-0176: the deployment this account's credential belongs to. */
  apiBaseUrl?: string,
  credentialContext?: PersonalCredentialContext,
  verifiedBotAccount?: VerifiedBotAccount
): Promise<IntegrationProviderContext> {
  const account = await requireAccount(pluginId, accountId)
  return {
    connection: await integrationConnectionMetadata(account),
    pluginId,
    integrationId,
    accountId,
    authenticatedRequest: (input, init) =>
      authenticatedIntegrationRequest(
        pluginId,
        accountId,
        input,
        init,
        credentialContext,
        verifiedBotAccount
      ),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  }
}

async function requireAccount(pluginId: string, accountId: string) {
  const account = await getIntegrationAccount(pluginId, accountId)
  if (!account) throw new Error(`Integration account "${accountId}" was not found`)
  return account
}

export async function listIntegrationResources(
  pluginId: string,
  query: IntegrationResourceQuery,
  credentialContext?: PersonalCredentialContext,
  verifiedBotAccount?: VerifiedBotAccount
): Promise<IntegrationResourcePage> {
  const account = await requireAccount(pluginId, query.accountId)
  const registered = getRegisteredIntegration(pluginId, account.integrationId)
  const provider = getIntegrationResourceProvider(pluginId, account.integrationId)
  if (!registered?.definition.resourceProvider || !provider) {
    throw new Error(`Integration "${account.integrationId}" does not provide resource discovery`)
  }
  if (!registered.definition.resourceProvider.kinds.includes(query.kind)) {
    throw new Error(`Integration resource kind "${query.kind}" is not discoverable`)
  }
  const context = await providerContext(
    pluginId,
    account.integrationId,
    account.id,
    await integrationApiBaseUrl(account),
    credentialContext,
    verifiedBotAccount
  )
  const page = await withPluginExecutionContext(
    pluginId,
    credentialContext ?? HOST_BACKGROUND,
    () => provider({ ...query, limit: Math.min(Math.max(query.limit ?? 50, 1), 100) }, context)
  )
  if (page.items.some((item) => item.kind !== query.kind)) {
    throw new Error("Integration resource provider returned an unexpected resource kind")
  }
  return page
}

export async function checkIntegrationAccountHealth(
  pluginId: string,
  accountId: string,
  credentialContext?: PersonalCredentialContext,
  verifiedBotAccount?: VerifiedBotAccount
): Promise<IntegrationAccountStatus> {
  const account = await requireAccount(pluginId, accountId)
  if (!account.connectionId && account.status?.code === "legacy-connection-unmatched")
    return account.status
  const provider = getIntegrationAccountStatusProvider(pluginId, account.integrationId)
  if (!provider) {
    throw new Error(`Integration "${account.integrationId}" does not provide health checks`)
  }
  let status: IntegrationAccountStatus
  try {
    const context = await providerContext(
      pluginId,
      account.integrationId,
      account.id,
      await integrationApiBaseUrl(account),
      credentialContext,
      verifiedBotAccount
    )
    status = await withPluginExecutionContext(pluginId, credentialContext ?? HOST_BACKGROUND, () =>
      provider(context)
    )
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !["ConnectionUnavailableError", "ConnectionRevisionChanged"].includes(error.name)
    )
      throw error
    status = {
      health: "degraded",
      code:
        error.name === "ConnectionRevisionChanged"
          ? "connection-revision-changed"
          : "connection-unavailable",
      checkedAt: new Date().toISOString(),
      recoveryAction: "reauthorize",
    }
  }
  const normalized = {
    ...status,
    requiredPermissions: status.requiredPermissions
      ? [...new Set(status.requiredPermissions)].sort()
      : undefined,
    grantedPermissions: status.grantedPermissions
      ? [...new Set(status.grantedPermissions)].sort()
      : undefined,
  }
  await updateIntegrationAccount(pluginId, account.id, {
    health: normalized.health,
    status: normalized,
  })
  return normalized
}
