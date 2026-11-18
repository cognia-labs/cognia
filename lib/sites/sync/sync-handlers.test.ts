/**
 * @jest-environment jsdom
 */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  deleteSiteProjectMetadata,
  listActiveSiteDeployments,
  listSiteOperations,
  listSiteProjects,
  listSiteResources,
  listSiteVersions,
  setSiteProviderTokenState,
} from "@/lib/db/sites"
import { serveModuleSyncTable } from "@/lib/sync/module-handlers"
import type { SyncDelta } from "@/lib/sync/types"
import type { Transport } from "@/lib/tauri/transport-types"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

import {
  SITE_MIRROR_TABLES,
  projectSiteOperation,
  siteProjectCursor,
  siteVersionCursor,
  syncHandlers,
  type SiteMirrorTable,
} from "./sync-handlers"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function site(over: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/workspace",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "account_1", workerName: "cognia-docs" },
    authoringPolicy: { ownerAccountId: "owner_1", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}

function version(over: Partial<SiteVersionRow> = {}): SiteVersionRow {
  return {
    id: "version_1",
    siteId: "site_1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: {
      commitSha: "abc123",
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
      routes: ["docs.example.com/api/*"],
      bindings: [],
      toolchain: { runtime: "v24.1.0", packageManager: "10.4.1" },
    },
    artifactDigest: "c".repeat(64),
    artifactSize: 2048,
    artifactFileCount: 12,
    createdAt: 110,
    completedAt: 130,
    ...over,
  }
}

function environment(): SiteEnvironmentRevisionRow {
  return {
    id: "env_1",
    siteId: "site_1",
    sequence: 1,
    variables: { API_ORIGIN: "https://api.example.com" },
    secretRefs: [{ key: "API_TOKEN", credentialId: "site_1:env_1:API_TOKEN", revision: "rev_1" }],
    createdAt: 105,
  }
}

function deployment(over: Partial<SiteDeploymentRow> = {}): SiteDeploymentRow {
  return {
    id: "deployment_1",
    siteId: "site_1",
    versionId: "version_1",
    environmentRevisionId: "env_1",
    status: "active",
    providerDeploymentId: "cf_deployment_1",
    productionUrl: "https://docs.example.workers.dev",
    entryVerification: {
      checkedAt: 160,
      state: "protected",
      entries: [{ url: "https://docs.example.workers.dev", outcome: "protected", status: 302 }],
    },
    createdAt: 140,
    updatedAt: 160,
    ...over,
  }
}

function operation(over: Partial<SiteOperationRow> = {}): SiteOperationRow {
  return {
    id: "op_1",
    siteId: "site_1",
    type: "deploy",
    executionTargetKey: "local",
    idempotencyKey: "deploy:site_1:version_1",
    inputDigest: "e".repeat(64),
    inputPayload: { versionId: "version_1", accountId: "account_1" },
    status: "succeeded",
    attemptCount: 1,
    leaseOwner: "window_main",
    leaseExpiresAt: 1_200,
    createdAt: 140,
    updatedAt: 170,
    completedAt: 170,
    ...over,
  }
}

function event(): SiteOperationEventRow {
  return { id: "op_1:1", operationId: "op_1", sequence: 1, type: "succeeded", createdAt: 170 }
}

function resource(over: Partial<SiteResourceRow> = {}): SiteResourceRow {
  return {
    id: "resource_route",
    siteId: "site_1",
    provider: "cloudflare",
    kind: "worker-route",
    providerResourceId: "route_1",
    displayName: "docs.example.com/api/*",
    metadata: { zoneId: "zone_1", pattern: "docs.example.com/api/*" },
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 150,
    updatedAt: 150,
    ...over,
  }
}

async function seedHost(): Promise<void> {
  const db = getDb()
  await db.siteProjects.put(
    site({
      providerTokenState: { executionTargetKey: "local", status: "verified", verifiedAt: 120 },
    })
  )
  await db.siteEnvironmentRevisions.put(environment())
  await db.siteVersions.put(version())
  await db.siteDeployments.put(deployment())
  await db.siteOperations.put(operation())
  await db.siteOperationEvents.put(event())
  await db.siteResources.put(resource())
}

async function serve(table: SiteMirrorTable, since = 0): Promise<SyncDelta<unknown>> {
  const delta = await serveModuleSyncTable(table, since, { deps: {} })
  if (!delta) throw new Error(`no module serves ${table}`)
  return delta
}

/** A paired client's transport, answering every pull with what the Host served. */
function hostTransport(deltas: Partial<Record<SiteMirrorTable, SyncDelta<unknown>>>): Transport {
  return {
    call: jest.fn(async (_command: string, args?: Record<string, unknown>) => {
      const delta = deltas[args?.table as SiteMirrorTable]
      if (!delta) throw new Error(`unexpected pull of ${String(args?.table)}`)
      return delta
    }) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

async function pullAll(deltas: Partial<Record<SiteMirrorTable, SyncDelta<unknown>>>) {
  const transport = hostTransport(deltas)
  for (const table of SITE_MIRROR_TABLES) {
    const outcome = await syncHandlers[table]!.pull(transport, { since: 0 })
    expect(outcome).toMatchObject({ ok: true })
  }
}

async function serveAll(): Promise<Record<SiteMirrorTable, SyncDelta<unknown>>> {
  const entries = await Promise.all(
    SITE_MIRROR_TABLES.map(async (table) => [table, await serve(table)] as const)
  )
  return Object.fromEntries(entries) as Record<SiteMirrorTable, SyncDelta<unknown>>
}

describe("the sites module's companion sync", () => {
  it("owns exactly the mirrored tables, each with a pull and a Host reader", () => {
    expect(Object.keys(syncHandlers).sort()).toEqual([...SITE_MIRROR_TABLES].sort())
    for (const table of SITE_MIRROR_TABLES) {
      expect(syncHandlers[table]).toEqual({
        pull: expect.any(Function),
        serve: expect.any(Function),
      })
    }
    // Build output and archive bytes are the Host's alone.
    expect(SITE_MIRROR_TABLES).not.toContain("siteBuildLogs")
    expect(SITE_MIRROR_TABLES).not.toContain("siteArtifacts")
  })

  it("lists the Host's Sites with the live deployment on a paired client", async () => {
    await seedHost()
    const deltas = await serveAll()

    // The client's database starts empty and holds only what the Host served.
    await dbFixture.restore()
    expect(await listSiteProjects()).toEqual([])
    await pullAll(deltas)

    const [mirrored] = await listSiteProjects()
    expect(mirrored).toMatchObject({ id: "site_1", name: "Docs", lifecycle: "active" })
    // The Host's token standing crosses; the token never does.
    expect(mirrored!.providerTokenState).toEqual({
      executionTargetKey: "local",
      status: "verified",
      verifiedAt: 120,
    })

    const [live] = await listActiveSiteDeployments()
    expect(live).toMatchObject({
      siteId: "site_1",
      versionId: "version_1",
      status: "active",
      productionUrl: "https://docs.example.workers.dev",
      entryVerification: { state: "protected" },
    })
    // The version in production carries its measured toolchain.
    expect(await listSiteVersions("site_1")).toEqual([
      expect.objectContaining({
        id: "version_1",
        status: "ready",
        build: expect.objectContaining({
          toolchain: { runtime: "v24.1.0", packageManager: "10.4.1" },
        }),
      }),
    ])
    expect(await listSiteResources("site_1")).toEqual([
      expect.objectContaining({ kind: "worker-route", displayName: "docs.example.com/api/*" }),
    ])
    expect(await listSiteOperations("site_1")).toEqual([
      expect.objectContaining({ id: "op_1", type: "deploy", status: "succeeded" }),
    ])
    expect(await getDb().siteOperationEvents.get("op_1:1")).toMatchObject({ type: "succeeded" })
    expect(await getDb().siteEnvironmentRevisions.get("env_1")).toMatchObject({
      variables: { API_ORIGIN: "https://api.example.com" },
    })
  })

  it("sends no reconcile input or lease holder, and no secret value anywhere", async () => {
    await seedHost()
    const deltas = await serveAll()

    const [op] = deltas.siteOperations.rows as Record<string, unknown>[]
    expect(op).not.toHaveProperty("inputPayload")
    expect(op).not.toHaveProperty("leaseOwner")
    expect(op).toMatchObject({ id: "op_1", leaseExpiresAt: 1_200 })

    // An environment revision holds a keyring reference, never the value.
    const wire = JSON.stringify(deltas)
    expect(wire).toContain("site_1:env_1:API_TOKEN")
    expect(wire).not.toMatch(/secretValue|providerToken"|apiToken/)
  })

  it("re-sends a Site when its provider token is checked, which leaves updatedAt alone", async () => {
    await seedHost()
    const first = await serve("siteProjects")
    expect(first.next_since).toBe(120)
    expect((await serve("siteProjects", first.next_since)).rows).toEqual([])

    await setSiteProviderTokenState("site_1", {
      executionTargetKey: "local",
      status: "rejected",
      lastFailureAt: 500,
    })
    expect((await getDb().siteProjects.get("site_1"))!.updatedAt).toBe(100)

    const next = await serve("siteProjects", first.next_since)
    expect(next.rows).toEqual([
      expect.objectContaining({
        providerTokenState: expect.objectContaining({ status: "rejected" }),
      }),
    ])
    expect(next.next_since).toBe(500)
  })

  it("re-sends a version when it completes and when its archive is collected", async () => {
    await getDb().siteProjects.put(site())
    await getDb().siteVersions.put(
      version({ status: "building", completedAt: undefined, artifactDigest: undefined })
    )
    const drafted = await serve("siteVersions")
    expect(drafted.rows).toEqual([expect.objectContaining({ status: "building" })])
    expect(drafted.next_since).toBe(110)

    await getDb().siteVersions.put(version({ completedAt: 300 }))
    const completed = await serve("siteVersions", drafted.next_since)
    expect(completed.rows).toEqual([expect.objectContaining({ status: "ready" })])
    expect(completed.next_since).toBe(300)

    await getDb().siteVersions.put(version({ completedAt: 300, artifactCollectedAt: 900 }))
    const collected = await serve("siteVersions", completed.next_since)
    expect(collected.rows).toEqual([expect.objectContaining({ artifactCollectedAt: 900 })])
  })

  it("carries only the rows that changed since the cursor", async () => {
    await seedHost()
    await getDb().siteOperations.put(
      operation({
        id: "op_2",
        idempotencyKey: "build:site_1:2",
        type: "build",
        updatedAt: 400,
        status: "running",
      })
    )
    await getDb().siteResources.put(resource({ id: "resource_old", updatedAt: 90 }))

    const operations = await serve("siteOperations", 200)
    expect(operations.rows).toEqual([expect.objectContaining({ id: "op_2" })])
    expect(operations.next_since).toBe(400)

    const resources = await serve("siteResources", 100)
    expect(resources.rows).toEqual([expect.objectContaining({ id: "resource_route" })])
  })

  it("tombstones every row of a deleted Site, and the client drops them", async () => {
    await seedHost()
    await pullAll(await serveAll())

    // Deletion needs a finished lifecycle and no live managed resources.
    await getDb().siteProjects.update("site_1", { lifecycle: "deleted", updatedAt: 600 })
    await getDb().siteResources.update("resource_route", { status: "deleted", updatedAt: 600 })
    const before = await serveAll()
    await deleteSiteProjectMetadata("site_1")

    const after = Object.fromEntries(
      await Promise.all(
        SITE_MIRROR_TABLES.map(
          async (table) => [table, await serve(table, before[table].next_since)] as const
        )
      )
    ) as Record<SiteMirrorTable, SyncDelta<unknown>>
    expect(after.siteProjects.deleted_ids).toEqual(["site_1"])
    expect(after.siteVersions.deleted_ids).toEqual(["version_1"])
    expect(after.siteEnvironmentRevisions.deleted_ids).toEqual(["env_1"])
    expect(after.siteDeployments.deleted_ids).toEqual(["deployment_1"])
    expect(after.siteOperations.deleted_ids).toEqual(["op_1"])
    expect(after.siteOperationEvents.deleted_ids).toEqual(["op_1:1"])
    expect(after.siteResources.deleted_ids).toEqual(["resource_route"])

    // The Host's own tables are empty now; replay the deletions onto a client
    // that still holds the mirror.
    await seedHost()
    await pullAll(after)
    expect(await listSiteProjects()).toEqual([])
    expect(await listActiveSiteDeployments()).toEqual([])
    expect(await getDb().siteOperationEvents.count()).toBe(0)
  })
})

describe("cursors and projection", () => {
  it("a Site's cursor is the newest of its own write and its token check", () => {
    expect(siteProjectCursor(site())).toBe(100)
    expect(
      siteProjectCursor(
        site({
          providerTokenState: { executionTargetKey: "local", status: "verified", verifiedAt: 250 },
        })
      )
    ).toBe(250)
    expect(
      siteProjectCursor(
        site({
          updatedAt: 400,
          providerTokenState: {
            executionTargetKey: "local",
            status: "rejected",
            lastFailureAt: 300,
          },
        })
      )
    ).toBe(400)
  })

  it("a version's cursor is the newest of drafted, finished and collected", () => {
    expect(siteVersionCursor(version({ completedAt: undefined }))).toBe(110)
    expect(siteVersionCursor(version())).toBe(130)
    expect(siteVersionCursor(version({ artifactCollectedAt: 700 }))).toBe(700)
  })

  it("an operation keeps everything but its reconcile input and lease holder", () => {
    const { inputPayload: _input, leaseOwner: _owner, ...rest } = operation()
    expect(projectSiteOperation(operation())).toEqual(rest)
  })
})
