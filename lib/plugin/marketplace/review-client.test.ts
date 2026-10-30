import { createRegistryReviewClient } from "./review-client"
import type { PluginMarketplace } from "../package/marketplace"

jest.mock("../core/manager", () => ({ getPluginManager: jest.fn() }))
jest.mock("../origin/install-origin", () => ({ recordInstallOrigin: jest.fn() }))
import { getPluginManager } from "../core/manager"
import { recordInstallOrigin } from "../origin/install-origin"

describe("registry package review", () => {
  const staged = {
    pluginId: "dep",
    version: "1.0.0",
    transactionId: "staged-package",
    manifest: { id: "dep", version: "1.0.0", permissions: ["network:fetch"] },
  }
  const makeMarket = () => ({
    getPlugin: jest.fn(),
    getVersions: jest.fn(async () => [{ version: "1.0.0", checksum: "digest" }]),
    stagePluginUpdate: jest.fn(async () => staged),
    discardStagedPluginUpdate: jest.fn(async () => undefined),
    getRegistryUrl: jest.fn(() => "https://registry.example"),
    installPlugin: jest.fn(),
  })

  beforeEach(() => jest.clearAllMocks())

  it("reviews and installs the exact authenticated package, preserving configuration", async () => {
    const market = makeMarket()
    const install = jest.fn(async (stage: () => Promise<unknown>) => {
      await stage()
      return { descriptor: {} }
    })
    jest.mocked(getPluginManager).mockReturnValue({ installPluginFromRegistry: install } as never)
    const client = createRegistryReviewClient(market as unknown as PluginMarketplace)
    const review = await client.preparePlugin!("dep", "1.0.0")
    expect(review.manifest).toBe(staged.manifest)
    expect(install).not.toHaveBeenCalled()
    await review.install({ token: "configured" })
    await review.dispose()
    expect(install).toHaveBeenCalledWith(expect.any(Function), { token: "configured" })
    expect(recordInstallOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "dep", version: "1.0.0" })
    )
    expect(market.discardStagedPluginUpdate).not.toHaveBeenCalled()
    expect(market.installPlugin).not.toHaveBeenCalled()
  })

  it("discards a staged package when review is cancelled", async () => {
    const market = makeMarket()
    const client = createRegistryReviewClient(market as unknown as PluginMarketplace)
    const review = await client.preparePlugin!("dep", "1.0.0")
    await review.dispose()
    expect(market.discardStagedPluginUpdate).toHaveBeenCalledWith(staged)
  })

  it("still owns staging if the manager fails before requesting the package", async () => {
    const market = makeMarket()
    jest.mocked(getPluginManager).mockReturnValue({
      installPluginFromRegistry: jest.fn(async () => {
        throw new Error("directory unavailable")
      }),
    } as never)
    const client = createRegistryReviewClient(market as unknown as PluginMarketplace)
    const review = await client.preparePlugin!("dep", "1.0.0")
    await expect(review.install()).rejects.toThrow("directory unavailable")
    await review.dispose()
    expect(market.discardStagedPluginUpdate).toHaveBeenCalledWith(staged)
  })

  it("rejects unavailable versions before staging", async () => {
    const market = makeMarket()
    const client = createRegistryReviewClient(market as unknown as PluginMarketplace)
    await expect(client.preparePlugin!("dep", "2.0.0")).rejects.toThrow("reviewVersionUnavailable")
    expect(market.stagePluginUpdate).not.toHaveBeenCalled()
  })

  it("disables implicit dependency installation on the direct adapter path", async () => {
    const market = makeMarket()
    const client = createRegistryReviewClient(market as unknown as PluginMarketplace)
    await client.installPlugin("dep", "1.0.0")
    expect(market.installPlugin).toHaveBeenCalledWith("dep", "1.0.0", {
      installDependencies: false,
    })
  })
})
