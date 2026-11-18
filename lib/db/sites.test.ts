import {
  cancelSiteOperation,
  claimNextSiteOperation,
  claimSiteOperation,
  createSiteDeployment,
  completeSiteOperation,
  completeSiteVersion,
  createSiteEnvironmentRevision,
  createSiteProject,
  createSiteVersionDraft,
  deleteSiteProjectMetadata,
  getSiteArtifact,
  getSiteOperation,
  listSiteDeployments,
  listSiteOperationEvents,
  listRecentSiteOperations,
  listSiteProjects,
  listSiteVersionsByIds,
  putSiteArtifact,
  queueSiteOperation,
  recordSiteResource,
  markSiteDeploymentActive,
  markSiteOperationForReconcile,
  failSiteOperation,
  markSiteDeploymentAccepted,
  markSiteDeploymentsTakenDown,
  restoreSiteDeployment,
  setSiteDeploymentEntryVerification,
  setSiteLifecycle,
  sweepSiteArtifacts,
  updateSiteProviderConfig,
} from "./sites"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function siteInput() {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/workspace",
    sourceSubpath: "./apps/docs/",
    executionTarget: { kind: "local" },
    provider: "cloudflare",
    providerConfig: { workerName: "cognia-docs", accountId: "account_1" },
    authoringPolicy: {
      ownerAccountId: "owner_1",
      editorAccountIds: [] as string[],
      deployerAccountIds: [] as string[],
    },
    visitorPolicy: { mode: "private" },
    now: 100,
  } as const
}

async function makeSite() {
  return createSiteProject(siteInput())
}

describe("site project identity", () => {
  it("links to an existing project and normalizes the explicit source subpath", async () => {
    const site = await makeSite()

    expect(site).toMatchObject({
      id: "site_1",
      projectId: "project_1",
      sourceRoot: "/workspace",
      sourceSubpath: "apps/docs",
      executionTargetKey: "local",
      lifecycle: "active",
    })
    expect(await listSiteProjects()).toEqual([site])
  })

  it("rejects an absolute or escaping source subpath", async () => {
    await expect(
      createSiteProject({
        ...siteInput(),
        id: "site_absolute",
        sourceSubpath: "/etc",
      })
    ).rejects.toThrow("relative")

    await expect(
      createSiteProject({
        ...siteInput(),
        id: "site_escape",
        sourceSubpath: "../../etc",
      })
    ).rejects.toThrow("escape")
  })

  it("prevents duplicate Site bindings for the same project, root, subpath, and target", async () => {
    await makeSite()
    await expect(makeSite()).rejects.toThrow("already exists")
  })

  it("refuses a second Site on a Worker another Site already publishes to (F11)", async () => {
    await makeSite()
    // Purge deletes a Site's managed resources, all of which hang off the
    // Worker: two Sites on one Worker meant purging one took the other down.
    await expect(
      createSiteProject({
        ...siteInput(),
        id: "site_2",
        sourceSubpath: "apps/blog",
        providerConfig: { workerName: " Cognia-Docs ", accountId: "account_1" },
      })
    ).rejects.toThrow('Site "Docs" already publishes to this Cloudflare Worker')

    // Another account's Worker of the same name is a different Worker.
    await expect(
      createSiteProject({
        ...siteInput(),
        id: "site_3",
        sourceSubpath: "apps/blog",
        providerConfig: { workerName: "cognia-docs", accountId: "account_2" },
      })
    ).resolves.toMatchObject({ id: "site_3" })
  })

  it("frees the Worker once the Site that used it is deleted", async () => {
    await makeSite()
    await setSiteLifecycle("site_1", "taken-down", 150)
    await setSiteLifecycle("site_1", "deleting", 180)
    await setSiteLifecycle("site_1", "deleted", 200)
    await expect(
      createSiteProject({ ...siteInput(), id: "site_2", sourceSubpath: "apps/blog" })
    ).resolves.toMatchObject({ id: "site_2" })
  })
})

describe("immutable artifacts, environment revisions, and versions", () => {
  it("stores artifact bytes by digest and refuses digest collisions", async () => {
    const first = await putSiteArtifact({
      digest: "a".repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "application/gzip",
      fileCount: 4,
      now: 100,
    })
    const same = await putSiteArtifact({
      digest: "a".repeat(64),
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "application/gzip",
      fileCount: 4,
      now: 200,
    })

    expect(same).toEqual(first)
    expect((await getSiteArtifact(first.digest))?.bytes).toEqual(new Uint8Array([1, 2, 3]))

    await expect(
      putSiteArtifact({
        digest: "a".repeat(64),
        bytes: new Uint8Array([9]),
        mediaType: "application/gzip",
        fileCount: 1,
      })
    ).rejects.toThrow("digest collision")
  })

  it("creates immutable environment revisions containing secret references, never values", async () => {
    await makeSite()
    const revision = await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: { API_ORIGIN: "https://api.example.com" },
      secretRefs: [{ key: "API_TOKEN", credentialId: "site_1:API_TOKEN", revision: "rev_2" }],
      now: 120,
    })

    expect(revision.sequence).toBe(1)
    expect(revision.secretRefs).toEqual([
      { key: "API_TOKEN", credentialId: "site_1:API_TOKEN", revision: "rev_2" },
    ])
    expect(JSON.stringify(revision)).not.toContain("secretValue")
  })

  it("completes a version only when its immutable artifact and environment revision exist", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 110,
    })
    const draft = await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: {
        commitSha: "abc123",
        dirty: false,
        lockfileDigest: "b".repeat(64),
        inputDigest: "c".repeat(64),
      },
      build: {
        command: "pnpm build",
        runtime: "node@24.4.1",
        packageManager: "pnpm@10.13.1",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: ["nodejs_compat"],
        routes: [],
        bindings: [],
      },
      now: 120,
    })
    expect(draft.sequence).toBe(1)
    expect(draft.status).toBe("building")

    await expect(
      completeSiteVersion({
        versionId: "version_1",
        artifactDigest: "d".repeat(64),
        now: 130,
      })
    ).rejects.toThrow("artifact")

    await putSiteArtifact({
      digest: "d".repeat(64),
      bytes: new Uint8Array([4, 5]),
      mediaType: "application/gzip",
      fileCount: 2,
      now: 130,
    })
    const ready = await completeSiteVersion({
      versionId: "version_1",
      artifactDigest: "d".repeat(64),
      now: 140,
    })
    expect(ready).toMatchObject({ status: "ready", completedAt: 140 })
    // Denormalized in the same transaction that already holds the artifact row.
    // Reading it back later to recover these two integers structured-clones the
    // whole archive, which is what the versions tab used to do per version.
    expect(ready.artifactSize).toBe(2)
    expect(ready.artifactFileCount).toBe(2)

    await expect(
      completeSiteVersion({
        versionId: "version_1",
        artifactDigest: "d".repeat(64),
      })
    ).rejects.toThrow("immutable")
  })
})

describe("durable site operations", () => {
  it("deduplicates by idempotency key and claims work with an expiring lease", async () => {
    await makeSite()
    const queued = await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "deploy",
      executionTargetKey: "local",
      idempotencyKey: "deploy:site_1:version_1",
      inputDigest: "e".repeat(64),
      now: 100,
    })
    const duplicate = await queueSiteOperation({
      id: "op_other",
      siteId: "site_1",
      type: "deploy",
      executionTargetKey: "local",
      idempotencyKey: "deploy:site_1:version_1",
      inputDigest: "e".repeat(64),
      now: 101,
    })
    expect(duplicate.id).toBe(queued.id)

    const claimed = await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 200,
      leaseMs: 1_000,
    })
    expect(claimed).toMatchObject({
      id: "op_1",
      status: "running",
      leaseOwner: "window_1",
      leaseExpiresAt: 1_200,
      attemptCount: 1,
    })
    expect(
      await claimNextSiteOperation({
        executionTargetKey: "local",
        leaseOwner: "window_2",
        now: 300,
        leaseMs: 1_000,
      })
    ).toBeUndefined()

    const reclaimed = await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_2",
      now: 1_201,
      leaseMs: 500,
    })
    expect(reclaimed).toMatchObject({ leaseOwner: "window_2", attemptCount: 2 })
  })

  it("appends sequenced events and requires the active lease owner to complete", async () => {
    await makeSite()
    await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "reconcile",
      executionTargetKey: "local",
      idempotencyKey: "reconcile:1",
      inputDigest: "f".repeat(64),
      now: 100,
    })
    await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 110,
      leaseMs: 1_000,
    })

    await expect(
      completeSiteOperation({ operationId: "op_1", leaseOwner: "window_2", now: 120 })
    ).rejects.toThrow("lease")
    await completeSiteOperation({
      operationId: "op_1",
      leaseOwner: "window_1",
      providerRequestId: "cf_request_1",
      now: 130,
    })

    expect(await getSiteOperation("op_1")).toMatchObject({
      status: "succeeded",
      providerRequestId: "cf_request_1",
      completedAt: 130,
    })
    const events = await listSiteOperationEvents("op_1")
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "queued"],
      [2, "claimed"],
      [3, "succeeded"],
    ])
  })

  it("records uncertain provider outcomes for reconciliation and terminal failures separately", async () => {
    await makeSite()
    await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "provision",
      executionTargetKey: "local",
      idempotencyKey: "provision:1",
      inputDigest: "a".repeat(64),
      now: 100,
    })
    await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 110,
      leaseMs: 1_000,
    })
    await markSiteOperationForReconcile({
      operationId: "op_1",
      leaseOwner: "window_1",
      providerRequestId: "cf_uncertain",
      message: "timed out after upload",
      now: 120,
    })
    expect(await getSiteOperation("op_1")).toMatchObject({
      status: "waiting-reconcile",
      providerRequestId: "cf_uncertain",
    })

    await queueSiteOperation({
      id: "op_2",
      siteId: "site_1",
      type: "domain",
      executionTargetKey: "local",
      idempotencyKey: "domain:1",
      inputDigest: "b".repeat(64),
      now: 130,
    })
    await claimNextSiteOperation({
      executionTargetKey: "local",
      leaseOwner: "window_1",
      now: 140,
      leaseMs: 1_000,
    })
    await failSiteOperation({
      operationId: "op_2",
      leaseOwner: "window_1",
      message: "invalid zone",
      now: 150,
    })
    expect(await getSiteOperation("op_2")).toMatchObject({
      status: "failed",
      errorMessage: "invalid zone",
      completedAt: 150,
    })
  })
})

describe("deployments", () => {
  it("deploys only ready versions and supersedes the previous active deployment", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
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
      now: 110,
    })
    await expect(
      createSiteDeployment({
        id: "deployment_1",
        siteId: "site_1",
        versionId: "version_1",
        environmentRevisionId: "env_1",
        now: 120,
      })
    ).rejects.toThrow("ready")
    await putSiteArtifact({
      digest: "c".repeat(64),
      bytes: new Uint8Array([1]),
      mediaType: "application/gzip",
      fileCount: 1,
      now: 120,
    })
    await completeSiteVersion({
      versionId: "version_1",
      artifactDigest: "c".repeat(64),
      now: 130,
    })
    await createSiteDeployment({
      id: "deployment_1",
      siteId: "site_1",
      versionId: "version_1",
      environmentRevisionId: "env_1",
      now: 140,
    })
    await markSiteDeploymentActive({
      deploymentId: "deployment_1",
      providerDeploymentId: "cf_deployment_1",
      productionUrl: "https://docs.example.workers.dev",
      now: 150,
    })
    expect(await listSiteDeployments("site_1")).toEqual([
      expect.objectContaining({ id: "deployment_1", status: "active" }),
    ])
  })
})

describe("provider resource ownership and deletion", () => {
  it("never purges adopted/shared resources and prevents ownership rewriting", async () => {
    await makeSite()
    const managed = await recordSiteResource({
      id: "resource_managed",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "worker_1",
      ownership: "managed",
      dependencies: [],
      now: 100,
    })
    const adopted = await recordSiteResource({
      id: "resource_adopted",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "r2-bucket",
      providerResourceId: "bucket_1",
      ownership: "adopted",
      dependencies: [],
      now: 100,
    })

    expect(managed.ownership).toBe("managed")
    expect(adopted.ownership).toBe("adopted")
    await expect(
      recordSiteResource({ ...managed, ownership: "adopted", now: 200 })
    ).rejects.toThrow("ownership")
  })

  it("distinguishes takedown from metadata deletion and blocks deletion with live resources", async () => {
    await makeSite()
    await setSiteLifecycle("site_1", "taken-down", 200)
    await recordSiteResource({
      id: "resource_1",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker",
      providerResourceId: "worker_1",
      ownership: "managed",
      dependencies: [],
      now: 210,
    })

    await expect(deleteSiteProjectMetadata("site_1")).rejects.toThrow("resources")
  })

  it("allows a definite purge failure to return to the retryable taken-down state", async () => {
    await makeSite()
    await setSiteLifecycle("site_1", "taken-down", 200)
    await setSiteLifecycle("site_1", "deleting", 210)
    await expect(setSiteLifecycle("site_1", "taken-down", 220)).resolves.toMatchObject({
      lifecycle: "taken-down",
    })
  })
})

describe("provider configuration", () => {
  it("sets the zone id that add-domain and zone-scoped analytics require", async () => {
    await makeSite()

    const updated = await updateSiteProviderConfig("site_1", "owner_1", { zoneId: " zone_1 " }, 200)

    expect(updated.providerConfig).toEqual({
      accountId: "account_1",
      workerName: "cognia-docs",
      zoneId: "zone_1",
    })
    expect(updated.updatedAt).toBe(200)
  })

  it("keeps untouched optional fields and clears the ones set to blank", async () => {
    await makeSite()
    await updateSiteProviderConfig("site_1", "owner_1", {
      zoneId: "zone_1",
      accessTeamName: "acme",
    })

    const kept = await updateSiteProviderConfig("site_1", "owner_1", { accessTeamName: "beta" })
    expect(kept.providerConfig.zoneId).toBe("zone_1")
    expect(kept.providerConfig.accessTeamName).toBe("beta")

    const cleared = await updateSiteProviderConfig("site_1", "owner_1", { zoneId: "   " })
    expect(cleared.providerConfig).not.toHaveProperty("zoneId")
    expect(cleared.providerConfig.accessTeamName).toBe("beta")
  })

  it("never lets the provider identity drift away from the recorded resources", async () => {
    await makeSite()

    const updated = await updateSiteProviderConfig("site_1", "owner_1", {
      zoneId: "zone_1",
      // @ts-expect-error accountId and workerName are intentionally not patchable:
      // they identify every row already recorded in `siteResources`.
      accountId: "someone-elses-account",
      workerName: "someone-elses-worker",
    })

    expect(updated.providerConfig.accountId).toBe("account_1")
    expect(updated.providerConfig.workerName).toBe("cognia-docs")
  })

  it("refuses a non-owner and a site that is gone", async () => {
    await makeSite()

    await expect(
      updateSiteProviderConfig("site_1", "editor_1", { zoneId: "zone_1" })
    ).rejects.toThrow(/only the Site owner/)

    await expect(
      updateSiteProviderConfig("missing", "owner_1", { zoneId: "zone_1" })
    ).rejects.toThrow(/active site project not found/)

    await setSiteLifecycle("site_1", "taken-down")
    await setSiteLifecycle("site_1", "deleting")
    await expect(
      updateSiteProviderConfig("site_1", "owner_1", { zoneId: "zone_1" })
    ).rejects.toThrow(/active site project not found/)
  })
})

describe("abandoning an operation", () => {
  async function queuedOperation() {
    await makeSite()
    return queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "deploy",
      executionTargetKey: "local",
      idempotencyKey: "deploy:site_1:v1",
      inputDigest: "digest",
      now: 100,
    })
  }

  it("moves a queued operation to the only terminal state nothing else writes", async () => {
    await queuedOperation()

    const cancelled = await cancelSiteOperation({
      operationId: "op_1",
      message: "gave up",
      now: 200,
    })

    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.errorMessage).toBe("gave up")
    expect(cancelled.completedAt).toBe(200)
    expect(cancelled.leaseOwner).toBeUndefined()
    const events = await listSiteOperationEvents("op_1")
    expect(events.at(-1)).toMatchObject({ type: "cancelled", message: "gave up" })
  })

  it("releases a lease the dead claimant still held once it has expired", async () => {
    await queuedOperation()
    await claimSiteOperation({ operationId: "op_1", leaseOwner: "gone", leaseMs: 1000, now: 110 })

    const cancelled = await cancelSiteOperation({ operationId: "op_1", now: 1_200 })
    expect(cancelled.leaseOwner).toBeUndefined()
    expect(cancelled.leaseExpiresAt).toBeUndefined()
  })

  it("refuses to abandon an operation whose claimant still holds a live lease (A04)", async () => {
    // Clearing a live lease let the in-flight deploy finish anyway: the
    // journal said `cancelled` while the deployment became `active`.
    await queuedOperation()
    await claimSiteOperation({ operationId: "op_1", leaseOwner: "me", leaseMs: 1000, now: 110 })

    await expect(cancelSiteOperation({ operationId: "op_1", now: 500 })).rejects.toThrow(
      "still running"
    )
    expect(await getSiteOperation("op_1")).toMatchObject({ status: "running", leaseOwner: "me" })
  })

  it("refuses to reopen an operation that already finished", async () => {
    await queuedOperation()
    await claimSiteOperation({ operationId: "op_1", leaseOwner: "me", leaseMs: 1000, now: 110 })
    await completeSiteOperation({ operationId: "op_1", leaseOwner: "me", now: 120 })

    await expect(cancelSiteOperation({ operationId: "op_1" })).rejects.toThrow(/terminal state/)
  })

  it("refuses an unknown operation", async () => {
    await makeSite()
    await expect(cancelSiteOperation({ operationId: "missing" })).rejects.toThrow(/not found/)
  })
})

describe("retrying a closed attempt (A05, F04, F05)", () => {
  const operationInput = (id: string, type: "domain" | "deploy" = "domain") => ({
    id,
    siteId: "site_1",
    type,
    executionTargetKey: "local",
    idempotencyKey: `${type}:site_1:docs.example.com`,
    inputDigest: "digest",
    inputPayload: { attempt: id },
  })

  it("reopens a failed attempt under the same key instead of returning the failure", async () => {
    await makeSite()
    await queueSiteOperation({ ...operationInput("op_1"), now: 100 })
    await claimSiteOperation({ operationId: "op_1", leaseOwner: "me", leaseMs: 1000, now: 110 })
    await failSiteOperation({ operationId: "op_1", leaseOwner: "me", message: "403", now: 120 })

    const retried = await queueSiteOperation({ ...operationInput("op_2"), now: 200 })
    expect(retried).toMatchObject({
      id: "op_1",
      status: "queued",
      inputPayload: { attempt: "op_2" },
      errorMessage: undefined,
      completedAt: undefined,
    })
    const events = await listSiteOperationEvents("op_1")
    expect(events.at(-1)).toMatchObject({ type: "queued", message: "Retry requested" })
    // ...and it can be claimed again.
    await expect(
      claimSiteOperation({ operationId: "op_1", leaseOwner: "me", leaseMs: 1000, now: 210 })
    ).resolves.toMatchObject({ status: "running", attemptCount: 2 })
  })

  it("reopens a cancelled attempt too", async () => {
    await makeSite()
    await queueSiteOperation({ ...operationInput("op_1"), now: 100 })
    await cancelSiteOperation({ operationId: "op_1", now: 120 })
    await expect(
      queueSiteOperation({ ...operationInput("op_2"), now: 200 })
    ).resolves.toMatchObject({ id: "op_1", status: "queued" })
  })

  it("still returns a succeeded or in-flight attempt as-is", async () => {
    await makeSite()
    await queueSiteOperation({ ...operationInput("op_1"), now: 100 })
    await expect(
      queueSiteOperation({ ...operationInput("op_2"), now: 101 })
    ).resolves.toMatchObject({ id: "op_1", status: "queued" })
    await claimSiteOperation({ operationId: "op_1", leaseOwner: "me", leaseMs: 1000, now: 110 })
    await completeSiteOperation({ operationId: "op_1", leaseOwner: "me", now: 120 })
    await expect(
      queueSiteOperation({ ...operationInput("op_2"), now: 200 })
    ).resolves.toMatchObject({ id: "op_1", status: "succeeded" })
  })
})

describe("one production change per Site at a time (A01)", () => {
  const production = (id: string, type: "deploy" | "takedown" | "restore" | "purge") => ({
    id,
    siteId: "site_1",
    type,
    executionTargetKey: "local",
    idempotencyKey: `${type}:site_1:${id}`,
    inputDigest: id,
    now: 100,
  })

  it("refuses a second deploy or a takedown while a deploy is unfinished", async () => {
    await makeSite()
    await queueSiteOperation(production("op_a", "deploy"))
    await expect(queueSiteOperation(production("op_b", "deploy"))).rejects.toThrow(
      "a deploy for this Site is still in progress"
    )
    await expect(queueSiteOperation(production("op_c", "takedown"))).rejects.toThrow(
      "still in progress"
    )
  })

  it("names reconciliation when the unfinished one is waiting on it", async () => {
    await makeSite()
    await queueSiteOperation(production("op_a", "deploy"))
    await claimSiteOperation({ operationId: "op_a", leaseOwner: "me", leaseMs: 1000, now: 110 })
    await markSiteOperationForReconcile({
      operationId: "op_a",
      leaseOwner: "me",
      message: "timeout",
      now: 120,
    })
    await expect(queueSiteOperation(production("op_b", "restore"))).rejects.toThrow(
      "needs reconciliation before production can change again"
    )
  })

  it("does not hold back work that never changes production", async () => {
    await makeSite()
    await queueSiteOperation(production("op_a", "deploy"))
    await expect(
      queueSiteOperation({ ...production("op_b", "deploy"), type: "build" as never })
    ).resolves.toMatchObject({ id: "op_b" })
  })

  it("lets the next change through once the first finished", async () => {
    await makeSite()
    await queueSiteOperation(production("op_a", "deploy"))
    await claimSiteOperation({ operationId: "op_a", leaseOwner: "me", leaseMs: 1000, now: 110 })
    await completeSiteOperation({ operationId: "op_a", leaseOwner: "me", now: 120 })
    await expect(queueSiteOperation(production("op_b", "takedown"))).resolves.toMatchObject({
      id: "op_b",
    })
  })
})

describe("deployment receipts and restore (A02, F05, F03)", () => {
  async function readyDeployment(id = "deployment_1") {
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: { commitSha: "abc", dirty: false, lockfileDigest: "a", inputDigest: "b" },
      build: {
        command: "pnpm build",
        runtime: "node@24",
        packageManager: "pnpm@10",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: [],
        routes: [],
        bindings: [],
      },
      now: 110,
    })
    await putSiteArtifact({
      digest: "c".repeat(64),
      bytes: new Uint8Array([1]),
      mediaType: "application/zip",
      fileCount: 1,
      now: 120,
    })
    await completeSiteVersion({ versionId: "version_1", artifactDigest: "c".repeat(64), now: 130 })
    return createSiteDeployment({
      id,
      siteId: "site_1",
      versionId: "version_1",
      environmentRevisionId: "env_1",
      now: 140,
    })
  }

  it("records the provider's deployment id the moment it is accepted", async () => {
    await makeSite()
    await readyDeployment()
    await expect(
      markSiteDeploymentAccepted({
        deploymentId: "deployment_1",
        providerDeploymentId: "cf_dep_1",
        now: 150,
      })
    ).resolves.toMatchObject({ status: "deploying", providerDeploymentId: "cf_dep_1" })
  })

  it("never marks a deployment active on a Site that was taken down meanwhile (A01)", async () => {
    await makeSite()
    await readyDeployment()
    await setSiteLifecycle("site_1", "taken-down", 145)
    await expect(
      markSiteDeploymentActive({
        deploymentId: "deployment_1",
        providerDeploymentId: "cf_dep_1",
        productionUrl: "https://docs.example.com",
        now: 150,
      })
    ).rejects.toThrow("not active")
  })

  it("keeps the entry check on the deployment, and a later check replaces it", async () => {
    await makeSite()
    await readyDeployment()
    const first = {
      checkedAt: 150,
      state: "unverified" as const,
      entries: [{ url: "https://docs.example.com/", outcome: "unverified" as const }],
    }
    await markSiteDeploymentActive({
      deploymentId: "deployment_1",
      providerDeploymentId: "cf_dep_1",
      productionUrl: "https://docs.example.com",
      entryVerification: first,
      now: 150,
    })
    const second = {
      checkedAt: 300,
      state: "protected" as const,
      entries: [{ url: "https://docs.example.com/", outcome: "protected" as const, status: 302 }],
    }
    await expect(
      setSiteDeploymentEntryVerification("deployment_1", second, undefined, 300)
    ).resolves.toMatchObject({ status: "active", entryVerification: second })
  })

  it("brings back the deployment whose receipt is still the provider's current one", async () => {
    await makeSite()
    await readyDeployment()
    await markSiteDeploymentActive({
      deploymentId: "deployment_1",
      providerDeploymentId: "cf_dep_1",
      productionUrl: "https://docs.example.com",
      now: 150,
    })
    await markSiteDeploymentsTakenDown("site_1", 200)

    // Something else was deployed out of band: nothing is marked live.
    await expect(
      restoreSiteDeployment({ siteId: "site_1", providerDeploymentId: "cf_other", now: 300 })
    ).resolves.toBeUndefined()
    await expect(
      restoreSiteDeployment({ siteId: "site_1", providerDeploymentId: "cf_dep_1", now: 300 })
    ).resolves.toMatchObject({ id: "deployment_1", status: "active" })
  })
})

describe("sweepSiteArtifacts (A07)", () => {
  async function storedVersion(id: string, digest: string, sequence: number) {
    await putSiteArtifact({
      digest,
      bytes: new Uint8Array([sequence]),
      mediaType: "application/zip",
      fileCount: 1,
      now: 100,
    })
    await createSiteVersionDraft({
      id,
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: { commitSha: id, dirty: false, lockfileDigest: "a", inputDigest: id },
      build: {
        command: "pnpm build",
        runtime: "node@24",
        packageManager: "pnpm@10",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: [],
        routes: [],
        bindings: [],
      },
      now: 110,
    })
    await completeSiteVersion({ versionId: id, artifactDigest: digest, now: 120 })
  }

  it("deletes archives, their build logs and marks versions in one transaction", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await storedVersion("version_1", "1".repeat(64), 1)
    await storedVersion("version_2", "2".repeat(64), 2)

    const result = await sweepSiteArtifacts((snapshot) => {
      expect(snapshot.digests.sort()).toEqual(["1".repeat(64), "2".repeat(64)])
      expect(snapshot.sites[0].versions.map((row) => row.id).sort()).toEqual([
        "version_1",
        "version_2",
      ])
      return { doomed: ["1".repeat(64)], collectVersionIds: ["version_1"] }
    }, 500)

    expect(result.plan.doomed).toEqual(["1".repeat(64)])
    expect(await getSiteArtifact("1".repeat(64))).toBeUndefined()
    expect(await getSiteArtifact("2".repeat(64))).toBeDefined()
    const versions = await getDb().siteVersions.toArray()
    expect(versions.find((row) => row.id === "version_1")?.artifactCollectedAt).toBe(500)
    expect(versions.find((row) => row.id === "version_2")?.artifactCollectedAt).toBeUndefined()
  })

  it("applies nothing when deciding throws", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await storedVersion("version_1", "1".repeat(64), 1)
    await expect(
      sweepSiteArtifacts(() => {
        throw new Error("boom")
      }, 500)
    ).rejects.toThrow("boom")
    expect(await getSiteArtifact("1".repeat(64))).toBeDefined()
  })
})

describe("deleting a Site's metadata tombstones what a paired client mirrors", () => {
  it("records one tombstone per deleted row, at one watermark, and none for logs", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await putSiteArtifact({
      digest: "d".repeat(64),
      bytes: new Uint8Array([1]),
      mediaType: "application/zip",
      fileCount: 1,
      now: 100,
    })
    await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: { commitSha: "abc", dirty: false, lockfileDigest: "a", inputDigest: "b" },
      build: {
        command: "pnpm build",
        runtime: "node@24",
        packageManager: "pnpm@10",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: [],
        routes: [],
        bindings: [],
      },
      now: 110,
    })
    await completeSiteVersion({ versionId: "version_1", artifactDigest: "d".repeat(64), now: 120 })
    await createSiteDeployment({
      id: "deployment_1",
      siteId: "site_1",
      versionId: "version_1",
      environmentRevisionId: "env_1",
      now: 130,
    })
    await queueSiteOperation({
      id: "op_1",
      siteId: "site_1",
      type: "build",
      executionTargetKey: "local",
      idempotencyKey: "build:site_1:1",
      inputDigest: "e".repeat(64),
      now: 140,
    })
    await getDb().siteOperations.update("op_1", { status: "succeeded" })
    await recordSiteResource({
      id: "resource_1",
      siteId: "site_1",
      provider: "cloudflare",
      kind: "worker-route",
      providerResourceId: "route_1",
      ownership: "adopted",
      dependencies: [],
      now: 150,
    })
    await setSiteLifecycle("site_1", "taken-down", 160)
    await setSiteLifecycle("site_1", "deleting", 170)
    await setSiteLifecycle("site_1", "deleted", 180)

    await deleteSiteProjectMetadata("site_1")

    const tombstones = await getDb().syncTombstones.toArray()
    const byTable = (table: string) =>
      tombstones
        .filter((row) => row.table === table)
        .map((row) => row.id)
        .sort()
    expect(byTable("siteProjects")).toEqual(["site_1"])
    expect(byTable("siteVersions")).toEqual(["version_1"])
    expect(byTable("siteEnvironmentRevisions")).toEqual(["env_1"])
    expect(byTable("siteDeployments")).toEqual(["deployment_1"])
    expect(byTable("siteOperations")).toEqual(["op_1"])
    expect(byTable("siteOperationEvents")).toEqual(["op_1:1"])
    expect(byTable("siteResources")).toEqual(["resource_1"])
    // Build logs and archives never cross, so nothing tombstones them.
    expect(byTable("siteBuildLogs")).toEqual([])
    expect(byTable("siteArtifacts")).toEqual([])
    expect(new Set(tombstones.map((row) => row.deletedAt)).size).toBe(1)
  })

  it("writes no tombstone when the delete is refused", async () => {
    await makeSite()
    await expect(deleteSiteProjectMetadata("site_1")).rejects.toThrow("deletion lifecycle")
    expect(await getDb().syncTombstones.count()).toBe(0)
  })
})

describe("paired overview reads", () => {
  it("lists the newest operations across Sites, newest first, up to the limit", async () => {
    await makeSite()
    for (const [id, now] of [
      ["op_a", 100],
      ["op_b", 300],
      ["op_c", 200],
    ] as const) {
      await queueSiteOperation({
        id,
        siteId: "site_1",
        type: "reconcile",
        executionTargetKey: "local",
        idempotencyKey: `reconcile:${id}`,
        inputDigest: "e".repeat(64),
        now,
      })
      await getDb().siteOperations.update(id, { status: "succeeded" })
    }
    expect((await listRecentSiteOperations(2)).map((row) => row.id)).toEqual(["op_b", "op_c"])
  })

  it("returns the versions that exist among the ids asked for", async () => {
    await makeSite()
    await createSiteEnvironmentRevision({
      id: "env_1",
      siteId: "site_1",
      variables: {},
      secretRefs: [],
      now: 100,
    })
    await createSiteVersionDraft({
      id: "version_1",
      siteId: "site_1",
      environmentRevisionId: "env_1",
      source: { commitSha: "abc", dirty: false, lockfileDigest: "a", inputDigest: "b" },
      build: {
        command: "pnpm build",
        runtime: "node@24",
        packageManager: "pnpm@10",
        compatibilityDate: "2026-07-18",
        compatibilityFlags: [],
        routes: [],
        bindings: [],
      },
      now: 110,
    })
    expect(
      (await listSiteVersionsByIds(["version_1", "version_ghost"])).map((row) => row.id)
    ).toEqual(["version_1"])
    expect(await listSiteVersionsByIds([])).toEqual([])
  })
})
