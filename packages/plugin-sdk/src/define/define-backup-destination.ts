import type { BackupDestinationContribution } from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"

/** Define a ciphertext destination; account selection stays with the contributor. */
export function defineBackupDestination<T extends BackupDestinationContribution>(
  destination: T
): T {
  return destination
}
