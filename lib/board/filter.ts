/**
 * Facet filtering shared by the kanban boards.
 *
 * Every board filters the same way: a facet with nothing selected keeps
 * everything, an engaged facet keeps an item whose value (or any of whose
 * values) is selected, and an item with no value for an engaged facet is
 * dropped. Facets combine with AND; an optional free-text query is one more
 * AND term. A board describes its facets once as a `BoardFilterSpec`, and the
 * active check, the badge count and the filter itself all read that spec, so
 * they cannot disagree about which facets exist.
 */

export interface BoardFacet<T, F> {
  /** The selected values; empty or absent means the facet is off. */
  selected: (filter: F) => readonly string[] | undefined
  /** The item's value(s) for this facet. */
  values: (item: T) => string | readonly string[] | null | undefined
}

export interface BoardFilterSpec<T, F> {
  query?: {
    read: (filter: F) => string
    /** `needle` arrives trimmed and lower-cased, never empty. */
    matches: (item: T, needle: string) => boolean
  }
  facets: readonly BoardFacet<T, F>[]
}

function queryNeedle<T, F>(filter: F, spec: BoardFilterSpec<T, F>): string {
  return spec.query ? spec.query.read(filter).trim().toLowerCase() : ""
}

function engaged<T, F>(facet: BoardFacet<T, F>, filter: F): readonly string[] | null {
  const selected = facet.selected(filter)
  return selected && selected.length > 0 ? selected : null
}

/** How many filter terms are engaged; the query counts as one. */
export function countActiveFacets<T, F>(filter: F, spec: BoardFilterSpec<T, F>): number {
  let count = queryNeedle(filter, spec) ? 1 : 0
  for (const facet of spec.facets) if (engaged(facet, filter)) count += 1
  return count
}

export function isFacetFilterActive<T, F>(filter: F, spec: BoardFilterSpec<T, F>): boolean {
  return countActiveFacets(filter, spec) > 0
}

function asList(values: string | readonly string[] | null | undefined): readonly string[] {
  if (values === null || values === undefined) return []
  return typeof values === "string" ? [values] : values
}

/** The items the filter keeps, in their original order. Always a new array. */
export function applyFacetFilter<T, F>(
  items: readonly T[],
  filter: F,
  spec: BoardFilterSpec<T, F>
): T[] {
  const needle = queryNeedle(filter, spec)
  const facets = spec.facets
    .map((facet) => ({ facet, selected: engaged(facet, filter) }))
    .filter((entry): entry is { facet: BoardFacet<T, F>; selected: readonly string[] } =>
      Boolean(entry.selected)
    )
  if (!needle && facets.length === 0) return [...items]

  return items.filter((item) => {
    if (needle && spec.query && !spec.query.matches(item, needle)) return false
    return facets.every(({ facet, selected }) =>
      asList(facet.values(item)).some((value) => selected.includes(value))
    )
  })
}

/** Distinct values of one facet across `items`, sorted: the options to offer. */
export function collectFacetValues<T>(
  items: readonly T[],
  values: (item: T) => string | readonly string[] | null | undefined
): string[] {
  const seen = new Set<string>()
  for (const item of items) for (const value of asList(values(item))) if (value) seen.add(value)
  return [...seen].sort()
}
