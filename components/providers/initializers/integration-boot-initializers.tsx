"use client"

import { useEffect } from "react"

import { ConnectorBusProvider } from "@/components/connectors/connector-bus-provider"
import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { IntegrationRuntimeInitializer } from "./integration-runtime-initializer"
import { ModelsDevCatalogInitializer } from "./models-dev-catalog-initializer"
import { OpenRouterCatalogInitializer } from "./openrouter-catalog-initializer"
import { ProviderCostMirrorInitializer } from "./provider-cost-mirror-initializer"
import { ModuleRuntimeHost } from "./module-runtime-host"

export function IntegrationBootInitializers() {
  useEffect(() => markBootCapabilityReady("integrations"), [])
  return (
    <>
      <ModelsDevCatalogInitializer />
      <OpenRouterCatalogInitializer />
      <IntegrationRuntimeInitializer />
      <ConnectorBusProvider />
      <ProviderCostMirrorInitializer />
      {/* Module runtimes that wait for this group (ADR-0250 §14). */}
      <ModuleRuntimeHost boot="integrations" />
    </>
  )
}

export default IntegrationBootInitializers
