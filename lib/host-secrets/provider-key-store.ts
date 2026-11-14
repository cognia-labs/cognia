/**
 * The in-memory half of the host provider-key overlay (ADR-0224 A6).
 *
 * A leaf with no imports, because `createProviderSettingsSnapshot` reads it
 * and is imported almost everywhere; how the keys are loaded and kept fresh
 * lives in `./provider-key-overlay`.
 */

let keys: ReadonlyMap<string, string> = new Map()
let applies: (() => boolean) | null = null

/** How many keys the overlay holds. */
export function hostProviderKeyCount(): number {
  return keys.size
}

/** The key sealed on this host for `providerId`, if any. */
export function hostProviderKey(providerId: string): string | undefined {
  if (applies && !applies()) return undefined
  return keys.get(providerId)
}

/** Replace what the overlay holds. Blank keys are dropped. */
export function replaceHostProviderKeys(entries: Iterable<readonly [string, string]>): void {
  const next = new Map<string, string>()
  for (const [providerId, apiKey] of entries) {
    if (providerId && apiKey.trim()) next.set(providerId, apiKey)
  }
  keys = next
}

/**
 * Install (or clear, with `null`) the predicate that says whether the overlay
 * may answer right now. The keys belong to the process that holds them: a
 * desktop that is driving a paired remote Host builds that Host's turns, and
 * a key sealed on this desktop must not ride along in their credentials.
 */
export function setHostProviderKeyOverlayGate(gate: (() => boolean) | null): void {
  applies = gate
}

/**
 * `providers` with the host's sealed keys filled into entries that have no key
 * of their own, and an entry added for a provider the settings do not list.
 * Returns the input unchanged (same object) when there is nothing to add.
 */
export function overlayHostProviderKeys<T extends { apiKey?: string }>(
  providers: Record<string, T>
): Record<string, T> {
  if (keys.size === 0) return providers
  if (applies && !applies()) return providers
  let next: Record<string, T> | null = null
  for (const [providerId, apiKey] of keys) {
    const entry = providers[providerId]
    if (entry?.apiKey?.trim()) continue
    next ??= { ...providers }
    next[providerId] = { ...(entry ?? {}), apiKey } as T
  }
  return next ?? providers
}
