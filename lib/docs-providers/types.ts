/** Host document providers extend the portable plugin contract with Host-owned metadata. */
import type { Platform } from "@/lib/platform/detect"
import type {
  PluginDocsProvider,
  DocsProviderAccount,
  DocsProviderAccountBinding,
  DocsProviderCallOptions as PortableCallOptions,
  RemoteDocKind,
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

/**
 * How a built-in provider recognises its own document URLs for dock tabs
 * (`document-url.ts`). Plugin providers use `matchRef` + `urlOrigins` instead.
 * The list is `providers/_document-urls.ts`.
 */
export interface DocumentUrlScheme {
  readonly providerId: string
  /** Kinds a dock tab may show; every kind when omitted. */
  readonly kinds?: readonly RemoteDocKind[]
  /** Whether a `doc` ref's legacy-vs-docx `sourceType` rides along on the target. */
  readonly keepsSourceType?: boolean
  /**
   * The strict target for a credential-free HTTPS URL without a port, or null
   * when the URL is not this provider's.
   */
  target(url: URL): { resourceKind: RemoteDocKind; resourceId: string; url: string } | null
  /** The canonical URL for a ref that carries none. */
  canonicalUrl?(kind: RemoteDocKind, id: string): string
}
