/** Host document providers extend the portable plugin contract with Host-owned metadata. */
import type { Platform } from "@/lib/platform/detect"
import type {
  PluginDocsProvider,
  DocsProviderAccount,
  DocsProviderAccountBinding,
} from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"
export * from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"

export interface DocsProvider extends Omit<PluginDocsProvider, "listAccounts"> {
  listAccounts(): Promise<DocsProviderAccount[]>
  /** Runtime migration of a stored built-in account id to an actual account. */
  resolveLegacyAccount?(binding: DocsProviderAccountBinding): Promise<DocsProviderAccount | null>
  readonly hosts: readonly Platform[]
  /** Manifest-owned name for dynamically contributed providers. */
  readonly label?: string
  readonly urlOrigins?: readonly string[]
}
