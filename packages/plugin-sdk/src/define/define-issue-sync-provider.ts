import type { PluginIssueSyncProvider } from "@cognia/plugin-contract/lib/issues/sync/types"

/** Preserve inferred config callbacks while checking the public issue-sync contract. */
export function defineIssueSyncProvider<T extends PluginIssueSyncProvider>(provider: T): T {
  if (
    provider.connectionRef !== undefined &&
    (typeof provider.connectionRef !== "string" || !provider.connectionRef)
  )
    throw new Error("Invalid sync connectionRef")
  if (
    typeof provider.pull !== "function" ||
    (provider.pullPage !== undefined && typeof provider.pullPage !== "function") ||
    (provider.confirmDeparted !== undefined && typeof provider.confirmDeparted !== "function") ||
    (provider.completeFullScan !== undefined && typeof provider.completeFullScan !== "boolean") ||
    (provider.fullScanOnly !== undefined && typeof provider.fullScanOnly !== "boolean") ||
    (provider.completeFullScan && !provider.pullPage)
  )
    throw new Error("Issue-sync paging flags require a valid pullPage implementation")
  return provider
}
