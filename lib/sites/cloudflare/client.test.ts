import {
  CloudflareSitesClient,
  CloudflareSitesError,
  CloudflareSitesTransportError,
} from "./client"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cf-ray": "ray_1" },
  })
}

function callsOf(fetcher: jest.Mock): Array<[RequestInfo | URL, RequestInit?]> {
  return fetcher.mock.calls as Array<[RequestInfo | URL, RequestInit?]>
}

describe("CloudflareSitesClient", () => {
  it("authenticates requests and unwraps Cloudflare result envelopes", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { status: "active" } })
    )
    const client = new CloudflareSitesClient({ token: "secret", fetcher })

    await expect(client.verifyToken()).resolves.toEqual({ status: "active" })
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      })
    )
  })

  it("returns typed errors without including the credential", async () => {
    const fetcher = jest.fn(async () =>
      response(
        {
          success: false,
          errors: [{ code: 10090, message: "permission denied" }],
          messages: [],
          result: null,
        },
        403
      )
    )
    const client = new CloudflareSitesClient({ token: "never-print-me", fetcher })

    await expect(client.verifyToken()).rejects.toMatchObject<Partial<CloudflareSitesError>>({
      name: "CloudflareSitesError",
      status: 403,
      requestId: "ray_1",
      codes: [10090],
    })
    await expect(client.verifyToken()).rejects.not.toThrow("never-print-me")
  })

  it("creates D1/R2 resources and deploys a previously uploaded version", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { id: "result_1" } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.createD1Database("account_1", { name: "docs-db", jurisdiction: "eu" })
    await client.createR2Bucket("account_1", { name: "docs-bucket", jurisdiction: "eu" })
    await client.createDeployment("account_1", "docs-worker", {
      versionId: "version_1",
      message: "Cognia Site version 4",
    })

    const calls = callsOf(fetcher)
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account_1/d1/database",
      "https://api.cloudflare.com/client/v4/accounts/account_1/r2/buckets",
      "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker/deployments",
    ])
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({
      strategy: "percentage",
      versions: [{ version_id: "version_1", percentage: 100 }],
      annotations: {
        "workers/message": "Cognia Site version 4",
        "workers/triggered_by": "cognia-sites",
      },
    })
  })

  it("fails closed before sending an unreviewed request body containing PII", async () => {
    const fetcher = jest.fn()
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await expect(
      client.createDeployment("account_1", "docs-worker", {
        versionId: "version_1",
        message: "Contact alice@example.com",
      })
    ).rejects.toThrow("outbound PII gate")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("permits explicit access-policy identity payloads and nothing else", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { id: "ok" } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.createAccessPolicy("account_1", "app_1", {
      include: [{ email: { email: "alice@example.com" } }],
    })
    await client.updateAccessPolicy("account_1", "app_1", "pol_1", {
      include: [{ email: { email: "alice@example.com" } }],
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    // Secrets no longer travel through this client (they are bound into the
    // version by wrangler), so no other body may carry an address.
    await expect(
      client.createAccessApplication("account_1", { name: "alice@example.com" })
    ).rejects.toThrow("outbound PII gate")
  })

  it("manages domains and routes, and exposes takedown/delete operations", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: { id: "ok" } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.attachDomain("account_1", {
      zoneId: "zone_1",
      hostname: "docs.example.com",
      workerName: "docs-worker",
    })
    await client.detachDomain("account_1", "domain/id")
    await client.setWorkersDev("account_1", "docs-worker", false)
    await client.createWorkerRoute("zone/1", {
      pattern: "docs.example.com/api/*",
      script: "docs-worker",
    })
    await client.deleteWorkerRoute("zone/1", "route/1")
    await client.deleteWorker("account_1", "docs-worker")

    const calls = callsOf(fetcher)
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://api.cloudflare.com/client/v4/accounts/account_1/workers/domains", "PUT"],
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/domains/domain%2Fid",
        "DELETE",
      ],
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker/subdomain",
        "POST",
      ],
      ["https://api.cloudflare.com/client/v4/zones/zone%2F1/workers/routes", "POST"],
      ["https://api.cloudflare.com/client/v4/zones/zone%2F1/workers/routes/route%2F1", "DELETE"],
      [
        "https://api.cloudflare.com/client/v4/accounts/account_1/workers/scripts/docs-worker",
        "DELETE",
      ],
    ])
    expect(JSON.parse(String(calls[3][1]?.body))).toEqual({
      pattern: "docs.example.com/api/*",
      script: "docs-worker",
    })
  })

  it("reads the version list from result.items (F01)", async () => {
    const items = [
      { id: "ver_2", annotations: { "workers/tag": "cognia-2" } },
      { id: "ver_1", annotations: { "workers/tag": "cognia-1" } },
    ]
    const client = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => response({ success: true, result: { items } })),
    })
    await expect(client.listVersions("acct", "docs")).resolves.toEqual(items)

    const bare = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => response({ success: true, result: items })),
    })
    await expect(bare.listVersions("acct", "docs")).rejects.toThrow(
      "Cloudflare version list response is invalid"
    )
  })

  it("reads the deployment list from result.deployments (F02)", async () => {
    const deployments = [
      { id: "dep_2", versions: [{ version_id: "ver_2", percentage: 100 }] },
      { id: "dep_1", versions: [{ version_id: "ver_1", percentage: 100 }] },
    ]
    const client = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => response({ success: true, result: { deployments } })),
    })
    await expect(client.listDeployments("acct", "docs")).resolves.toEqual(deployments)

    const malformed = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => response({ success: true, result: { items: [] } })),
    })
    await expect(malformed.listDeployments("acct", "docs")).rejects.toThrow(
      "Cloudflare deployment list response is invalid"
    )
  })

  it("reports a request that never got an answer as a transport error, not a provider refusal (A03)", async () => {
    const client = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => {
        throw new Error("native proxy request timed out")
      }),
    })
    const failure = client.createDeployment("acct", "docs", { versionId: "ver_1" })
    await expect(failure).rejects.toBeInstanceOf(CloudflareSitesTransportError)
    await expect(failure).rejects.not.toBeInstanceOf(CloudflareSitesError)
    await expect(failure).rejects.toThrow("Cloudflare request did not complete")
  })

  it("reads the Worker, its Access application and zone routes", async () => {
    const fetcher = jest.fn(async () => response({ success: true, result: { id: "x" } }))
    const client = new CloudflareSitesClient({ token: "token", fetcher })
    await client.getWorker("acct", "docs/w")
    await client.getAccessApplication("acct", "app/1")
    await client.listWorkerRoutes("zone/1")
    expect(callsOf(fetcher).map(([url, init]) => [String(url), init?.method])).toEqual([
      ["https://api.cloudflare.com/client/v4/accounts/acct/workers/workers/docs%2Fw", "GET"],
      ["https://api.cloudflare.com/client/v4/accounts/acct/access/apps/app%2F1", "GET"],
      ["https://api.cloudflare.com/client/v4/zones/zone%2F1/workers/routes", "GET"],
    ])
  })

  it("queries persisted logs and analytics without inventing a staging deployment", async () => {
    const fetcher = jest.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/graphql")
        ? response({ data: { viewer: {} } })
        : response({ success: true, errors: [], messages: [], result: { events: [] } })
    )
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await client.queryWorkerLogs("account_1", {
      workerName: "docs-worker",
      from: 100,
      to: 200,
      errorsOnly: true,
      limit: 50,
    })
    await client.queryWorkerAnalytics("account_1", {
      workerName: "docs-worker",
      from: "2026-07-17T00:00:00Z",
      to: "2026-07-18T00:00:00Z",
      zoneId: "zone_1",
      hostname: "docs.example.com",
    })

    const calls = callsOf(fetcher)
    expect(String(calls[0][0])).toContain("/workers/observability/telemetry/query")
    const logBody = JSON.parse(String(calls[0][1]?.body))
    expect(logBody.view).toBe("events")
    expect(logBody.parameters.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "$metadata.service", value: "docs-worker" }),
        expect.objectContaining({ key: "$metadata.error", operation: "exists" }),
      ])
    )
    expect(calls[1][0]).toBe("https://api.cloudflare.com/client/v4/graphql")
    expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
      variables: { accountTag: "account_1", scriptName: "docs-worker" },
    })
    expect(JSON.parse(String(calls[2][1]?.body))).toMatchObject({
      variables: { zoneTag: "zone_1", hostname: "docs.example.com" },
    })
    expect(String(calls[2][1]?.body)).toContain("pageViews")
  })

  it("covers the complete provider lifecycle surface with encoded resource identifiers", async () => {
    const fetcher = jest.fn(async () =>
      response({ success: true, errors: [], messages: [], result: [{ id: "provider-row" }] })
    )
    const client = new CloudflareSitesClient({
      token: "token",
      fetcher,
      baseUrl: "https://provider.example/",
    })

    await client.listD1Databases("account/id")
    await client.deleteD1Database("account/id", "database/id")
    await client.listR2Buckets("account/id")
    await client.deleteR2Bucket("account/id", "bucket/id", "eu")
    await client.createDeployment("account/id", "worker/id", {
      versionId: "version/id",
      force: true,
    })
    await client.listDomains("account/id")
    await client.getWorkersSubdomain("account/id")
    await client.createAccessApplication("account/id", { name: "Docs" })
    await client.listAccessApplications("account/id")
    await client.updateAccessApplication("account/id", "application/id", { name: "Docs 2" })
    await client.deleteAccessApplication("account/id", "application/id")
    await client.listAccessPolicies("account/id", "application/id")
    await client.createAccessPolicy("account/id", "application/id", { name: "Allow" })
    await client.updateAccessPolicy("account/id", "application/id", "policy/id", {
      name: "Allow 2",
    })
    await client.deleteAccessPolicy("account/id", "application/id", "policy/id")
    await client.queryWorkerLogs("account/id", {
      workerName: "worker/id",
      from: 1,
      to: 2,
      limit: 9_999,
    })

    const urls = callsOf(fetcher).map(([url]) => String(url))
    expect(urls).toContain(
      "https://provider.example/accounts/account%2Fid/d1/database/database%2Fid"
    )
    expect(urls).toContain(
      "https://provider.example/accounts/account%2Fid/workers/scripts/worker%2Fid/deployments?force=true"
    )
    const logsCall = callsOf(fetcher).at(-1)
    expect(JSON.parse(String(logsCall?.[1]?.body))).toMatchObject({ limit: 500 })
  })

  it("normalizes R2 list envelopes and optional jurisdiction headers", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response({ success: true, result: { buckets: [{ name: "one" }] } }))
      .mockResolvedValueOnce(response({ success: true, result: [{ name: "two" }] }))
      .mockResolvedValueOnce(response({ success: true, result: { name: "created" } }))
    const client = new CloudflareSitesClient({ token: "token", fetcher })

    await expect(client.listR2Buckets("account")).resolves.toEqual([{ name: "one" }])
    await expect(client.listR2Buckets("account")).resolves.toEqual([{ name: "two" }])
    await client.createR2Bucket("account", { name: "created" })
    expect(callsOf(fetcher)[2][1]?.headers).not.toHaveProperty("cf-r2-jurisdiction")
  })

  it("fails closed for empty credentials, malformed REST, and GraphQL errors", async () => {
    expect(() => new CloudflareSitesClient({ token: "  " })).toThrow(
      "Cloudflare API token is required"
    )

    const malformed = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => new Response("not-json", { status: 502 })),
    })
    await expect(malformed.verifyToken()).rejects.toMatchObject({
      message: "Cloudflare request failed with HTTP 502",
      status: 502,
      codes: [],
    })

    const graphqlError = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => response({ errors: [{ code: 9109, message: "forbidden" }] })),
    })
    await expect(
      graphqlError.queryWorkerAnalytics("account", {
        workerName: "worker",
        from: "start",
        to: "end",
      })
    ).rejects.toMatchObject({ message: "forbidden", codes: [9109] })

    const malformedGraphql = new CloudflareSitesClient({
      token: "token",
      fetcher: jest.fn(async () => new Response("not-json", { status: 500 })),
    })
    await expect(
      malformedGraphql.queryWorkerAnalytics("account", {
        workerName: "worker",
        from: "start",
        to: "end",
      })
    ).rejects.toMatchObject({ message: "Cloudflare GraphQL request failed with HTTP 500" })
  })
})
