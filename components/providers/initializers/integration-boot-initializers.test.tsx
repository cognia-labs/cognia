import { render } from "@testing-library/react"

jest.mock("./integration-runtime-initializer", () => ({
  IntegrationRuntimeInitializer: () => <span data-boot="integration" />,
}))
jest.mock("./models-dev-catalog-initializer", () => ({
  ModelsDevCatalogInitializer: () => <span data-boot="models-dev" />,
}))
jest.mock("./openrouter-catalog-initializer", () => ({
  OpenRouterCatalogInitializer: () => <span data-boot="openrouter" />,
}))
jest.mock("./provider-cost-mirror-initializer", () => ({
  ProviderCostMirrorInitializer: () => <span data-boot="provider-cost" />,
}))
jest.mock("@/components/connectors/connector-bus-provider", () => ({
  ConnectorBusProvider: () => <span data-boot="connectors" />,
}))
// The real one renders null; stubbed so a group that dropped its module
// runtimes (ADR-0250 §14) fails here.
jest.mock("./module-runtime-host", () => ({
  ModuleRuntimeHost: ({ boot }: { boot?: string }) => <span data-boot={`modules:${boot}`} />,
}))
const mockMarkReady = jest.fn()
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkReady(...args),
}))

import { IntegrationBootInitializers } from "./integration-boot-initializers"

it("mounts integration runtimes and reports readiness", () => {
  const { container } = render(<IntegrationBootInitializers />)
  expect(
    Array.from(container.querySelectorAll("[data-boot]")).map((node) =>
      node.getAttribute("data-boot")
    )
  ).toEqual([
    "models-dev",
    "openrouter",
    "integration",
    "connectors",
    "provider-cost",
    "modules:integrations",
  ])
  expect(mockMarkReady).toHaveBeenCalledWith("integrations")
})
