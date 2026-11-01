import type { PluginIssueSyncProvider } from "@cognia/plugin-contract/lib/issues/sync/types"

/** Preserve inferred config callbacks while checking the public issue-sync contract. */
export function defineIssueSyncProvider<T extends PluginIssueSyncProvider>(provider: T): T {
  return provider
}
