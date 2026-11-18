import {
  deploySiteVersion,
  publishSiteVersion,
  siteVersionIsUploaded,
  uploadSiteVersion,
  type PublishSiteVersionDeps,
} from "./publish-version"
import type {
  SiteArtifactRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

const READY: SiteVersionRow = {
  id: "v1",
  siteId: "s1",
  sequence: 1,
  status: "ready",
  environmentRevisionId: "env1",
  source: { commitSha: "abc", dirty: false, lockfileDigest: "lock", inputDigest: "digest" },
  build: {
    command: '["build"]',
    runtime: "node@24",
    packageManager: "pnpm@10",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: [],
    routes: [],
    bindings: [],
  },
  artifactDigest: "sha-1",
  createdAt: 1,
}

const ARTIFACT: SiteArtifactRow = {
  digest: "sha-1",
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: "application/zip",
  size: 3,
  fileCount: 2,
  createdAt: 1,
}

function resource(overrides: Partial<SiteResourceRow> = {}): SiteResourceRow {
  return {
    id: "r1",
    siteId: "s1",
    provider: "cloudflare",
    kind: "worker-version",
    providerResourceId: "cf-1",
    displayName: "v1",
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 1,
    ...overrides,
  } as SiteResourceRow
}

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "s1",
    name: "Docs",
    projectId: "p1",
    sourceRoot: "/repo",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "acct", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "acct", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "public" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SiteProjectRow
}

function deps(overrides: Partial<PublishSiteVersionDeps> = {}) {
  const uploadVersion = jest.fn(
    async (
      ..._args: Parameters<ReturnType<PublishSiteVersionDeps["createService"]>["uploadVersion"]>
    ) => "cf-version-1"
  )
  const deployVersion = jest.fn(async () => ({ id: "d1" }))
  const visitorAccessGap = jest.fn(async (): Promise<string | undefined> => undefined)
  const reconcileVisitorAccess = jest.fn(async () => site())
  const base: PublishSiteVersionDeps = {
    ensureWrangler: jest.fn(async () => ({ path: "/bin/wrangler", version: "3", ready: true })),
    getArtifact: jest.fn(async () => ARTIFACT),
    getSite: jest.fn(async () => site()),
    getVersion: jest.fn(async () => READY),
    listResources: jest.fn(async () => []),
    materialize: jest.fn(async () => ({
      entryPath: "/cache/entry.js",
      assetsPath: "/cache/assets",
      fileCount: 2,
    })),
    mkdir: jest.fn(async () => undefined),
    join: jest.fn(async (...parts: string[]) => parts.join("/")),
    cacheRoot: jest.fn(async () => "/cache"),
    createService: jest.fn(() => ({
      uploadVersion,
      deployVersion,
      visitorAccessGap,
      reconcileVisitorAccess,
    })),
    ...overrides,
  } as unknown as PublishSiteVersionDeps
  return { deps: base, uploadVersion, deployVersion, visitorAccessGap, reconcileVisitorAccess }
}

const INPUT = { siteId: "s1", versionId: "v1", actorAccountId: "acct" }

describe("uploadSiteVersion", () => {
  it("stages the artifact under the app cache and hands wrangler five absolute paths", async () => {
    const { deps: d, uploadVersion } = deps()
    await expect(uploadSiteVersion(INPUT, d)).resolves.toBe("cf-version-1")
    expect(d.mkdir).toHaveBeenCalledWith("/cache/cognia-sites/s1/v1", { recursive: true })
    expect(uploadVersion).toHaveBeenCalledWith("s1", "v1", {
      wranglerBinaryPath: "/bin/wrangler",
      wranglerVersion: "3",
      stagingRoot: "/cache/cognia-sites/s1/v1",
      configPath: "/cache/cognia-sites/s1/v1/wrangler.json",
      entryPath: "/cache/entry.js",
      assetsPath: "/cache/assets",
    })
  })

  it("omits assetsPath when the artifact has no assets directory", async () => {
    const { deps: d, uploadVersion } = deps({
      materialize: jest.fn(async () => ({ entryPath: "/cache/entry.js", fileCount: 1 })),
    })
    await uploadSiteVersion(INPUT, d)
    expect(uploadVersion.mock.calls[0]?.[2]).not.toHaveProperty("assetsPath")
  })

  it("refuses before hashing a binary when the version is not ready", async () => {
    const { deps: d } = deps({
      getVersion: jest.fn(async () => ({ ...READY, status: "building" as const })),
    })
    await expect(uploadSiteVersion(INPUT, d)).rejects.toThrow(/ready Site version not found/)
    expect(d.ensureWrangler).not.toHaveBeenCalled()
  })

  it("refuses a version belonging to another site", async () => {
    const { deps: d } = deps({ getVersion: jest.fn(async () => ({ ...READY, siteId: "other" })) })
    await expect(uploadSiteVersion(INPUT, d)).rejects.toThrow(/ready Site version not found/)
  })

  it("names wrangler when it is not resolvable on this host", async () => {
    const { deps: d } = deps({
      ensureWrangler: jest.fn(async () => ({ path: null, version: null, ready: false })),
    })
    await expect(uploadSiteVersion(INPUT, d)).rejects.toThrow(/wrangler binary required/)
  })

  it("names the artifact when its bytes are gone", async () => {
    const { deps: d } = deps({ getArtifact: jest.fn(async () => undefined) })
    await expect(uploadSiteVersion(INPUT, d)).rejects.toThrow(/version artifact required/)
  })

  it("names the artifact when the version never produced one", async () => {
    const { deps: d } = deps({
      getVersion: jest.fn(async () => ({ ...READY, artifactDigest: undefined })),
    })
    await expect(uploadSiteVersion(INPUT, d)).rejects.toThrow(/version artifact required/)
  })
})

describe("siteVersionIsUploaded", () => {
  it("is true only for an active worker-version resource naming this version", async () => {
    await expect(
      siteVersionIsUploaded("s1", "v1", { listResources: jest.fn(async () => [resource()]) })
    ).resolves.toBe(true)
    await expect(
      siteVersionIsUploaded("s1", "v1", {
        listResources: jest.fn(async () => [resource({ status: "deleted" })]),
      })
    ).resolves.toBe(false)
    await expect(
      siteVersionIsUploaded("s1", "v1", {
        listResources: jest.fn(async () => [resource({ displayName: "v2" })]),
      })
    ).resolves.toBe(false)
  })
})

describe("publishSiteVersion", () => {
  it("uploads then deploys when no worker version exists yet", async () => {
    const { deps: d, uploadVersion, deployVersion } = deps()
    await expect(publishSiteVersion(INPUT, d)).resolves.toEqual({ id: "d1" })
    expect(uploadVersion).toHaveBeenCalledTimes(1)
    expect(deployVersion).toHaveBeenCalledWith("s1", "v1")
  })

  it("skips the upload when Cloudflare already accepted this exact version", async () => {
    const {
      deps: d,
      uploadVersion,
      deployVersion,
    } = deps({
      listResources: jest.fn(async () => [resource()]),
    })
    await publishSiteVersion(INPUT, d)
    expect(uploadVersion).not.toHaveBeenCalled()
    expect(deployVersion).toHaveBeenCalledTimes(1)
  })
})

describe("deploySiteVersion (F03)", () => {
  const PRIVATE = site({ visitorPolicy: { mode: "private" } })

  it("applies a restricted Site's own policy before deploying when Access is not in force", async () => {
    const d = deps({ getSite: jest.fn(async () => PRIVATE) })
    d.visitorAccessGap.mockResolvedValueOnce("no Access application covers the Worker")
    await deploySiteVersion(INPUT, d.deps)
    expect(d.reconcileVisitorAccess).toHaveBeenCalledWith("s1", { mode: "private" })
    expect(d.reconcileVisitorAccess.mock.invocationCallOrder[0]).toBeLessThan(
      d.deployVersion.mock.invocationCallOrder[0]
    )
  })

  it("leaves Access alone when it is already in force", async () => {
    const d = deps({ getSite: jest.fn(async () => PRIVATE) })
    await deploySiteVersion(INPUT, d.deps)
    expect(d.reconcileVisitorAccess).not.toHaveBeenCalled()
    expect(d.deployVersion).toHaveBeenCalledWith("s1", "v1")
  })

  it("never applies Access for a deployer who cannot manage the Site; the deploy refuses instead", async () => {
    const d = deps({
      getSite: jest.fn(async () =>
        site({
          visitorPolicy: { mode: "private" },
          authoringPolicy: {
            ownerAccountId: "owner",
            editorAccountIds: [],
            deployerAccountIds: ["acct"],
          },
        })
      ),
    })
    await deploySiteVersion(INPUT, d.deps)
    expect(d.visitorAccessGap).not.toHaveBeenCalled()
    expect(d.reconcileVisitorAccess).not.toHaveBeenCalled()
    expect(d.deployVersion).toHaveBeenCalledTimes(1)
  })

  it("does nothing extra for a public Site", async () => {
    const d = deps()
    await deploySiteVersion(INPUT, d.deps)
    expect(d.visitorAccessGap).not.toHaveBeenCalled()
  })
})
