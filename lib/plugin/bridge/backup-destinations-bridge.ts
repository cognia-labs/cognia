/** Descriptor ownership on enable; all contributions end on disable/uninstall. */
export {
  registerBackupDestinationDeclarationsForPlugin as registerBackupDestinationsForPlugin,
  clearBackupDestinationsForPlugin as unregisterBackupDestinationsForPlugin,
} from "@/lib/plugin/api/backup-api"
