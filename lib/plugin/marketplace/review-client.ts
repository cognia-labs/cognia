/** Review the authenticated package that will actually be installed. Kept
 * separate from the discovery client so source-bound clients never install
 * arbitrary dependency ids, and cancelled reviews can release staged files. */
import type { RunMarketplaceInstallOpts } from "./install-flow"
import type { PluginMarketplace } from "../package/marketplace"

export function createRegistryReviewClient(
  market: PluginMarketplace
): RunMarketplaceInstallOpts["client"] {
  return {
    getPlugin: (id) => market.getPlugin(id),
    getVersions: (id) => market.getVersions(id),
    supportsTransactionalConfig: true,
    installPlugin: (id, version, options) =>
      market.installPlugin(id, version, {
        ...options,
        installDependencies: false,
      }),
    preparePlugin: async (id, version) => {
      const versions = await market.getVersions(id)
      const selected = version ? versions.find((v) => v.version === version) : versions[0]
      if (!selected) throw new Error("reviewVersionUnavailable")
      const staged = await market.stagePluginUpdate(id, selected)
      let consumed = false
      return {
        manifest: staged.manifest,
        install: async (config) => {
          const { getPluginManager } = await import("../core/manager")
          const installed = await getPluginManager().installPluginFromRegistry(async () => {
            consumed = true
            return staged
          }, config)
          const { recordInstallOrigin } = await import("../origin/install-origin")
          await recordInstallOrigin({
            pluginId: id,
            version: staged.version,
            origin: {
              kind: "registry",
              registryUrl: market.getRegistryUrl(),
              version: staged.version,
              ...(selected.checksum ? { checksum: selected.checksum } : {}),
            },
          })
          return { success: true, descriptor: installed.descriptor }
        },
        dispose: async () => {
          if (!consumed) await market.discardStagedPluginUpdate(staged)
        },
      }
    },
  }
}

export async function loadRegistryReviewClient(): Promise<RunMarketplaceInstallOpts["client"]> {
  const { getPluginMarketplace } = await import("../package/marketplace")
  return createRegistryReviewClient(getPluginMarketplace())
}
