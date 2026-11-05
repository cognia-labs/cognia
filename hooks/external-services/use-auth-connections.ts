"use client"

import { listGoogleConnections } from "@/lib/auth-providers/google/host-auth"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listAuthConnections } from "@/lib/db/auth-connections"
import { listServiceConnections, listCapabilityGrants } from "@/lib/db/external-services"
import { listPlugins } from "@/lib/db/plugins"
import { buildConnectionViews } from "@/lib/external-services/connection-view"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import { listLarkConnections } from "@/lib/auth-providers/feishu/host-auth"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { useHostProfile } from "@/hooks/use-host-profile"
import {
  getAuthProviderRevision,
  listProviders,
  subscribeAuthProviders,
} from "@/lib/plugin/auth/auth-provider-registry"
import {
  getIntegrationRegistryRevision,
  listRegisteredIntegrationEntries,
  subscribeIntegrationRegistry,
} from "@/lib/integrations/registry"

/** Manager events cover status/provider changes; Dexie also observes grants and plugin labels. */
export function useAuthConnections() {
  const hostProfile = useHostProfile()
  const [revision, setRevision] = useState(0)
  useEffect(() => getConnectionManager().onDidChange(() => setRevision((value) => value + 1)), [])
  const providerRevision = useSyncExternalStore(
    subscribeAuthProviders,
    getAuthProviderRevision,
    getAuthProviderRevision
  )
  const integrationRevision = useSyncExternalStore(
    subscribeIntegrationRegistry,
    getIntegrationRegistryRevision,
    getIntegrationRegistryRevision
  )
  const result = useLiveQuery(async () => {
    try {
      // This hook is mounted by the person's Host settings account list.
      if (hostProfile === "desktop") {
        await listLarkConnections({ localAuthorization: LOCAL_PERSON_RUN })
        await listGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
      }
      const connections = await listAuthConnections()
      const projections = await listServiceConnections()
      const grants = (
        await Promise.all(projections.map((row) => listCapabilityGrants(row.id)))
      ).flat()
      const plugins = await listPlugins()
      return {
        rows: buildConnectionViews(
          connections,
          projections,
          grants,
          listProviders(),
          plugins,
          listRegisteredIntegrationEntries()
        ),
        failed: false,
      }
    } catch {
      return { rows: [], failed: true }
    }
  }, [revision, providerRevision, integrationRevision, hostProfile])
  return {
    rows: result?.rows ?? [],
    loading: result === undefined,
    failed: result?.failed ?? false,
    providers: listProviders().filter((provider) => provider.describe),
  }
}
