/** Host document providers extend the portable plugin contract with Host-owned metadata. */
import type { Platform } from "@/lib/platform/detect"
import type {
  PluginDocsProvider,
  DocsProviderAccount,
  DocsProviderAccountBinding,
  DocsProviderCallOptions as PortableCallOptions,
  RemoteDocRef,
  RemoteDocContent,
} from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"
export * from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"

export interface DocsProviderCallOptions extends PortableCallOptions {
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
}
export interface DocsProviderSearchOptions extends DocsProviderCallOptions {
  limit: number
}
export interface DocsProvider extends Omit<
  PluginDocsProvider,
  "listAccounts" | "search" | "fetch"
> {
  search?(query: string, options: DocsProviderSearchOptions): Promise<RemoteDocRef[]>
  fetch(ref: RemoteDocRef, options: DocsProviderCallOptions): Promise<RemoteDocContent>
  /** Host account discovery can hydrate legacy identity only with invocation admission. */
  listAccounts(
    options?: Pick<DocsProviderCallOptions, "credentialContext">
  ): Promise<DocsProviderAccount[]>
  /** Runtime migration preserves the caller's admission. */
  resolveLegacyAccount?(
    binding: DocsProviderAccountBinding,
    options?: Pick<DocsProviderCallOptions, "credentialContext">
  ): Promise<DocsProviderAccount | null>
  readonly hosts: readonly Platform[]
  /** Manifest-owned name for dynamically contributed providers. */
  readonly label?: string
  readonly urlOrigins?: readonly string[]
}
