/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  claimSiteOperation,
  completeSiteVersion,
  createSiteDeployment,
  createSiteEnvironmentRevision,
  createSiteProject,
  createSiteVersionDraft,
  getSiteDeployment,
  getSiteEnvironmentRevision,
  getSiteOperation,
  getSiteProject,
  getSiteResource,
  getSiteVersion,
  listSiteDeployments,
  listSiteOperations,
  listSiteResources,
  markSiteOperationForReconcile,
  putSiteArtifact,
  queueSiteOperation,
  recordSiteResource,
  setSiteLifecycle,
  updateSiteVisitorPolicy,
} from "@/lib/db/sites"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { SiteEntryOutcome, SiteVersionRow, SiteVisitorPolicy } from "@/types/sites"
import {
  CloudflareSitesError,
  CloudflareSitesTransportError,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerRoute,
  type CloudflareWorkerVersion,
} from "./client"
import { summarizeSiteEntries } from "./entry-probe"
import { CloudflareSitesService } from "./service"
import type {
  CloudflareVersionUploadInput,
  CloudflareVersionUploadResult,
} from "./version-uploader"

class MemoryKeyring implements KeyringStore {
  readonly values = new Map<string, string>()
  async save(key: string, value: string) {
    this.values.set(key, value)
  }
  async load(key: string) {
    return this.values.get(key) ?? null
  }
  async delete(key: string) {
    this.values.delete(key)
  }
}

/* ------------------------------------------------------------------------ */
/* A small stateful Cloudflare: enough of its API for the Sites lifecycle.   */
/* ------------------------------------------------------------------------ */

const WORKER_TAG = "0123456789abcdef0123456789abcdef"
const WORKERS_DEV = "https://docs-worker.example.workers.dev/"

interface Policy {
  id: string
  name: string
  decision: "allow"
  include: unknown[]
}

interface FakeCloudflare {
  worker?: { id: string; subdomain: { enabled: boolean } }
  versions: CloudflareWorkerVersion[]
  deployments: CloudflareWorkerDeployment[]
  domains: Array<{ id: string; hostname: string; service: string; zone_id: string }>
  routes: Map<string, CloudflareWorkerRoute[]>
  apps: Map<string, Record<string, unknown> & { id: string }>
  policies: Map<string, Policy[]>
  d1: Array<{ uuid: string; name: string }>
  r2: Array<{ name: string }>
}

let cf: FakeCloudflare
let providerSeq = 0
const next = (prefix: string) => `${prefix}-${++providerSeq}`

function notFound(): CloudflareSitesError {
  return new CloudflareSitesError({ message: "not found", status: 404, codes: [10007] })
}

function forbidden(): CloudflareSitesError {
  return new CloudflareSitesError({ message: "forbidden", status: 403, codes: [10000] })
}

const client = {
  verifyToken: jest.fn(async () => ({ status: "active" })),
  createD1Database: jest.fn(async (_account: string, input: { name: string }) => {
    const row = { uuid: next("d1"), name: input.name }
    cf.d1.push(row)
    return row
  }),
  listD1Databases: jest.fn(async (): Promise<Array<{ uuid?: string; name?: string }>> => cf.d1),
  deleteD1Database: jest.fn(async (_account: string, id: string) => {
    if (!cf.d1.some((row) => row.uuid === id)) throw notFound()
    cf.d1 = cf.d1.filter((row) => row.uuid !== id)
  }),
  createR2Bucket: jest.fn(async (_account: string, input: { name: string }) => {
    cf.r2.push({ name: input.name })
    return { name: input.name }
  }),
  listR2Buckets: jest.fn(async (): Promise<Array<{ name?: string }>> => cf.r2),
  deleteR2Bucket: jest.fn(async (_account: string, name: string) => {
    if (!cf.r2.some((row) => row.name === name)) throw notFound()
    cf.r2 = cf.r2.filter((row) => row.name !== name)
  }),
  listVersions: jest.fn(async () => cf.versions),
  getWorker: jest.fn(async () => {
    if (!cf.worker) throw notFound()
    return cf.worker
  }),
  createDeployment: jest.fn(
    async (_account: string, _worker: string, input: { versionId: string }) => {
      const deployment = {
        id: next("dep"),
        versions: [{ version_id: input.versionId, percentage: 100 }],
      }
      cf.deployments.unshift(deployment)
      return deployment
    }
  ),
  listDeployments: jest.fn(async () => cf.deployments),
  listDomains: jest.fn(async (): Promise<unknown[]> => cf.domains),
  attachDomain: jest.fn(
    async (_account: string, input: { zoneId: string; hostname: string; workerName: string }) => {
      const domain = {
        id: next("dom"),
        hostname: input.hostname,
        service: input.workerName,
        zone_id: input.zoneId,
      }
      cf.domains.push(domain)
      return domain
    }
  ),
  detachDomain: jest.fn(async (_account: string, id: string) => {
    if (!cf.domains.some((domain) => domain.id === id)) throw notFound()
    cf.domains = cf.domains.filter((domain) => domain.id !== id)
  }),
  setWorkersDev: jest.fn(async (_account: string, _worker: string, enabled: boolean) => {
    if (cf.worker) cf.worker.subdomain.enabled = enabled
  }),
  getWorkersSubdomain: jest.fn(async () => ({ subdomain: "example" })),
  listWorkerRoutes: jest.fn(async (zoneId: string) => cf.routes.get(zoneId) ?? []),
  createWorkerRoute: jest.fn(async (zoneId: string, input: { pattern: string; script: string }) => {
    const route = { id: next("route"), ...input }
    cf.routes.set(zoneId, [...(cf.routes.get(zoneId) ?? []), route])
    return route
  }),
  deleteWorkerRoute: jest.fn(async (zoneId: string, routeId: string) => {
    const routes = cf.routes.get(zoneId) ?? []
    if (!routes.some((route) => route.id === routeId)) throw notFound()
    cf.routes.set(
      zoneId,
      routes.filter((route) => route.id !== routeId)
    )
  }),
  createAccessApplication: jest.fn(async (_account: string, body: Record<string, unknown>) => {
    const app = { ...body, id: next("app") }
    cf.apps.set(app.id, app)
    cf.policies.set(app.id, [])
    return app
  }),
  getAccessApplication: jest.fn(async (_account: string, id: string) => {
    const app = cf.apps.get(id)
    if (!app) throw notFound()
    return app
  }),
  listAccessApplications: jest.fn(async (): Promise<unknown[]> => [...cf.apps.values()]),
  updateAccessApplication: jest.fn(
    async (_account: string, id: string, body: Record<string, unknown>) => {
      cf.apps.set(id, { ...cf.apps.get(id), ...body, id })
    }
  ),
  deleteAccessApplication: jest.fn(async (_account: string, id: string) => {
    if (!cf.apps.has(id)) throw notFound()
    cf.apps.delete(id)
    cf.policies.delete(id)
  }),
  listAccessPolicies: jest.fn(async (_account: string, appId: string): Promise<unknown[]> => [
    ...(cf.policies.get(appId) ?? []),
  ]),
  createAccessPolicy: jest.fn(
    async (_account: string, appId: string, body: Record<string, unknown>) => {
      const policy = { ...(body as Omit<Policy, "id">), id: next("pol") }
      cf.policies.set(appId, [...(cf.policies.get(appId) ?? []), policy])
      return policy
    }
  ),
  updateAccessPolicy: jest.fn(
    async (_account: string, appId: string, policyId: string, body: Record<string, unknown>) => {
      cf.policies.set(
        appId,
        (cf.policies.get(appId) ?? []).map((policy) =>
          policy.id === policyId ? ({ ...body, id: policyId } as Policy) : policy
        )
      )
    }
  ),
  deleteAccessPolicy: jest.fn(async (_account: string, appId: string, policyId: string) => {
    cf.policies.set(
      appId,
      (cf.policies.get(appId) ?? []).filter((policy) => policy.id !== policyId)
    )
  }),
  queryWorkerLogs: jest.fn(async () => ({ events: [] })),
  queryWorkerAnalytics: jest.fn(async () => ({ requests: 10 })),
  deleteWorker: jest.fn(async () => {
    if (!cf.worker) throw notFound()
    cf.worker = undefined
  }),
}

/** `wrangler versions upload`, as the confined uploader reports it. */
const uploadVersion = jest.fn(
  async (input: CloudflareVersionUploadInput): Promise<CloudflareVersionUploadResult> => {
    cf.worker ??= { id: WORKER_TAG, subdomain: { enabled: false } }
    const versionId = next("ver")
    cf.versions.unshift({
      id: versionId,
      annotations: { "workers/tag": input.tag, "workers/triggered_by": "upload" },
    })
    const result: CloudflareVersionUploadResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationSeconds: 1,
      timedOut: false,
      versionId,
      workerTag: cf.worker.id,
    }
    if (input.removedSecrets?.length) {
      cf.versions.unshift({
        id: next("ver"),
        annotations: { "workers/tag": input.tag, "workers/triggered_by": "secret" },
      })
      result.secretRemoval = { exitCode: 0, stderr: "", timedOut: false }
    }
    return result
  }
)

/** What an anonymous visitor gets at each URL; protected unless a test says otherwise. */
let entryOutcomes: Record<string, SiteEntryOutcome>
const probeEntries = jest.fn(
  async (input: { urls: readonly string[]; unprobeable: readonly string[]; now: number }) =>
    summarizeSiteEntries(
      [
        ...input.urls.map((url) => ({
          url,
          outcome: entryOutcomes[url] ?? ("protected" as const),
          status: 302,
        })),
        ...input.unprobeable.map((url) => ({ url, outcome: "unverified" as const })),
      ],
      input.now
    )
)

const writeText = jest.fn(async (_path: string, _contents: string) => undefined)

let keyring: MemoryKeyring
let idSequence = 0
let service: CloudflareSitesService

function serviceFor(actorAccountId = "owner") {
  return new CloudflareSitesService({
    keyring,
    createClient: () => client as never,
    uploadVersion,
    writeText,
    probeEntries,
    now: () => 1_000 + idSequence,
    newId: (prefix) => `${prefix}_${++idSequence}`,
    leaseOwner: "window-1",
    actorAccountId,
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  jest.clearAllMocks()
  cf = {
    versions: [],
    deployments: [],
    domains: [],
    routes: new Map(),
    apps: new Map(),
    policies: new Map(),
    d1: [],
    r2: [],
  }
  providerSeq = 0
  entryOutcomes = {}
  keyring = new MemoryKeyring()
  idSequence = 0
  service = serviceFor()
  await createSiteProject({
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    provider: "cloudflare",
    providerConfig: { accountId: "account-1", workerName: "docs-worker", zoneId: "zone-1" },
    authoringPolicy: {
      ownerAccountId: "owner",
      editorAccountIds: [],
      deployerAccountIds: ["deployer"],
    },
    visitorPolicy: { mode: "private" },
    now: 1,
  })
})

/* -------------------------------------------------------------- helpers */

async function configureToken() {
  await service.saveProviderToken("site_1", "cf-secret-token")
}

async function readyVersion(
  options: {
    id?: string
    sequence?: number
    secrets?: Array<{ key: string; value: string }>
    routes?: string[]
    bindings?: SiteVersionRow["build"]["bindings"]
  } = {}
) {
  const id = options.id ?? "version_1"
  const environment = await service.saveEnvironment({
    siteId: "site_1",
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: (options.secrets ?? [{ key: "API_TOKEN", value: "environment-secret" }]).map(
      (secret) => ({ ...secret, action: "set" as const })
    ),
  })
  await createSiteVersionDraft({
    id,
    siteId: "site_1",
    environmentRevisionId: environment.id,
    source: {
      commitSha: id,
      dirty: false,
      lockfileDigest: "a".repeat(64),
      inputDigest: id,
    },
    build: {
      command: "pnpm build",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: ["nodejs_compat"],
      routes: options.routes ?? [],
      bindings: options.bindings ?? [],
    },
  })
  const digest = (options.sequence ?? 1).toString(16).padStart(64, "c")
  await putSiteArtifact({
    digest,
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "application/zip",
    fileCount: 2,
  })
  await completeSiteVersion({ versionId: id, artifactDigest: digest })
  return environment
}

const PATHS = {
  wranglerBinaryPath: "/opt/cognia/wrangler",
  wranglerVersion: "wrangler 4.98.1",
  stagingRoot: "/tmp/cognia-sites/site-1",
  configPath: "/tmp/cognia-sites/site-1/wrangler.json",
  entryPath: "/tmp/cognia-sites/site-1/worker.js",
}

function upload(versionId = "version_1") {
  return service.uploadVersion("site_1", versionId, PATHS)
}

function applyAccess(policy: SiteVisitorPolicy = { mode: "private" }) {
  return service.reconcileVisitorAccess("site_1", policy)
}

/** Upload, protect, deploy: the first publish of a private Site. */
async function publish(versionId = "version_1") {
  await upload(versionId)
  await applyAccess()
  return service.deployVersion("site_1", versionId)
}

async function queueWaitingOperation(
  id: string,
  type: Parameters<typeof queueSiteOperation>[0]["type"],
  inputPayload: Record<string, unknown>
) {
  await queueSiteOperation({
    id,
    siteId: "site_1",
    type,
    executionTargetKey: "local",
    idempotencyKey: `reconcile:${id}`,
    inputDigest: `digest:${id}`,
    inputPayload,
    now: 2_000 + idSequence++,
  })
  await claimSiteOperation({
    operationId: id,
    leaseOwner: "test-reconcile",
    leaseMs: 1_000,
    now: 3_000,
  })
  await markSiteOperationForReconcile({
    operationId: id,
    leaseOwner: "test-reconcile",
    message: "provider response was uncertain",
    now: 3_001,
  })
}

async function operationsOf(type: string) {
  return (await listSiteOperations("site_1")).filter((operation) => operation.type === type)
}

async function resource(id: string) {
  return getSiteResource(id)
}

const workerRow = "site_1:worker:docs-worker"

/* ------------------------------------------------------- credentials */

it("verifies and stores the provider token only in the host keyring", async () => {
  await configureToken()

  expect(client.verifyToken).toHaveBeenCalledTimes(1)
  expect(keyring.values.get("provider:site_1:cloudflare")).toBe("cf-secret-token")
  expect(JSON.stringify(await getSiteProject("site_1"))).not.toContain("cf-secret-token")
})

/* ------------------------------------------------------- environments */

it("captures immutable environment revisions with secret references, never values", async () => {
  const revision = await service.saveEnvironment({
    siteId: "site_1",
    variables: { PUBLIC_VALUE: "visible" },
    secrets: [{ key: "PRIVATE_VALUE", action: "set", value: "hidden" }],
  })

  expect(revision.variables).toEqual({ PUBLIC_VALUE: "visible" })
  expect(revision.secretRefs[0]).toMatchObject({ key: "PRIVATE_VALUE" })
  expect(revision.secretRefs[0].credentialId).toBe(
    `environment:site_1:${revision.id}:PRIVATE_VALUE`
  )
  expect(keyring.values.get(revision.secretRefs[0].credentialId)).toBe("hidden")
  expect(JSON.stringify(await getSiteEnvironmentRevision(revision.id))).not.toContain("hidden")
  expect((await operationsOf("environment"))[0]?.status).toBe("succeeded")
})

it("carries a kept secret forward instead of dropping it", async () => {
  const first = await service.saveEnvironment({
    siteId: "site_1",
    variables: { API_ORIGIN: "https://api.example.com" },
    secrets: [
      { key: "API_TOKEN", action: "set", value: "token-value" },
      { key: "DB_PASSWORD", action: "set", value: "db-value" },
    ],
  })
  const second = await service.saveEnvironment({
    siteId: "site_1",
    variables: { API_ORIGIN: "https://api2.example.com" },
    secrets: [
      { key: "API_TOKEN", action: "keep" },
      { key: "DB_PASSWORD", action: "keep" },
    ],
  })

  expect(second.secretRefs.map((ref) => ref.key)).toEqual(["API_TOKEN", "DB_PASSWORD"])
  expect(second.secretRefs).toEqual(first.secretRefs)
  for (const reference of second.secretRefs) {
    expect(keyring.values.get(reference.credentialId)).toBeDefined()
  }
})

it("replaces one secret while keeping the others", async () => {
  const first = await service.saveEnvironment({
    siteId: "site_1",
    variables: {},
    secrets: [
      { key: "API_TOKEN", action: "set", value: "old" },
      { key: "DB_PASSWORD", action: "set", value: "db" },
    ],
  })
  const second = await service.saveEnvironment({
    siteId: "site_1",
    variables: {},
    secrets: [
      { key: "API_TOKEN", action: "set", value: "new" },
      { key: "DB_PASSWORD", action: "keep" },
    ],
  })

  const rotated = second.secretRefs.find((ref) => ref.key === "API_TOKEN")!
  const kept = second.secretRefs.find((ref) => ref.key === "DB_PASSWORD")!
  expect(keyring.values.get(rotated.credentialId)).toBe("new")
  expect(kept).toEqual(first.secretRefs.find((ref) => ref.key === "DB_PASSWORD"))
  expect(
    keyring.values.get(first.secretRefs.find((r) => r.key === "API_TOKEN")!.credentialId)
  ).toBe("old")
})

it("removes a secret from the new revision without breaking the old one", async () => {
  const first = await service.saveEnvironment({
    siteId: "site_1",
    variables: {},
    secrets: [{ key: "API_TOKEN", action: "set", value: "value" }],
  })
  const second = await service.saveEnvironment({
    siteId: "site_1",
    variables: {},
    secrets: [{ key: "API_TOKEN", action: "remove" }],
  })
  expect(second.secretRefs).toEqual([])
  expect(keyring.values.get(first.secretRefs[0].credentialId)).toBe("value")
})

it("refuses to keep a secret no previous revision holds", async () => {
  await expect(
    service.saveEnvironment({
      siteId: "site_1",
      variables: {},
      secrets: [{ key: "GHOST", action: "keep" }],
    })
  ).rejects.toThrow(/no stored secret to keep for GHOST/)
})

describe("an interrupted environment save (F06)", () => {
  it("deletes only the credentials minted for the unsaved revision", async () => {
    const previous = await service.saveEnvironment({
      siteId: "site_1",
      variables: {},
      secrets: [{ key: "KEPT", action: "set", value: "kept-value" }],
    })
    const carried = previous.secretRefs[0]
    const minted = "environment:site_1:siteenv_crashed:NEW"
    keyring.values.set(minted, "draft-value")
    await queueSiteOperation({
      id: "operation_environment",
      siteId: "site_1",
      type: "environment",
      executionTargetKey: "local",
      idempotencyKey: "environment:site_1:siteenv_crashed",
      inputDigest: "environment-digest",
      inputPayload: {
        revisionId: "siteenv_crashed",
        secretRefs: [carried, { key: "NEW", credentialId: minted }],
      },
    })

    await expect(service.recoverInterruptedOperations("site_1")).resolves.toBe(1)
    // The previous revision still resolves its secret; recovery used to delete
    // every credential the payload named, including carried ones.
    expect(keyring.values.get(carried.credentialId)).toBe("kept-value")
    expect(keyring.values.has(minted)).toBe(false)
    expect(await getSiteOperation("operation_environment")).toMatchObject({ status: "failed" })
  })

  it("finishes the operation, deleting nothing, when the revision had committed", async () => {
    await createSiteEnvironmentRevision({
      id: "siteenv_committed",
      siteId: "site_1",
      variables: {},
      secretRefs: [
        { key: "A", credentialId: "environment:site_1:siteenv_committed:A", revision: "r" },
      ],
    })
    keyring.values.set("environment:site_1:siteenv_committed:A", "value")
    await queueSiteOperation({
      id: "operation_environment",
      siteId: "site_1",
      type: "environment",
      executionTargetKey: "local",
      idempotencyKey: "environment:site_1:siteenv_committed",
      inputDigest: "d",
      inputPayload: {
        revisionId: "siteenv_committed",
        secretRefs: [{ key: "A", credentialId: "environment:site_1:siteenv_committed:A" }],
      },
    })

    await service.recoverInterruptedOperations("site_1")
    expect(keyring.values.get("environment:site_1:siteenv_committed:A")).toBe("value")
    expect(await getSiteOperation("operation_environment")).toMatchObject({ status: "succeeded" })
  })
})

/* ---------------------------------------------------------- bindings */

it("provisions managed bindings, records adopted ownership, and replays idempotently", async () => {
  await configureToken()
  const bindings = [
    { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
    { kind: "r2", name: "FILES", resourceName: "docs-files", ownership: "managed" },
    {
      kind: "r2",
      name: "SHARED_FILES",
      resourceName: "shared-files",
      ownership: "adopted",
      providerResourceId: "existing-bucket",
    },
  ] as const

  const first = await service.provisionBindings("site_1", [...bindings])
  const replay = await service.provisionBindings("site_1", [...bindings])

  expect(first.map((row) => row.ownership)).toEqual(["managed", "managed", "adopted"])
  expect(replay.map((row) => row.id)).toEqual(first.map((row) => row.id))
  expect(client.createD1Database).toHaveBeenCalledTimes(1)
  expect(client.createR2Bucket).toHaveBeenCalledTimes(1)
})

describe("what a Site may claim as its own (F11)", () => {
  it("refuses a managed binding that names an existing resource", async () => {
    await configureToken()
    await expect(
      service.provisionBindings("site_1", [
        {
          kind: "d1",
          name: "DB",
          resourceName: "someone-elses-db",
          ownership: "managed",
          providerResourceId: "d1-existing",
        },
      ])
    ).rejects.toThrow("declare an existing resource as adopted or shared")
    expect(await listSiteResources("site_1")).toEqual([])
  })

  it("refuses to create a managed resource under a name the account already uses", async () => {
    await configureToken()
    cf.d1.push({ uuid: "d1-theirs", name: "docs-db" })
    await expect(
      service.provisionBindings("site_1", [
        { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
      ])
    ).rejects.toThrow("already exists in this Cloudflare account")
    expect(client.createD1Database).not.toHaveBeenCalled()
  })

  it("records a Worker that existed before the first upload as adopted, and purge keeps it", async () => {
    await configureToken()
    await readyVersion()
    cf.worker = { id: WORKER_TAG, subdomain: { enabled: true } }
    await upload()
    expect(await resource(workerRow)).toMatchObject({ ownership: "adopted" })

    await service.takeDown("site_1")
    await service.purge("site_1")
    expect(client.deleteWorker).not.toHaveBeenCalled()
    expect(cf.worker).toBeDefined()
  })
})

it("records an uncertain provider mutation for reconciliation", async () => {
  await configureToken()
  client.createD1Database.mockRejectedValueOnce(new TypeError("network interrupted"))

  await expect(
    service.provisionBindings("site_1", [
      { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
    ])
  ).rejects.toThrow("network interrupted")

  const [operation] = await operationsOf("provision")
  expect(operation).toMatchObject({ status: "waiting-reconcile" })

  cf.d1.push({ uuid: "d1-after-timeout", name: "docs-db" })
  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
  expect(await getSiteOperation(operation.id)).toMatchObject({ status: "succeeded" })
  expect(await listSiteResources("site_1")).toEqual([
    expect.objectContaining({
      kind: "d1-database",
      providerResourceId: "d1-after-timeout",
      ownership: "managed",
    }),
  ])
})

/* ------------------------------------------------------------ upload */

describe("upload", () => {
  it("records the version wrangler reported and binds the revision's secrets into it (F01, F10)", async () => {
    await configureToken()
    await readyVersion()

    await expect(upload()).resolves.toBe("ver-1")

    expect(uploadVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: "cognia-version_1",
        wranglerVersion: "wrangler 4.98.1",
        secrets: { API_TOKEN: "environment-secret" },
        removedSecrets: [],
      })
    )
    // The ID came from wrangler's own report; the version list was not needed.
    expect(client.listVersions).not.toHaveBeenCalled()
    const resources = await listSiteResources("site_1")
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workerRow,
          ownership: "managed",
          metadata: expect.objectContaining({ workerTag: WORKER_TAG }),
        }),
        expect.objectContaining({ kind: "worker-version", providerResourceId: "ver-1" }),
        expect.objectContaining({
          kind: "secret",
          providerResourceId: "API_TOKEN",
          status: "active",
        }),
      ])
    )
    expect((await operationsOf("upload"))[0]).toMatchObject({ status: "succeeded" })
  })

  it("finds the version by its tag when wrangler wrote no report", async () => {
    await configureToken()
    await readyVersion()
    uploadVersion.mockImplementationOnce(async (input) => {
      cf.worker ??= { id: WORKER_TAG, subdomain: { enabled: false } }
      cf.versions.unshift({ id: "ver-listed", annotations: { "workers/tag": input.tag } })
      return { exitCode: 0, stdout: "", stderr: "", durationSeconds: 1, timedOut: false }
    })
    await expect(upload()).resolves.toBe("ver-listed")
  })

  it("never writes routes into the version config, and binds only this version's resources (F09, F13)", async () => {
    await configureToken()
    await service.provisionBindings("site_1", [
      { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
    ])
    await readyVersion({ routes: ["docs.example.com/api/*"] })
    // Provisioned after the version was built: the version does not bind it.
    await service.provisionBindings("site_1", [
      { kind: "r2", name: "FILES", resourceName: "docs-files", ownership: "managed" },
    ])
    await upload()

    const config = JSON.parse(writeText.mock.calls[0][1])
    expect(config).not.toHaveProperty("routes")
    expect(config.d1_databases).toEqual([])
    expect(config.r2_buckets).toEqual([])
  })

  it("binds the D1 and R2 resources the version's snapshot names", async () => {
    await configureToken()
    await service.provisionBindings("site_1", [
      { kind: "d1", name: "DB", resourceName: "docs-db", ownership: "managed" },
      {
        kind: "r2",
        name: "FILES",
        resourceName: "shared-files",
        ownership: "shared",
        providerResourceId: "bucket-shared",
      },
    ])
    await readyVersion({
      bindings: [
        { kind: "d1", name: "DB" },
        { kind: "r2", name: "FILES", resourceId: "bucket-shared" },
      ],
    })
    await upload()
    const config = JSON.parse(writeText.mock.calls[0][1])
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "docs-db", database_id: "d1-1" },
    ])
    expect(config.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "bucket-shared" }])
  })

  it("refuses a version whose binding is not provisioned on the Site", async () => {
    await configureToken()
    await readyVersion({ bindings: [{ kind: "d1", name: "DB" }] })
    await expect(upload()).rejects.toThrow("binding DB of this version is not provisioned")
    expect(uploadVersion).not.toHaveBeenCalled()
  })

  it("drops a secret the new revision no longer has and records the secret-change version (F10)", async () => {
    await configureToken()
    await readyVersion()
    await upload()
    await readyVersion({ id: "version_2", sequence: 2, secrets: [] })

    const providerId = await upload("version_2")

    expect(uploadVersion).toHaveBeenLastCalledWith(
      expect.objectContaining({ secrets: {}, removedSecrets: ["API_TOKEN"] })
    )
    // The removal made a further version from the upload; that one carries
    // the right secrets and is the one recorded.
    expect(providerId).toBe(cf.versions[0].id)
    expect(cf.versions[0].annotations?.["workers/triggered_by"]).toBe("secret")
    expect(await resource("site_1:secret:API_TOKEN")).toMatchObject({ status: "deleted" })
  })

  it("fails definitely when wrangler refuses before saving anything", async () => {
    await configureToken()
    await readyVersion()
    uploadVersion.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "Authentication error",
      durationSeconds: 1,
      timedOut: false,
    })
    await expect(upload()).rejects.toThrow("Authentication error")
    expect((await operationsOf("upload"))[0]).toMatchObject({ status: "failed" })
  })

  it("waits for reconciliation when the upload timed out", async () => {
    await configureToken()
    await readyVersion()
    uploadVersion.mockResolvedValueOnce({
      exitCode: -1,
      stdout: "",
      stderr: "",
      durationSeconds: 300,
      timedOut: true,
    })
    await expect(upload()).rejects.toThrow("timed out")
    expect((await operationsOf("upload"))[0]).toMatchObject({ status: "waiting-reconcile" })

    cf.worker = { id: WORKER_TAG, subdomain: { enabled: false } }
    cf.versions.unshift({ id: "ver-late", annotations: { "workers/tag": "cognia-version_1" } })
    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
    expect(
      (await listSiteResources("site_1")).find((row) => row.kind === "worker-version")
    ).toMatchObject({ providerResourceId: "ver-late" })
  })
})

/* -------------------------------------------- visitor access (F03, F04) */

describe("visitor access", () => {
  it("protects the Worker itself, not one hostname, and verifies the result (F03)", async () => {
    await configureToken()
    await readyVersion()
    await upload()

    const site = await applyAccess({ mode: "identities", emails: ["USER@example.com"] })

    expect(site.visitorPolicy).toEqual({ mode: "identities", emails: ["USER@example.com"] })
    expect(client.createAccessApplication).toHaveBeenCalledWith(
      "account-1",
      expect.objectContaining({
        type: "self_hosted",
        destinations: [{ type: "worker", worker_id: WORKER_TAG }],
      })
    )
    expect(client.createAccessApplication.mock.calls[0][1]).not.toHaveProperty("domain")
    expect(client.getAccessApplication).toHaveBeenCalled()
    expect(
      (await listSiteResources("site_1")).filter((row) => row.kind === "access-policy")
    ).toHaveLength(1)
  })

  it("refuses to protect a Worker that does not exist yet", async () => {
    await configureToken()
    await expect(applyAccess()).rejects.toThrow("Upload a version first")
  })

  it("re-applies a policy after it changed in between (F04)", async () => {
    await configureToken()
    await readyVersion()
    await upload()

    await applyAccess({ mode: "private" })
    await applyAccess({ mode: "public" })
    const site = await applyAccess({ mode: "private" })

    // The third application used to match the first's key and return without
    // calling Cloudflare, leaving the Site public.
    expect(client.createAccessApplication).toHaveBeenCalledTimes(2)
    expect(client.deleteAccessApplication).toHaveBeenCalledTimes(1)
    expect(site.visitorPolicy).toEqual({ mode: "private" })
    expect(cf.apps.size).toBe(1)
    expect(await operationsOf("access")).toHaveLength(3)
  })

  it("repairs drift when the same policy is applied again (F04)", async () => {
    await configureToken()
    await readyVersion()
    await upload()
    await applyAccess({ mode: "identities", emails: ["a@example.com"] })
    // Someone edited the policy in the dashboard.
    const [appId] = [...cf.apps.keys()]
    cf.policies.set(appId, [])

    await applyAccess({ mode: "identities", emails: ["a@example.com"] })
    expect(client.createAccessPolicy).toHaveBeenCalledTimes(2)
    expect(cf.policies.get(appId)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------- deploy */

describe("deploy", () => {
  it("refuses a restricted Site whose protection is not in force, before any traffic moves (F03)", async () => {
    await configureToken()
    await readyVersion()
    await upload()

    await expect(service.deployVersion("site_1", "version_1")).rejects.toThrow(
      "Visitor access is not in force"
    )
    expect(client.createDeployment).not.toHaveBeenCalled()
    expect((await operationsOf("deploy"))[0]).toMatchObject({ status: "failed" })
    expect((await listSiteDeployments("site_1"))[0]).toMatchObject({ status: "failed" })
  })

  it("publishes a protected Site, opens workers.dev and records the entry check (F03)", async () => {
    await configureToken()
    await readyVersion()

    const deployed = await publish()

    expect(client.createDeployment).toHaveBeenCalledWith(
      "account-1",
      "docs-worker",
      expect.objectContaining({ versionId: "ver-1" })
    )
    expect(client.setWorkersDev).toHaveBeenCalledWith("account-1", "docs-worker", true)
    expect(probeEntries).toHaveBeenCalledWith(
      expect.objectContaining({ urls: [WORKERS_DEV], unprobeable: [] })
    )
    expect(deployed).toMatchObject({
      status: "active",
      providerDeploymentId: "dep-3",
      productionUrl: "https://docs-worker.example.workers.dev",
      entryVerification: { state: "protected" },
    })
  })

  it("takes the Site down when an entry answers anonymous visitors (F03)", async () => {
    await configureToken()
    await readyVersion()
    entryOutcomes[WORKERS_DEV] = "exposed"

    await expect(publish()).rejects.toThrow("Cloudflare Access did not stop anonymous visitors")

    expect(cf.worker?.subdomain.enabled).toBe(false)
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
    expect((await listSiteDeployments("site_1"))[0]).toMatchObject({
      status: "taken-down",
      entryVerification: { state: "exposed" },
      failureMessage: expect.stringContaining(WORKERS_DEV),
    })
    // Settled, not uncertain: nothing is left for reconciliation.
    expect((await operationsOf("deploy"))[0]).toMatchObject({ status: "failed" })
  })

  it("does not probe a public Site", async () => {
    await configureToken()
    await updateSiteVisitorPolicy("site_1", { mode: "public" })
    await readyVersion()
    await upload()
    const deployed = await service.deployVersion("site_1", "version_1")
    expect(probeEntries).not.toHaveBeenCalled()
    expect(deployed.entryVerification).toBeUndefined()
  })

  it("keeps the provider's receipt when a later step fails, and reconciliation finishes it (A02)", async () => {
    await configureToken()
    await readyVersion({ routes: ["docs.example.com/api/*"] })
    await upload()
    await applyAccess()
    client.createWorkerRoute.mockRejectedValueOnce(forbidden())

    await expect(service.deployVersion("site_1", "version_1")).rejects.toThrow("forbidden")

    // A 403 after Cloudflare accepted the deployment is not "the deploy failed".
    const [operation] = await operationsOf("deploy")
    expect(operation).toMatchObject({ status: "waiting-reconcile" })
    const [pending] = await listSiteDeployments("site_1")
    expect(pending).toMatchObject({
      status: "deploying",
      providerDeploymentId: cf.deployments[0].id,
    })

    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
    expect(client.createDeployment).toHaveBeenCalledTimes(1)
    expect(await getSiteDeployment(pending.id)).toMatchObject({ status: "active" })
    // ...and the route the failed step never attached is attached now.
    expect(cf.routes.get("zone-1")).toEqual([
      expect.objectContaining({ pattern: "docs.example.com/api/*", script: "docs-worker" }),
    ])
  })

  it("treats a request that never got an answer as uncertain (A03)", async () => {
    await configureToken()
    await readyVersion()
    await upload()
    await applyAccess()
    client.createDeployment.mockRejectedValueOnce(
      new CloudflareSitesTransportError("Cloudflare request did not complete: Proxy request failed")
    )

    await expect(service.deployVersion("site_1", "version_1")).rejects.toThrow("did not complete")
    expect((await operationsOf("deploy"))[0]).toMatchObject({ status: "waiting-reconcile" })
  })

  it("redeploys an older version as a pure traffic switch (F10)", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    await readyVersion({ id: "version_2", sequence: 2 })
    await upload("version_2")
    await service.deployVersion("site_1", "version_2")

    await service.deployVersion("site_1", "version_1")
    expect(cf.deployments[0].versions).toEqual([{ version_id: "ver-1", percentage: 100 }])
    // The secrets travel with each version; nothing rewrites them at deploy.
    expect(uploadVersion).toHaveBeenCalledTimes(2)
  })
})

/* ------------------------------------------------------------- routes */

describe("routes (F13)", () => {
  it("attaches the version's routes through the zone and records them as managed", async () => {
    await configureToken()
    await readyVersion({ routes: ["docs.example.com/api/*"] })
    await publish()

    expect(client.createWorkerRoute).toHaveBeenCalledWith("zone-1", {
      pattern: "docs.example.com/api/*",
      script: "docs-worker",
    })
    // A routed Worker does not need workers.dev opened for it.
    expect(client.setWorkersDev).not.toHaveBeenCalled()
    expect(probeEntries).toHaveBeenCalledWith(
      expect.objectContaining({ urls: ["https://docs.example.com/api/"] })
    )
    expect(
      (await listSiteResources("site_1")).find((row) => row.kind === "worker-route")
    ).toMatchObject({
      ownership: "managed",
      status: "active",
      displayName: "docs.example.com/api/*",
    })
  })

  it("refuses a route another Worker already serves, before deploying", async () => {
    await configureToken()
    await readyVersion({ routes: ["docs.example.com/*"] })
    cf.routes.set("zone-1", [{ id: "route-theirs", pattern: "docs.example.com/*", script: "blog" }])
    await upload()
    await applyAccess()

    await expect(service.deployVersion("site_1", "version_1")).rejects.toThrow(
      "already sends traffic to Worker blog"
    )
    expect(client.createDeployment).not.toHaveBeenCalled()
  })

  it("removes a managed route the next version no longer declares", async () => {
    await configureToken()
    await readyVersion({ routes: ["docs.example.com/api/*"] })
    await publish()
    await readyVersion({ id: "version_2", sequence: 2 })
    await upload("version_2")
    await service.deployVersion("site_1", "version_2")

    expect(cf.routes.get("zone-1")).toEqual([])
    expect(
      (await listSiteResources("site_1")).find((row) => row.kind === "worker-route")
    ).toMatchObject({ status: "deleted" })
  })

  it("refuses routes when the Site has no zone", async () => {
    await configureToken()
    await getDb().siteProjects.update("site_1", {
      providerConfig: { accountId: "account-1", workerName: "docs-worker" },
    })
    await readyVersion({ routes: ["docs.example.com/*"] })
    await upload()
    await applyAccess()
    await expect(service.deployVersion("site_1", "version_1")).rejects.toThrow("zone id")
  })
})

/* -------------------------------------------- entry check, takedown, restore */

describe("checking entries again (F03)", () => {
  it("records a later check on the live deployment", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    entryOutcomes[WORKERS_DEV] = "unverified"

    await expect(service.recheckEntries("site_1")).resolves.toMatchObject({ state: "unverified" })
    expect((await listSiteDeployments("site_1"))[0]).toMatchObject({
      status: "active",
      entryVerification: { state: "unverified" },
    })
  })

  it("closes every entry when a dashboard-added domain answers anonymously", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    cf.domains.push({
      id: "dom-dash",
      hostname: "open.example.com",
      service: "docs-worker",
      zone_id: "zone-1",
    })
    entryOutcomes["https://open.example.com/"] = "exposed"

    await expect(service.recheckEntries("site_1")).resolves.toMatchObject({ state: "exposed" })

    expect(cf.domains).toEqual([])
    expect(cf.worker?.subdomain.enabled).toBe(false)
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
    expect(await operationsOf("takedown")).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ])
  })

  it("is only for a restricted, live Site and needs the deploy right", async () => {
    await configureToken()
    await expect(service.recheckEntries("site_1")).rejects.toThrow("no live deployment")
    await expect(serviceFor("stranger").recheckEntries("site_1")).rejects.toThrow("denies deploy")
  })
})

describe("takedown and restore (F05, F13)", () => {
  it("closes every entry, including ones Cognia never recorded, and restores them as they were", async () => {
    await configureToken()
    await readyVersion({ routes: ["docs.example.com/api/*"] })
    await publish()
    const domain = await service.addDomain("site_1", "Docs.Example.com")
    cf.routes.set("zone-1", [
      ...(cf.routes.get("zone-1") ?? []),
      { id: "route-dash", pattern: "docs.example.com/legacy/*", script: "docs-worker" },
    ])
    cf.domains.push({
      id: "dom-dash",
      hostname: "alt.example.com",
      service: "docs-worker",
      zone_id: "zone-1",
    })

    await service.takeDown("site_1")

    expect(cf.domains).toEqual([])
    expect(cf.routes.get("zone-1")).toEqual([])
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
    expect(await resource(domain.id)).toMatchObject({ status: "orphaned" })
    expect(await resource("site_1:custom-domain:dom-dash")).toMatchObject({
      ownership: "adopted",
      status: "orphaned",
    })
    expect((await listSiteDeployments("site_1"))[0]).toMatchObject({ status: "taken-down" })

    await service.restore("site_1")

    expect((await getSiteProject("site_1"))?.lifecycle).toBe("active")
    expect(cf.domains.map((row) => row.hostname).sort()).toEqual([
      "alt.example.com",
      "docs.example.com",
    ])
    expect(
      cf.routes
        .get("zone-1")
        ?.map((route) => route.pattern)
        .sort()
    ).toEqual(["docs.example.com/api/*", "docs.example.com/legacy/*"])
    // The deployment that was serving is live again, not left taken-down.
    expect((await listSiteDeployments("site_1"))[0]).toMatchObject({
      status: "active",
      entryVerification: { state: "protected" },
    })
  })

  it("never opens workers.dev on restore when the Site did not have it", async () => {
    await configureToken()
    await readyVersion({ routes: ["docs.example.com/api/*"] })
    await publish()
    await service.takeDown("site_1")
    await service.restore("site_1")
    expect(client.setWorkersDev).not.toHaveBeenCalledWith("account-1", "docs-worker", true)
  })

  it("runs a second takedown after a restore instead of replaying the first (F05)", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    await service.takeDown("site_1")
    await service.restore("site_1")
    expect(cf.worker?.subdomain.enabled).toBe(true)

    await service.takeDown("site_1")
    expect(cf.worker?.subdomain.enabled).toBe(false)
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
    expect(await operationsOf("takedown")).toHaveLength(2)
  })

  it("refuses to restore a restricted Site whose protection was removed", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    await service.takeDown("site_1")
    cf.apps.clear()

    await expect(service.restore("site_1")).rejects.toThrow("Cannot restore a restricted Site")
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
    expect(cf.worker?.subdomain.enabled).toBe(false)
  })

  it("refuses a second production change while one is unfinished (A01)", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    await queueWaitingOperation("operation_deploy", "build", {})
    await getDb().siteOperations.update("operation_deploy", { type: "deploy" })

    await expect(service.takeDown("site_1")).rejects.toThrow(
      "needs reconciliation before production can change again"
    )
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("active")
  })
})

/* ------------------------------------------------------- domains, misc */

it("serves logs and analytics through parsed views", async () => {
  await configureToken()
  await expect(service.analytics("site_1", "2026-07-01", "2026-07-18")).resolves.toMatchObject({
    unrecognized: true,
    worker: { points: [] },
  })
  await expect(service.logs("site_1", 1, 2, true)).resolves.toMatchObject({
    entries: [],
    unrecognized: false,
  })
})

it("lets a domain add that failed definitely be retried as is (A05)", async () => {
  await configureToken()
  client.attachDomain.mockRejectedValueOnce(forbidden())

  await expect(service.addDomain("site_1", "docs.example.com")).rejects.toThrow("forbidden")
  expect((await operationsOf("domain"))[0]).toMatchObject({ status: "failed" })

  // Same hostname, same key: the closed attempt reopens rather than answering
  // "requires reconciliation: failed".
  await expect(service.addDomain("site_1", "docs.example.com")).resolves.toMatchObject({
    kind: "custom-domain",
    status: "active",
  })
  expect(await operationsOf("domain")).toEqual([expect.objectContaining({ status: "succeeded" })])
})

it("removes a domain that is already gone at the provider (A06)", async () => {
  await configureToken()
  await recordSiteResource({
    id: "domain-gone",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "custom-domain",
    providerResourceId: "dom-already-detached",
    displayName: "old.example.com",
    ownership: "managed",
    dependencies: [],
  })
  await service.removeDomain("site_1", "domain-gone")
  expect(await resource("domain-gone")).toMatchObject({ status: "deleted" })
})

/* ------------------------------------------------------- abandon (A04) */

describe("abandoning an operation (A04)", () => {
  it("is the owner's call", async () => {
    await queueWaitingOperation("operation_deploy", "domain", { hostname: "x" })
    await expect(
      serviceFor("deployer").abandonOperation("site_1", "operation_deploy")
    ).rejects.toThrow("denies manage")
    expect(await getSiteOperation("operation_deploy")).toMatchObject({
      status: "waiting-reconcile",
    })
  })

  it("is refused while the claimant still holds a live lease", async () => {
    await queueSiteOperation({
      id: "operation_running",
      siteId: "site_1",
      type: "domain",
      executionTargetKey: "local",
      idempotencyKey: "domain:running",
      inputDigest: "d",
      now: 1_000,
    })
    await claimSiteOperation({
      operationId: "operation_running",
      leaseOwner: "other-window",
      leaseMs: 60_000,
      now: 1_000,
    })
    await expect(service.abandonOperation("site_1", "operation_running")).rejects.toThrow(
      "still running"
    )
  })

  it("fails the deployment an abandoned deploy was driving", async () => {
    await configureToken()
    const environment = await readyVersion()
    await createSiteDeployment({
      id: "deployment_waiting",
      siteId: "site_1",
      versionId: "version_1",
      environmentRevisionId: environment.id,
    })
    await queueWaitingOperation("operation_deploy", "deploy", {
      deploymentId: "deployment_waiting",
    })

    await expect(service.abandonOperation("site_1", "operation_deploy")).resolves.toMatchObject({
      status: "cancelled",
    })
    expect(await getSiteDeployment("deployment_waiting")).toMatchObject({ status: "failed" })
  })
})

/* ------------------------------------------------------------- purge */

describe("purge", () => {
  it("deletes managed resources dependents first and leaves adopted ones untouched", async () => {
    await configureToken()
    cf.d1.push({ uuid: "managed-db", name: "docs-db" })
    cf.worker = { id: WORKER_TAG, subdomain: { enabled: false } }
    await recordSiteResource({
      id: "d1",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "d1-database",
      providerResourceId: "managed-db",
      ownership: "managed",
      dependencies: [],
    })
    await recordSiteResource({
      id: "worker",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "docs-worker",
      ownership: "managed",
      dependencies: ["d1"],
    })
    await recordSiteResource({
      id: "adopted",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "r2-bucket",
      providerResourceId: "external-bucket",
      ownership: "adopted",
      dependencies: [],
    })
    await setSiteLifecycle("site_1", "taken-down")

    await service.purge("site_1")

    expect(client.deleteWorker.mock.invocationCallOrder[0]).toBeLessThan(
      client.deleteD1Database.mock.invocationCallOrder[0]
    )
    expect(client.deleteR2Bucket).not.toHaveBeenCalled()
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
    expect(await resource("adopted")).toMatchObject({ status: "orphaned", ownership: "adopted" })
  })

  it("lets secrets and versions go with the Worker instead of deleting them one by one (A08)", async () => {
    await configureToken()
    await readyVersion()
    await publish()
    await service.takeDown("site_1")

    await service.purge("site_1")

    expect(client.deleteWorker).toHaveBeenCalledTimes(1)
    const rows = await listSiteResources("site_1")
    for (const kind of ["worker-version", "secret"] as const) {
      expect(rows.filter((row) => row.kind === kind).every((row) => row.status === "deleted")).toBe(
        true
      )
    }
    expect(cf.worker).toBeUndefined()
    expect(cf.apps.size).toBe(0)
  })

  it("finishes when a delete finds its target already gone (A06)", async () => {
    await configureToken()
    await recordSiteResource({
      id: "worker",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "docs-worker",
      ownership: "managed",
      dependencies: [],
    })
    await setSiteLifecycle("site_1", "taken-down")

    await expect(service.purge("site_1")).resolves.toBeUndefined()
    expect(await resource("worker")).toMatchObject({ status: "deleted" })
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
  })

  it("rolls a definite purge failure back for a fresh retry", async () => {
    await configureToken()
    cf.worker = { id: WORKER_TAG, subdomain: { enabled: false } }
    await recordSiteResource({
      id: "worker-retry",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "docs-worker",
      ownership: "managed",
      dependencies: [],
    })
    await setSiteLifecycle("site_1", "taken-down")
    client.deleteWorker.mockRejectedValueOnce(forbidden())

    await expect(service.purge("site_1")).rejects.toThrow("forbidden")
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")

    await expect(service.purge("site_1")).resolves.toBeUndefined()
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
  })

  it("recovers a purge the host stopped in the middle of (F07)", async () => {
    await configureToken()
    cf.worker = { id: WORKER_TAG, subdomain: { enabled: false } }
    await recordSiteResource({
      id: "worker",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "docs-worker",
      ownership: "managed",
      dependencies: [],
    })
    await setSiteLifecycle("site_1", "taken-down")
    await queueSiteOperation({
      id: "operation_purge",
      siteId: "site_1",
      type: "purge",
      executionTargetKey: "local",
      idempotencyKey: "purge:site_1:0",
      inputDigest: "d",
      inputPayload: { siteId: "site_1", attempt: 0 },
    })
    await claimSiteOperation({
      operationId: "operation_purge",
      leaseOwner: "dead-window",
      leaseMs: 1,
      now: 0,
    })
    await setSiteLifecycle("site_1", "deleting")

    // Recovery used to refuse a `deleting` Site outright.
    await expect(service.recoverInterruptedOperations("site_1")).resolves.toBe(1)
    expect(await getSiteOperation("operation_purge")).toMatchObject({ status: "waiting-reconcile" })
    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("deleted")
    expect(cf.worker).toBeUndefined()
  })
})

/* -------------------------------------------------------- reconcile */

describe("reconciling a deploy (F02, F08)", () => {
  async function waitingDeploy(providerDeploymentId?: string) {
    await configureToken()
    await updateSiteVisitorPolicy("site_1", { mode: "public" })
    const environment = await readyVersion()
    cf.worker = { id: WORKER_TAG, subdomain: { enabled: true } }
    await createSiteDeployment({
      id: "deployment_reconcile",
      siteId: "site_1",
      versionId: "version_1",
      environmentRevisionId: environment.id,
    })
    if (providerDeploymentId) {
      await getDb().siteDeployments.update("deployment_reconcile", {
        status: "deploying",
        providerDeploymentId,
      })
    }
    await queueWaitingOperation("operation_deploy", "deploy", {
      deploymentId: "deployment_reconcile",
      providerVersionId: "ver-ours",
    })
  }

  it("marks it live only when the provider's current deployment is serving it", async () => {
    await waitingDeploy()
    cf.deployments = [
      { id: "dep-current", versions: [{ version_id: "ver-ours", percentage: 100 }] },
    ]

    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
    expect(client.createDeployment).not.toHaveBeenCalled()
    expect(await getSiteDeployment("deployment_reconcile")).toMatchObject({
      status: "active",
      providerDeploymentId: "dep-current",
    })
  })

  it("never calls a historical deployment that once had the version live", async () => {
    await waitingDeploy()
    cf.deployments = [
      { id: "dep-newer", versions: [{ version_id: "ver-other", percentage: 100 }] },
      { id: "dep-old", versions: [{ version_id: "ver-ours", percentage: 100 }] },
    ]
    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 0, remaining: 1 })
    expect(await getSiteDeployment("deployment_reconcile")).toMatchObject({ status: "pending" })
  })

  it("does not call a split rollout ours", async () => {
    await waitingDeploy()
    cf.deployments = [
      {
        id: "dep-split",
        versions: [
          { version_id: "ver-ours", percentage: 10 },
          { version_id: "ver-other", percentage: 90 },
        ],
      },
    ]
    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 0, remaining: 1 })
  })

  it("uses the receipt when there is one, and settles a deployment a later one replaced", async () => {
    await waitingDeploy("dep-ours")
    cf.deployments = [
      { id: "dep-later", versions: [{ version_id: "ver-ours", percentage: 100 }] },
      { id: "dep-ours", versions: [{ version_id: "ver-ours", percentage: 100 }] },
    ]
    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
    expect(await getSiteDeployment("deployment_reconcile")).toMatchObject({
      status: "failed",
      failureMessage: expect.stringContaining("A later deployment replaced"),
    })
  })

  it("ends failed, not succeeded, when the entry check finds a restricted Site exposed", async () => {
    await waitingDeploy()
    await updateSiteVisitorPolicy("site_1", { mode: "private" })
    cf.deployments = [
      { id: "dep-current", versions: [{ version_id: "ver-ours", percentage: 100 }] },
    ]
    entryOutcomes[WORKERS_DEV] = "exposed"

    await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
    expect(await getSiteOperation("operation_deploy")).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("Cloudflare Access did not stop"),
    })
    expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
  })
})

it("reconciles an uncertain domain add, a domain removal and visitor access", async () => {
  await configureToken()
  await updateSiteVisitorPolicy("site_1", { mode: "public" })
  cf.domains.push({
    id: "provider-domain",
    hostname: "docs.example.com",
    service: "docs-worker",
    zone_id: "zone-1",
  })
  await recordSiteResource({
    id: "domain-remove",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "custom-domain",
    providerResourceId: "provider-domain-old",
    displayName: "old.example.com",
    ownership: "managed",
    dependencies: [],
  })
  await queueWaitingOperation("operation_domain", "domain", {
    hostname: "docs.example.com",
    zoneId: "zone-1",
  })
  await queueWaitingOperation("operation_domain_remove", "domain", { resourceId: "domain-remove" })
  await queueWaitingOperation("operation_access", "access", { policy: { mode: "public" } })

  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 3, remaining: 0 })
  expect(client.attachDomain).not.toHaveBeenCalled()
  expect(await resource("site_1:custom-domain:provider-domain")).toMatchObject({ status: "active" })
  expect(await resource("domain-remove")).toMatchObject({ status: "deleted" })
})

it("reconciles an access create whose response was lost by finding what it protects", async () => {
  await configureToken()
  await readyVersion()
  await upload()
  const app = {
    id: "app-lost",
    name: "Docs — Cognia Sites",
    destinations: [{ type: "worker", worker_id: WORKER_TAG }],
  }
  cf.apps.set(app.id, app)
  cf.policies.set(app.id, [])
  await queueWaitingOperation("operation_access", "access", { policy: { mode: "private" } })

  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
  expect(await resource("site_1:access-application:app-lost")).toMatchObject({ status: "active" })
  await expect(service.visitorAccessGap("site_1")).resolves.toBeUndefined()
})

it("reconciles takedown and restore against the provider", async () => {
  await configureToken()
  await readyVersion()
  await publish()
  await queueWaitingOperation("operation_takedown", "takedown", { siteId: "site_1" })

  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("taken-down")
  expect(cf.worker?.subdomain.enabled).toBe(false)

  await queueWaitingOperation("operation_restore", "restore", { siteId: "site_1" })
  await expect(service.reconcile("site_1")).resolves.toEqual({ resolved: 1, remaining: 0 })
  expect((await getSiteProject("site_1"))?.lifecycle).toBe("active")
  expect((await listSiteDeployments("site_1"))[0]).toMatchObject({ status: "active" })
})

it("recovers interrupted local and provider operations without replaying side effects", async () => {
  await createSiteEnvironmentRevision({
    id: "environment_interrupted",
    siteId: "site_1",
    variables: {},
    secretRefs: [],
  })
  await createSiteVersionDraft({
    id: "version_interrupted",
    siteId: "site_1",
    environmentRevisionId: "environment_interrupted",
    source: {
      commitSha: "abc",
      dirty: false,
      lockfileDigest: "a".repeat(64),
      inputDigest: "b".repeat(64),
    },
    build: {
      command: "pnpm build",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-07-18",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
  })
  await queueSiteOperation({
    id: "operation_build",
    siteId: "site_1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: "build:interrupted",
    inputDigest: "build-digest",
    inputPayload: { versionId: "version_interrupted" },
  })
  await queueSiteOperation({
    id: "operation_provider",
    siteId: "site_1",
    type: "domain",
    executionTargetKey: "local",
    idempotencyKey: "domain:interrupted",
    inputDigest: "domain-digest",
    inputPayload: { hostname: "docs.example.com" },
  })

  await expect(service.recoverInterruptedOperations("site_1")).resolves.toBe(2)
  expect(await getSiteVersion("version_interrupted")).toMatchObject({ status: "failed" })
  expect(await getSiteOperation("operation_build")).toMatchObject({ status: "failed" })
  expect(await getSiteOperation("operation_provider")).toMatchObject({
    status: "waiting-reconcile",
  })
  await expect(service.recoverInterruptedOperations("site_1")).resolves.toBe(0)
})

it("rejects invalid provider, environment, binding, domain, and lifecycle inputs", async () => {
  await expect(service.saveProviderToken("site_1", "   ")).rejects.toThrow(
    "Cloudflare provider token is required"
  )
  client.verifyToken.mockResolvedValueOnce({ status: "disabled" })
  await expect(service.saveProviderToken("site_1", "inactive-token")).rejects.toThrow(
    "Cloudflare provider token is not active"
  )
  await expect(
    service.saveEnvironment({
      siteId: "site_1",
      variables: { DUPLICATE: "plain" },
      secrets: [{ key: "DUPLICATE", action: "set", value: "secret" }],
    })
  ).rejects.toThrow("environment key cannot be both plain and secret")
  await expect(
    service.saveEnvironment({ siteId: "site_1", variables: { "not-valid": "x" }, secrets: [] })
  ).rejects.toThrow("environment keys must be JavaScript identifiers")

  await configureToken()
  await expect(
    service.provisionBindings("site_1", [
      { kind: "r2", name: "FILES", resourceName: "shared", ownership: "shared" },
    ])
  ).rejects.toThrow("requires a provider resource id")
  await expect(service.addDomain("site_1", "https://bad.example.com")).rejects.toThrow(
    "custom domain hostname is invalid"
  )
  await expect(service.removeDomain("site_1", "missing-domain")).rejects.toThrow(
    "Site custom domain not found"
  )
  await expect(service.purge("site_1")).rejects.toThrow("Site must be taken down before purge")
})

it("records reconciliation as a durable operation, repeatably", async () => {
  await configureToken()
  await service.reconcile("site_1")
  await service.reconcile("site_1")

  const operations = await operationsOf("reconcile")
  expect(operations).toHaveLength(2)
  expect(operations.every((row) => row.status === "succeeded")).toBe(true)
  expect(new Set(operations.map((row) => row.idempotencyKey)).size).toBe(2)
})
