/**
 * Feishu's token paging: a list response carries `items`, `has_more` and a
 * `page_token` for the next page, requested with `page_size` and `page_token`
 * query parameters.
 */

export interface LarkPage<T> {
  items?: T[]
  page_token?: string
  has_more?: boolean
}

/** Something that GETs a Feishu path and returns the envelope's `data`. */
export interface LarkPageReader {
  get<T>(path: string): Promise<T>
}

/** `path` with `page_size` and, when continuing, `page_token` appended. */
export function withLarkPageParams(path: string, pageSize: number, pageToken?: string): string {
  const separator = path.includes("?") ? "&" : "?"
  return `${path}${separator}page_size=${pageSize}${
    pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""
  }`
}

/**
 * Read every page of a list, up to `cap` items and `maxPages` requests.
 * `truncated` is true when either limit stopped the read before Feishu said
 * there was nothing more.
 */
export async function readAllLarkPages<T>(
  reader: LarkPageReader,
  path: string,
  opts: { cap: number; pageSize: number; maxPages?: number }
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let token: string | undefined
  for (let page = 0; page < (opts.maxPages ?? 50); page += 1) {
    const result = await reader.get<LarkPage<T>>(withLarkPageParams(path, opts.pageSize, token))
    items.push(...(result.items ?? []))
    if (items.length >= opts.cap) return { items: items.slice(0, opts.cap), truncated: true }
    if (!result.has_more || !result.page_token) return { items, truncated: false }
    token = result.page_token
  }
  return { items, truncated: true }
}
