/** The manager's existing module-bridge lifecycle owns imperative issue providers too. */
export {
  registerIssueSyncProviderDeclarationsForPlugin as registerIssueSyncProvidersForPlugin,
  clearIssueSyncProvidersForPlugin as unregisterIssueSyncProvidersForPlugin,
} from "@/lib/plugin/api/issues-api"
