/**
 * Ask every entry point of a restricted Site what an anonymous visitor gets.
 *
 * Configuration is not the result. A Worker-scoped Access application is
 * verified before traffic moves, but whether `workers.dev`, each Custom Domain
 * and each route actually stops a visitor is only knowable by asking them with
 * no credentials — the check ADR-0084's "an unverifiable or bypassed policy
 * fails closed for restricted Sites" needs, and which nothing performed.
 *
 * A request that Cloudflare Access intercepts never reaches the Worker: it is
 * redirected to the team's `*.cloudflareaccess.com` login, or refused with
 * 401/403. Anything else came from the Worker, so the entry is exposed. No
 * answer at all (DNS still propagating, a timeout) is `unverified`, never
 * `protected`.
 */
import { proxyFetch } from "@/lib/network/proxy-fetch"
import type { SiteEntryOutcome, SiteEntryVerification } from "@/types/sites"

type ProbeFetch = (
  url: string,
  init: RequestInit & { timeout?: number }
) => Promise<Pick<Response, "status" | "headers">>

const ACCESS_LOGIN_SUFFIX = ".cloudflareaccess.com"

function accessRedirect(location: string | null, from: string): boolean {
  if (!location) return false
  try {
    const target = new URL(location, from)
    return target.protocol === "https:" && target.hostname.endsWith(ACCESS_LOGIN_SUFFIX)
  } catch {
    return false
  }
}

export async function probeSiteEntry(
  url: string,
  fetcher: ProbeFetch = proxyFetch
): Promise<SiteEntryVerification["entries"][number]> {
  let response: Pick<Response, "status" | "headers">
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      timeout: 10_000,
    })
  } catch {
    return { url, outcome: "unverified" }
  }
  const { status } = response
  if (status === 401 || status === 403) return { url, outcome: "protected", status }
  if (status >= 300 && status < 400) {
    return {
      url,
      outcome: accessRedirect(response.headers.get("location"), url) ? "protected" : "exposed",
      status,
    }
  }
  // A browser `fetch` with `redirect: "manual"` hides the redirect as status 0.
  if (status === 0) return { url, outcome: "unverified", status }
  return { url, outcome: "exposed", status }
}

const RANK: Record<SiteEntryOutcome, number> = { protected: 0, unverified: 1, exposed: 2 }

export function summarizeSiteEntries(
  entries: SiteEntryVerification["entries"],
  checkedAt: number
): SiteEntryVerification {
  const state = entries.reduce<SiteEntryOutcome>(
    (worst, entry) => (RANK[entry.outcome] > RANK[worst] ? entry.outcome : worst),
    entries.length === 0 ? "unverified" : "protected"
  )
  return { checkedAt, state, entries }
}

/**
 * A concrete URL for a route pattern, or `undefined` when there is none to ask.
 *
 * `example.com/api/*` is probed at `https://example.com/api/`. A wildcard host
 * (`*.example.com/*`) names no single host, so it stays `unverified`.
 */
export function routeProbeUrl(pattern: string): string | undefined {
  const [host, ...rest] = pattern.split("/")
  if (!host || host.includes("*")) return undefined
  const path = rest.join("/").split("*")[0]
  return `https://${host}/${path}`
}

export async function probeSiteEntries(
  input: { urls: readonly string[]; unprobeable?: readonly string[]; now: number },
  fetcher?: ProbeFetch
): Promise<SiteEntryVerification> {
  const probed = await Promise.all(input.urls.map((url) => probeSiteEntry(url, fetcher)))
  const skipped = (input.unprobeable ?? []).map((url) => ({
    url,
    outcome: "unverified" as const,
  }))
  return summarizeSiteEntries([...probed, ...skipped], input.now)
}
