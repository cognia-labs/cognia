/** Shared identity checks for picker results, fetches and staged citations. */
import { DocsProviderError } from "./types"
import type {
  DocsProvider,
  DocsProviderAccount,
  DocsProviderAccountBinding,
  RemoteDocRef,
} from "./types"

export function bindRemoteDocRef(ref: RemoteDocRef, account: DocsProviderAccount): RemoteDocRef {
  assertRemoteDocBinding(ref, account.id, account.authorizationEpoch)
  return {
    ...ref,
    accountBinding: {
      accountId: account.id,
      ...(account.authorizationEpoch ? { authorizationEpoch: account.authorizationEpoch } : {}),
    },
  }
}

export function assertRemoteDocBinding(
  ref: RemoteDocRef,
  accountId: string,
  authorizationEpoch?: string
): void {
  const binding = ref.accountBinding
  if (
    binding &&
    (binding.accountId !== accountId || binding.authorizationEpoch !== authorizationEpoch)
  ) {
    throw new DocsProviderError("notAuthorized")
  }
}

export function accountMatchesBinding(
  account: DocsProviderAccount,
  binding: DocsProviderAccountBinding
): boolean {
  return (
    account.id === binding.accountId && account.authorizationEpoch === binding.authorizationEpoch
  )
}

/** Resolve a provider-owned legacy id once, then pin its current account revision. */
export async function resolveDocsAccountBinding(
  provider: DocsProvider,
  binding: DocsProviderAccountBinding,
  accounts?: readonly DocsProviderAccount[]
): Promise<DocsProviderAccountBinding | undefined> {
  const available = accounts ?? (await provider.listAccounts())
  const exact = available.find((account) => accountMatchesBinding(account, binding))
  if (exact) return { ...binding }
  const legacy = await provider.resolveLegacyAccount?.(binding)
  if (
    !legacy ||
    !available.some((account) =>
      accountMatchesBinding(account, {
        accountId: legacy.id,
        authorizationEpoch: legacy.authorizationEpoch,
      })
    )
  )
    return undefined
  return {
    accountId: legacy.id,
    ...(legacy.authorizationEpoch ? { authorizationEpoch: legacy.authorizationEpoch } : {}),
  }
}
