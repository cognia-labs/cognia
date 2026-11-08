/**
 * The resolved-principal stamp a connector writes onto an inbound event's
 * `channelData` after it resolves the sender to a principal, so the sites
 * that create runs can attribute the initiator without resolving again.
 * Recovery replays re-enter the connector pipeline, which stamps again: the
 * principal registry stays the authority, never this copy.
 *
 * It sits in the kernel because acting authority (`./acting-authority.ts`)
 * reads it; the connector that writes it imports it from here.
 */
export interface ResolvedPrincipalStamp {
  principalId: string
  accountId: string
}

/** Typed reader for the `channelData.resolvedPrincipal` stamp. */
export function readResolvedPrincipal(
  channelData: Record<string, unknown> | undefined
): ResolvedPrincipalStamp | undefined {
  const raw = channelData?.resolvedPrincipal
  if (!raw || typeof raw !== "object") return undefined
  const stamp = raw as Record<string, unknown>
  if (typeof stamp.principalId !== "string" || typeof stamp.accountId !== "string") return undefined
  return { principalId: stamp.principalId, accountId: stamp.accountId }
}
