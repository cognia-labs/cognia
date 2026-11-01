/** Host document providers extend the portable plugin contract with Host-owned metadata. */
import type { Platform } from "@/lib/platform/detect"
import type {
  PluginDocsProvider,
  DocsProviderAccount,
} from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"
export * from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"

export interface DocsProvider extends Omit<PluginDocsProvider, "listAccounts"> {
  listAccounts(): Promise<DocsProviderAccount[]>
  readonly hosts: readonly Platform[]
  /** Manifest-owned name for dynamically contributed providers. */
  readonly label?: string
  readonly urlOrigins?: readonly string[]
}
