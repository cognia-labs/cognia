/**
 * Carry root-keyed policy across a Registry Bundle turn.
 *
 * A bundle turn runs in aliases of the source checkouts, not in the checkouts
 * themselves. Anything that names roots by their source path, such as
 * confinement roots or the Workspace Trust proof (`trustedWorkspaceRoots`),
 * stops matching the send's active roots once cwd and additionalDirectories are
 * re-pointed at the aliases. The sidecar only honours a trusted root that is
 * also active for the send, so an un-remapped proof silently proves nothing.
 *
 * Pure leaf: no Tauri, no Dexie. Safe for the connector loop, the scheduler and
 * their tests without mocking.
 */

import { relativePathWithinRoot } from "@/lib/files/permissions"

/**
 * Replace every value that is EXACTLY a source root with that root's alias.
 * A value with no mapping passes through unchanged. Matching is exact on the
 * trimmed path: a subdirectory of a source root is a different root, and the
 * trust grant it would inherit was never given for it.
 */
export function remapExactRoots(
  values: readonly string[],
  aliasesBySource: ReadonlyMap<string, string>
): string[] {
  return values.map((value) => aliasesBySource.get(value.trim()) ?? value)
}

/**
 * Re-point directories a send names at the aliases that now check them out.
 *
 * Unlike {@link remapExactRoots}, which carries a trust grant and so matches
 * only an exact root, this maps access: a directory that IS a source root
 * becomes its alias, and one INSIDE a source root becomes the same path inside
 * the alias, so the turn keeps reaching it without touching the source
 * checkout. A directory under no aliased root (an `@`-referenced folder
 * elsewhere, a root the bundle did not check out) passes through unchanged.
 * The deepest matching source root wins when roots nest.
 */
export function remapPathsIntoAliases(
  values: readonly string[],
  aliasesBySource: ReadonlyMap<string, string>
): string[] {
  const sources = [...aliasesBySource.keys()].sort((a, b) => b.length - a.length)
  return values.map((value) => {
    const exact = aliasesBySource.get(value.trim())
    if (exact) return exact
    for (const source of sources) {
      const relative = relativePathWithinRoot(value.trim(), source)
      if (relative === null) continue
      const alias = aliasesBySource.get(source)!
      const separator = alias.includes("\\") && !alias.includes("/") ? "\\" : "/"
      const segments = relative.split("/").join(separator)
      return alias.endsWith(separator) ? `${alias}${segments}` : `${alias}${separator}${segments}`
    }
    return value
  })
}
