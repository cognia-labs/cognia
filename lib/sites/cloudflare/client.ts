import { createProxyFetch } from "@/lib/network/proxy-fetch"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

const API_BASE = "https://api.cloudflare.com/client/v4"

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type CloudflarePiiPolicy = "reject" | "intentional-access-policy"

interface CloudflareMessage {
  code?: number
  message?: string
}

interface CloudflareEnvelope<T> {
  success?: boolean
  errors?: CloudflareMessage[]
  messages?: CloudflareMessage[]
  result?: T
}

export class CloudflareSitesError extends Error {
  readonly status: number
  readonly requestId?: string
  readonly codes: number[]

  constructor(input: { message: string; status: number; requestId?: string; codes?: number[] }) {
    super(input.message)
    this.name = "CloudflareSitesError"
    this.status = input.status
    this.requestId = input.requestId
    this.codes = input.codes ?? []
  }
}

/**
 * The request left this process and no answer came back.
 *
 * A browser `fetch` rejects with `TypeError` here, but the desktop proxy
 * (`lib/network/proxy-fetch.ts`) rewraps every failure — an IPC timeout, a
 * native response timeout — as a plain `Error("Proxy request failed: …")`.
 * Classifying on `TypeError` therefore read a provider write that may well
 * have landed as a definite failure, and reconciliation never looked at it.
 * Whatever the fetcher throws, the outcome of the call is unknown.
 */
export class CloudflareSitesTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CloudflareSitesTransportError"
  }
}

/** One saved Worker version, as `GET …/scripts/{name}/versions` lists it. */
export interface CloudflareWorkerVersion {
  id: string
  number?: number
  annotations?: Record<string, string | undefined>
  metadata?: { created_on?: string; source?: string }
}

/** One deployment. The first in the list is the one serving traffic. */
export interface CloudflareWorkerDeployment {
  id: string
  created_on?: string
  strategy?: string
  versions: Array<{ version_id: string; percentage: number }>
  annotations?: Record<string, string | undefined>
}

/** The Worker itself (`GET …/workers/workers/{id-or-name}`). */
export interface CloudflareWorker {
  /** Immutable Worker ID; what a Worker-scoped Access destination names. */
  id: string
  name?: string
  subdomain?: { enabled?: boolean; previews_enabled?: boolean; url?: string }
}

export interface CloudflareWorkerRoute {
  id: string
  pattern: string
  script?: string
}

function arrayField<T>(result: unknown, field: string, label: string): T[] {
  const value =
    result && typeof result === "object" ? (result as Record<string, unknown>)[field] : undefined
  if (!Array.isArray(value)) throw new Error(`Cloudflare ${label} response is invalid`)
  return value as T[]
}

export interface CloudflareSitesClientOptions {
  token: string
  fetcher?: Fetcher
  baseUrl?: string
}

export class CloudflareSitesClient {
  private readonly token: string
  private readonly fetcher: Fetcher
  private readonly baseUrl: string

  constructor(options: CloudflareSitesClientOptions) {
    if (!options.token.trim()) throw new Error("Cloudflare API token is required")
    this.token = options.token
    this.fetcher = options.fetcher ?? createProxyFetch()
    this.baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, "")
  }

  private async request<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
      headers?: Record<string, string>
      piiPolicy?: CloudflarePiiPolicy
    } = {}
  ): Promise<T> {
    if (
      options.body !== undefined &&
      (options.piiPolicy ?? "reject") === "reject" &&
      !hasNoLeakingPiiDeep(options.body)
    ) {
      throw new Error("Cloudflare request body failed the outbound PII gate")
    }
    const response = await this.send(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    let envelope: CloudflareEnvelope<T> | undefined
    try {
      const text = await response.text()
      envelope = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : undefined
    } catch {
      envelope = undefined
    }
    if (!response.ok || envelope?.success === false) {
      const errors = envelope?.errors ?? []
      const detail = errors
        .map((error) => error.message)
        .filter(Boolean)
        .join("; ")
      throw new CloudflareSitesError({
        message: detail || `Cloudflare request failed with HTTP ${response.status}`,
        status: response.status,
        requestId: response.headers.get("cf-ray") ?? undefined,
        codes: errors.flatMap((error) => (typeof error.code === "number" ? [error.code] : [])),
      })
    }
    return envelope?.result as T
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, init)
    } catch (error) {
      throw new CloudflareSitesTransportError(
        `Cloudflare request did not complete: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!hasNoLeakingPiiDeep(variables)) {
      throw new Error("Cloudflare GraphQL variables failed the outbound PII gate")
    }
    const response = await this.send(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    })
    let payload: { data?: T; errors?: CloudflareMessage[] } | undefined
    try {
      payload = (await response.json()) as { data?: T; errors?: CloudflareMessage[] }
    } catch {
      payload = undefined
    }
    if (!response.ok || !payload?.data || (payload.errors?.length ?? 0) > 0) {
      const errors = payload?.errors ?? []
      throw new CloudflareSitesError({
        message:
          errors
            .map((error) => error.message)
            .filter(Boolean)
            .join("; ") || `Cloudflare GraphQL request failed with HTTP ${response.status}`,
        status: response.status,
        requestId: response.headers.get("cf-ray") ?? undefined,
        codes: errors.flatMap((error) => (typeof error.code === "number" ? [error.code] : [])),
      })
    }
    return payload.data
  }

  verifyToken(): Promise<{ status: string; id?: string; expires_on?: string }> {
    return this.request("/user/tokens/verify")
  }

  createD1Database(
    accountId: string,
    input: { name: string; jurisdiction?: "eu" | "fedramp"; location_hint?: string }
  ): Promise<{ uuid?: string; name?: string }> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/d1/database`, {
      method: "POST",
      body: input,
    })
  }

  listD1Databases(accountId: string): Promise<Array<{ uuid?: string; name?: string }>> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/d1/database`)
  }

  deleteD1Database(accountId: string, databaseId: string): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`,
      { method: "DELETE" }
    )
  }

  createR2Bucket(
    accountId: string,
    input: {
      name: string
      jurisdiction?: "default" | "eu" | "fedramp"
      locationHint?: "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc"
      storageClass?: "Standard" | "InfrequentAccess"
    }
  ): Promise<{ name?: string }> {
    const { jurisdiction, ...body } = input
    return this.request(`/accounts/${encodeURIComponent(accountId)}/r2/buckets`, {
      method: "POST",
      body,
      headers: jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : undefined,
    })
  }

  async listR2Buckets(accountId: string): Promise<Array<{ name?: string }>> {
    const result = await this.request<
      Array<{ name?: string }> | { buckets?: Array<{ name?: string }> }
    >(`/accounts/${encodeURIComponent(accountId)}/r2/buckets`)
    return Array.isArray(result) ? result : (result.buckets ?? [])
  }

  deleteR2Bucket(
    accountId: string,
    bucketName: string,
    jurisdiction?: "default" | "eu" | "fedramp"
  ): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`,
      {
        method: "DELETE",
        headers: jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : undefined,
      }
    )
  }

  /**
   * Saved versions, newest first.
   *
   * `result` is `{ items: [...] }`, not an array: iterating it as one threw
   * "is not iterable" right after a successful upload, so every first publish
   * stopped in `waiting-reconcile` and reconciliation failed the same way.
   */
  async listVersions(accountId: string, workerName: string): Promise<CloudflareWorkerVersion[]> {
    const result = await this.request<unknown>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/versions`
    )
    return arrayField<CloudflareWorkerVersion>(result, "items", "version list")
  }

  /** The Worker by name. Throws a 404 `CloudflareSitesError` when it does not exist. */
  getWorker(accountId: string, workerName: string): Promise<CloudflareWorker> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/workers/${encodeURIComponent(workerName)}`
    )
  }

  createDeployment(
    accountId: string,
    workerName: string,
    input: { versionId: string; message?: string; force?: boolean }
  ): Promise<{ id: string; versions?: Array<{ version_id: string; percentage: number }> }> {
    const force = input.force ? "?force=true" : ""
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments${force}`,
      {
        method: "POST",
        body: {
          strategy: "percentage",
          versions: [{ version_id: input.versionId, percentage: 100 }],
          annotations: {
            "workers/message": input.message ?? "Deployed by Cognia Sites",
            "workers/triggered_by": "cognia-sites",
          },
        },
      }
    )
  }

  /**
   * Deployments, newest first. Cloudflare documents the first entry as the one
   * actively serving traffic.
   *
   * `result` is `{ deployments: [...] }`; calling `.find()` on the object made
   * every deploy reconciliation throw and stay pending.
   */
  async listDeployments(
    accountId: string,
    workerName: string
  ): Promise<CloudflareWorkerDeployment[]> {
    const result = await this.request<unknown>(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments`
    )
    return arrayField<CloudflareWorkerDeployment>(result, "deployments", "deployment list")
  }

  listWorkerRoutes(zoneId: string): Promise<CloudflareWorkerRoute[]> {
    return this.request(`/zones/${encodeURIComponent(zoneId)}/workers/routes`)
  }

  createWorkerRoute(
    zoneId: string,
    input: { pattern: string; script: string }
  ): Promise<CloudflareWorkerRoute> {
    return this.request(`/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
      method: "POST",
      body: { pattern: input.pattern, script: input.script },
    })
  }

  deleteWorkerRoute(zoneId: string, routeId: string): Promise<unknown> {
    return this.request(
      `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(routeId)}`,
      { method: "DELETE" }
    )
  }

  listDomains(accountId: string): Promise<unknown[]> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/workers/domains`)
  }

  attachDomain(
    accountId: string,
    input: { zoneId: string; hostname: string; workerName: string }
  ): Promise<{ id: string }> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/workers/domains`, {
      method: "PUT",
      body: {
        environment: "production",
        hostname: input.hostname,
        service: input.workerName,
        zone_id: input.zoneId,
      },
    })
  }

  detachDomain(accountId: string, domainId: string): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`,
      { method: "DELETE" }
    )
  }

  setWorkersDev(accountId: string, workerName: string, enabled: boolean): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      { method: "POST", body: { enabled, previews_enabled: false } }
    )
  }

  getWorkersSubdomain(accountId: string): Promise<{ subdomain: string }> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`)
  }

  createAccessApplication(accountId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/access/apps`, {
      method: "POST",
      body: input,
    })
  }

  getAccessApplication(accountId: string, applicationId: string): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}`
    )
  }

  listAccessApplications(accountId: string): Promise<unknown[]> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/access/apps`)
  }

  updateAccessApplication(
    accountId: string,
    applicationId: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}`,
      { method: "PUT", body: input }
    )
  }

  deleteAccessApplication(accountId: string, applicationId: string): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}`,
      { method: "DELETE" }
    )
  }

  listAccessPolicies(accountId: string, applicationId: string): Promise<unknown[]> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}/policies`
    )
  }

  createAccessPolicy(
    accountId: string,
    applicationId: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}/policies`,
      {
        method: "POST",
        body: input,
        // Access allowlists intentionally contain the identities Cloudflare must enforce.
        piiPolicy: "intentional-access-policy",
      }
    )
  }

  updateAccessPolicy(
    accountId: string,
    applicationId: string,
    policyId: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}/policies/${encodeURIComponent(policyId)}`,
      {
        method: "PUT",
        body: input,
        // Access allowlists intentionally contain the identities Cloudflare must enforce.
        piiPolicy: "intentional-access-policy",
      }
    )
  }

  deleteAccessPolicy(accountId: string, applicationId: string, policyId: string): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(applicationId)}/policies/${encodeURIComponent(policyId)}`,
      { method: "DELETE" }
    )
  }

  queryWorkerLogs(
    accountId: string,
    input: { workerName: string; from: number; to: number; errorsOnly?: boolean; limit?: number }
  ): Promise<unknown> {
    const filters: Array<Record<string, unknown>> = [
      {
        kind: "filter",
        key: "$metadata.service",
        operation: "eq",
        type: "string",
        value: input.workerName,
      },
    ]
    if (input.errorsOnly) {
      filters.push({
        kind: "filter",
        key: "$metadata.error",
        operation: "exists",
        type: "string",
      })
    }
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`,
      {
        method: "POST",
        body: {
          view: "events",
          timeframe: { from: input.from, to: input.to },
          limit: Math.min(Math.max(input.limit ?? 100, 1), 500),
          parameters: {
            datasets: ["cloudflare-workers"],
            filterCombination: "and",
            filters,
          },
        },
      }
    )
  }

  queryWorkerAnalytics(
    accountId: string,
    input: { workerName: string; from: string; to: string; zoneId?: string; hostname?: string }
  ): Promise<unknown> {
    const workerQuery = `query CogniaSitesWorkerAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 10000
            filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd, scriptName: $scriptName }
          ) {
            sum { requests errors subrequests }
            dimensions { date }
          }
        }
      }
    }`
    const zoneQuery = `query CogniaSitesWebAnalytics($zoneTag: string, $datetimeStart: string, $datetimeEnd: string, $hostname: string) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequestsAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd, clientRequestHTTPHost: $hostname }
          ) {
            sum { requests pageViews bytes }
            uniq { uniques }
            dimensions { date }
          }
        }
      }
    }`
    const worker = this.graphql(workerQuery, {
      accountTag: accountId,
      datetimeStart: input.from,
      datetimeEnd: input.to,
      scriptName: input.workerName,
    })
    if (!input.zoneId || !input.hostname) return worker
    return Promise.all([
      worker,
      this.graphql(zoneQuery, {
        zoneTag: input.zoneId,
        datetimeStart: input.from,
        datetimeEnd: input.to,
        hostname: input.hostname,
      }),
    ]).then(([workerMetrics, webMetrics]) => ({ worker: workerMetrics, web: webMetrics }))
  }

  deleteWorker(accountId: string, workerName: string): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
      { method: "DELETE" }
    )
  }
}
