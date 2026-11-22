/**
 * Runtime discovery of an official Cognia account deployment's enabled social
 * sign-in providers and deletion cooling-off window (`GET /api/account/config`).
 *
 * Separate from `official-deployment.ts` so synchronous callers keep reading
 * static build configuration without network side effects, while sign-in and
 * account-management screens can reflect live server configuration (G7, F19)
 * with graceful fallback when offline or speaking to an older issuer.
 */

import { createPlatformFetch } from "@/lib/network/platform-fetch"

import {
  OFFICIAL_SOCIAL_PROVIDERS,
  type OfficialDeployment,
  type OfficialSocialProvider,
} from "./official-deployment"

export interface OfficialAccountRuntimeConfig {
  providers: OfficialSocialProvider[]
  coolingOffDays: number
}

export interface FetchOfficialAccountConfigDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Bypass the per-issuer in-memory cache. */
  forceRefresh?: boolean
}

const KNOWN_OFFICIAL_PROVIDERS = new Set<string>(OFFICIAL_SOCIAL_PROVIDERS)
const configCache = new Map<string, OfficialAccountRuntimeConfig>()

export function accountConfigUrl(issuer: string): string {
  return new URL("/api/account/config", issuer).href
}

export function resetOfficialAccountConfigCache(): void {
  configCache.clear()
}

function parseRuntimeConfig(body: unknown): OfficialAccountRuntimeConfig | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.providers)) return null
  const providers: OfficialSocialProvider[] = []
  for (const item of record.providers) {
    if (typeof item === "string" && KNOWN_OFFICIAL_PROVIDERS.has(item)) {
      const provider = item as OfficialSocialProvider
      if (!providers.includes(provider)) providers.push(provider)
    }
  }
  const rawDays = record.coolingOffDays
  const coolingOffDays =
    typeof rawDays === "number" && Number.isFinite(rawDays) && rawDays >= 1
      ? Math.trunc(rawDays)
      : 7
  return { providers, coolingOffDays }
}

/**
 * Fetch live provider availability and cooling-off policy for an official
 * deployment. Returns `null` when unreachable or unsupported so the UI keeps
 * its static fallback rather than blocking sign-in.
 */
export async function fetchOfficialAccountConfig(
  deployment: Pick<OfficialDeployment, "issuer">,
  deps: FetchOfficialAccountConfigDeps = {}
): Promise<OfficialAccountRuntimeConfig | null> {
  if (!deps.forceRefresh) {
    const cached = configCache.get(deployment.issuer)
    if (cached) return cached
  }
  const fetchImpl = deps.fetchImpl ?? (createPlatformFetch() as unknown as typeof fetch)
  try {
    const response = await fetchImpl(accountConfigUrl(deployment.issuer), {
      method: "GET",
      headers: { accept: "application/json" },
      ...(deps.signal ? { signal: deps.signal } : {}),
    })
    if (!response.ok) return null
    const parsed = parseRuntimeConfig(await response.json().catch(() => null))
    if (parsed) configCache.set(deployment.issuer, parsed)
    return parsed
  } catch {
    return null
  }
}
