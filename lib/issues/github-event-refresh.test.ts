/** @jest-environment jsdom */
jest.mock("@/lib/integrations/action-runner", () => ({ integrationApiBaseUrl: jest.fn() }))
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import type { IssueSyncBinding, IssueSyncProvider } from "./sync/types"
import { GithubEventIssueRefresher, type GithubEventRefreshDeps } from "./github-event-refresh"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIssue, getIssue } from "@/lib/db/issues"
import { listIssueEvents } from "@/lib/db/issue-events"
import { tombstoneAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import { captureIssueSyncSource, resolveIssueResourceSource } from "./sync/kept-copy-source"
import {
  deleteGithubIssues,
  getGithubIssue,
  upsertGithubIssues,
} from "@/lib/db/github-issue-mirror"
import { toMirrorRow } from "@/lib/github/issues"
import { issueSyncTarget, reconcileBinding, tombstoneIssueSyncRefs } from "./sync/engine"
import { reconcileIssueSyncRegistrations } from "./sync/runtime"
import {
  installExternalSyncRuntime,
  pendingExternalSyncKeys,
  requestExternalSync,
} from "@/lib/external-services/sync/runtime"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
let dispose: () => void
beforeEach(() => {
  dispose = installExternalSyncRuntime()
})
afterEach(() => {
  dispose()
  jest.useRealTimers()
})

function event(over: Partial<IntegrationEventEnvelope> = {}): IntegrationEventEnvelope {
  return {
    schemaVersion: 1,
    id: "d1:issues.closed",
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "acc",
    deliveryId: "d1",
    eventType: "issues.closed",
    resource: { kind: "repository", id: "acme/app" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    receivedAt: "2026-09-01T00:00:01.000Z",
    payload: { issue: { number: 7 } },
    ...over,
  }
}
const imported: IssueSyncBinding = {
  providerId: "github",
  projectId: "ws",
  issueProjectId: "ip2",
  projectKey: "IP",
  resource: { kind: "github-repo", repoFullName: "Acme/App", addedAt: 1, sync: { mode: "import" } },
  key: "Acme/App",
}
function setup(over: Partial<GithubEventRefreshDeps> = {}) {
  const deps: GithubEventRefreshDeps = {
    accountHostId: jest.fn(async () => "github.com"),
    reconcileRegistrations: jest.fn(async () => ({
      mirror: [{ repoFullName: "acme/app", issueProjectId: "ip1" }],
      imported: [],
    })),
    requestSync: jest.fn(),
    pendingKeys: () => [],
    removeFromMirror: jest.fn(deleteGithubIssues),
    departImport: jest.fn(tombstoneIssueSyncRefs),
    onError: jest.fn(),
    ...over,
  }
  return { deps, refresher: new GithubEventIssueRefresher(deps) }
}

it("accepts issue and comment events; rejects other plugins, families and resources", () => {
  expect(GithubEventIssueRefresher.relevant(event())).toBe(true)
  expect(GithubEventIssueRefresher.relevant(event({ eventType: "issue_comment.created" }))).toBe(
    true
  )
  expect(GithubEventIssueRefresher.relevant(event({ pluginId: "other" }))).toBe(false)
  expect(GithubEventIssueRefresher.relevant(event({ eventType: "pull_request.opened" }))).toBe(
    false
  )
  expect(
    GithubEventIssueRefresher.relevant(event({ resource: { kind: "installation", id: "1" } }))
  ).toBe(false)
})

it("requests each matching mirror and import key through the shared runtime", async () => {
  const { deps, refresher } = setup({
    reconcileRegistrations: jest.fn(async () => ({
      mirror: [{ repoFullName: "acme/app", issueProjectId: "ip1" }],
      imported: [imported, { ...imported, key: "acme/other" }],
    })),
  })
  await refresher.handle(event())
  expect(deps.accountHostId).toHaveBeenCalledWith("github-delivery", "acc")
  expect(deps.reconcileRegistrations).toHaveBeenCalledTimes(1)
  expect(deps.requestSync).toHaveBeenCalledTimes(2)
  expect(deps.requestSync).toHaveBeenCalledWith("github-mirror:ip1:acme/app", "push")
  expect(deps.requestSync).toHaveBeenCalledWith("issues:ip2:Acme/App", "push")
})

it("two refresher instances share one runtime debounce for a webhook burst", async () => {
  const request = jest.fn(async () => ({ status: 200, headers: {}, data: [] }))
  const runtimeDeps = {
    mirrorBindings: async () => [{ repoFullName: "acme/app", issueProjectId: "ip1" }],
    importBindings: async () => [],
    mirrorDeps: { resolveOctokit: async () => ({ request }) },
  }
  const deps = {
    reconcileRegistrations: () => reconcileIssueSyncRegistrations(runtimeDeps),
    requestSync: requestExternalSync,
    pendingKeys: pendingExternalSyncKeys,
  }
  const one = setup(deps).refresher
  const two = setup(deps).refresher
  await one.handle(event())
  await two.handle(event({ id: "d2", eventType: "issues.labeled" }))
  await one.handle(event({ id: "d3" }))
  expect(one.pending()).toEqual(["acme/app"])
  expect(request).not.toHaveBeenCalled()
  await new Promise<void>((resolve) => setTimeout(resolve, 2100))
  for (let i = 0; i < 200 && pendingExternalSyncKeys().length; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  expect(request).toHaveBeenCalledTimes(1)
  expect(one.pending()).toEqual([])
})

it.each(["issues.transferred", "issues.deleted"])(
  "%s deletes a bound mirror row immediately",
  async (eventType) => {
    await upsertGithubIssues([
      toMirrorRow(
        {
          number: 7,
          title: "Remote",
          state: "open",
          html_url: "url",
          created_at: "2026-01-01",
          updated_at: "2026-01-02",
        },
        { repoFullName: "Acme/App", issueProjectId: "ip1", syncedAt: 1 }
      ),
    ])
    const { deps, refresher } = setup({
      reconcileRegistrations: jest.fn(async () => ({
        mirror: [{ repoFullName: "Acme/App", issueProjectId: "ip1" }],
        imported: [],
      })),
    })
    await refresher.handle(event({ eventType }))
    expect(deps.removeFromMirror).toHaveBeenCalledWith("Acme/App", [7])
    expect(await getGithubIssue("Acme/App", 7)).toBeUndefined()
    expect(deps.requestSync).toHaveBeenCalledWith("github-mirror:ip1:acme/app", "push")
  }
)

it.each(["disconnected", "grant-revoked", "foreign", "race-disconnect", "race-grant"] as const)(
  "a B departure preserves A's kept import when its source is %s",
  async (state) => {
    const db = getDb()
    const a = {
      id: "connection-A",
      providerId: "github-pat",
      ownerPluginId: null,
      identityKey: "person-A",
      revision: 1,
      status: "connected",
    } as AuthConnectionRow
    await db.authConnections.put(a)
    await db.authConnections.put({ ...a, id: "connection-B" as never, identityKey: "person-B" })
    await db.integrationAccounts.bulkPut([
      {
        id: "account-A",
        pluginId: "github-delivery",
        providerId: "github-pat",
        connectionId: a.id,
        enabled: true,
        status: "connected",
      },
      {
        id: "account-B",
        pluginId: "github-delivery",
        providerId: "github-pat",
        connectionId: "connection-B",
        enabled: true,
        status: "connected",
      },
    ] as never)
    await db.serviceConnections.put({
      id: "projection-A",
      pluginId: "github-delivery",
      status: "connected",
      providerFingerprint: "fp",
      providerRef: { kind: "integration", accountId: "account-A", authConnectionRef: a.id },
    } as never)
    await db.capabilityGrants.put({
      id: "grant-A",
      connectionId: "projection-A",
      consumerPluginId: "github-delivery",
      connectionRevision: 1,
      providerFingerprint: "fp",
      operationPatterns: ["github.request.GET"],
    } as never)
    await db.issueProjects.put({
      id: "ip2",
      projectId: "ws",
      key: "IP",
      name: "Kept",
      status: "planned",
      priority: "none",
      resources: [imported.resource],
      createdAt: 1,
      updatedAt: 1,
    })
    const binding = { ...imported, resource: { ...imported.resource } }
    await captureIssueSyncSource(binding, a.id, "github-delivery", "integration")
    expect(await resolveIssueResourceSource(binding.resource)).toBe("available")
    const issue = await createIssue({
      projectId: "ws",
      issueProjectId: "ip2",
      title: "Kept A",
      createdBy: { kind: "human" },
      externalRefs: [
        { provider: "github", externalId: "Acme/App#7", meta: { binding: "Acme/App" } },
      ],
    })
    const originalRefs = issue.externalRefs
    if (state === "disconnected")
      await db.authConnections.put(tombstoneAuthConnection(a, "tombstoned"))
    if (state === "grant-revoked") await db.capabilityGrants.delete("grant-A")
    const { refresher, deps } = setup({
      reconcileRegistrations: jest.fn(async () => ({ mirror: [], imported: [binding] })),
    })
    let raced = false
    const transact = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>
    const spy = state.startsWith("race")
      ? jest.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) => {
          const tables = args.slice(1, -1).flat()
          if (
            !raced &&
            args[0] === "rw" &&
            tables.includes(db.issues) &&
            tables.includes(db.issueEvents)
          ) {
            raced = true
            return (async () => {
              if (state === "race-disconnect")
                await db.authConnections.put(tombstoneAuthConnection(a, "tombstoned"))
              else await db.capabilityGrants.delete("grant-A")
              return transact(...args)
            })()
          }
          return transact(...args)
        }) as never)
      : undefined
    try {
      await refresher.handle(
        event({
          eventType: "issues.deleted",
          accountId: state.startsWith("race") ? "account-A" : "account-B",
        })
      )
    } finally {
      spy?.mockRestore()
    }
    expect(deps.onError).not.toHaveBeenCalled()
    if (state.startsWith("race")) expect(raced).toBe(true)
    expect((await getIssue(issue.id))?.externalRefs).toEqual(originalRefs)
    expect(
      await tombstoneIssueSyncRefs(binding, ["Acme/App#7"], {
        eventAccount: { pluginId: "github-delivery", accountId: "account-B" },
      })
    ).toBe(0)
    expect((await getIssue(issue.id))?.externalRefs).toEqual(originalRefs)
    if (state === "foreign") {
      await refresher.handle(event({ eventType: "issues.deleted", accountId: "account-A" }))
      expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toEqual(expect.any(Number))
    }
  }
)

it("an authoritative departure tombstones an import ref once and records external_departed", async () => {
  await getDb().issueProjects.put({
    id: "ip2",
    projectId: "ws",
    key: "IP",
    name: "Imported",
    status: "planned",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  })
  const issue = await createIssue({
    projectId: "ws",
    issueProjectId: "ip2",
    title: "Keep this issue",
    createdBy: { kind: "human" },
    externalRefs: [{ provider: "github", externalId: "Acme/App#7", meta: { binding: "Acme/App" } }],
  })
  const { deps, refresher } = setup({
    reconcileRegistrations: jest.fn(async () => ({ mirror: [], imported: [imported] })),
  })
  await refresher.handle(event({ eventType: "issues.transferred" }))
  await refresher.handle(event({ eventType: "issues.deleted" }))
  // No payload updated_at: the Host receipt time is never used as a barrier.
  expect(deps.departImport).toHaveBeenCalledWith(imported, ["Acme/App#7"], {
    eventAccount: { pluginId: "github-delivery", accountId: "acc" },
  })
  expect((await getIssue(issue.id))?.externalRefs?.[0].departedAt).toEqual(expect.any(Number))
  expect((await getIssue(issue.id))?.title).toBe("Keep this issue")
  expect(
    (await listIssueEvents({ issueId: issue.id })).filter((row) => row.kind === "external_departed")
  ).toHaveLength(1)
})

it.each([true, false])(
  "a fetched poll and a webhook departure (payload updated_at: %s)",
  async (hasUpdatedAt) => {
    await getDb().issueProjects.put({
      id: "ip2",
      projectId: "ws",
      key: "IP",
      name: "Import",
      status: "planned",
      priority: "none",
      resources: [],
      createdAt: 1,
      updatedAt: 1,
    })
    const issue = await createIssue({
      projectId: "ws",
      issueProjectId: "ip2",
      title: "Keep this issue",
      createdBy: { kind: "human" },
      externalRefs: [
        {
          provider: "github",
          externalId: "Acme/App#7",
          syncedAt: 1000,
          remoteUpdatedAt: 1000,
          meta: { binding: "Acme/App" },
        },
      ],
    })
    await getDb().externalSyncCursors.put({
      ...issueSyncTarget(imported),
      cursor: "1000",
      failures: 0,
    })
    // Without a remote version the Host receipt time (occurredAt) is later
    // than the item's real versions; it must not become a barrier.
    const departureTime = Date.parse("2026-09-02T00:00:00Z")
    let fetched!: () => void
    let apply!: () => void
    const fetchedPage = new Promise<void>((resolve) => {
      fetched = resolve
    })
    const releasePage = new Promise<void>((resolve) => {
      apply = resolve
    })
    let remoteUpdatedAt = departureTime
    const provider: IssueSyncProvider = {
      id: "github",
      label: "GitHub",
      pullFields: [],
      pushFields: [],
      resolveBindings: () => [imported],
      pull: async () => ({ items: [], notModified: false }),
      pullPage: async () => {
        const item = {
          externalId: "Acme/App#7",
          title: "Remote",
          status: "todo" as const,
          remoteUpdatedAt,
        }
        fetched()
        await releasePage
        return { items: [item], cursor: String(remoteUpdatedAt) }
      },
    }
    const poll = reconcileBinding(imported, provider)
    await fetchedPage
    const { refresher } = setup({
      reconcileRegistrations: jest.fn(async () => ({ mirror: [], imported: [imported] })),
    })
    try {
      await refresher.handle(
        event({
          eventType: "issues.deleted",
          payload: {
            issue: { number: 7, ...(hasUpdatedAt ? { updated_at: "2026-09-02T00:00:00Z" } : {}) },
          },
        })
      )
    } finally {
      apply()
    }
    expect((await poll).status).toBe("completed")
    const departed = (await getIssue(issue.id))!.externalRefs![0]
    if (!hasUpdatedAt) {
      // Unpinned: the stale page may revive it (the next full scan verifies
      // and departs it again), but it is never stuck behind a Host clock.
      expect(departed.meta?.departedRemoteAt).toBeUndefined()
      remoteUpdatedAt = Date.parse("2026-01-01T00:00:00Z")
      await reconcileBinding(imported, provider)
      expect((await getIssue(issue.id))!.externalRefs![0].departedAt).toBeUndefined()
      return
    }
    expect(departed.departedAt).toEqual(expect.any(Number))
    expect(departed.meta?.departedRemoteAt).toBe(departureTime)
    expect(
      (await listIssueEvents({ issueId: issue.id })).filter(
        (row) => row.kind === "external_returned"
      )
    ).toHaveLength(0)
    remoteUpdatedAt = departureTime - 1
    await reconcileBinding(imported, provider)
    expect((await getIssue(issue.id))!.externalRefs![0].departedAt).toBe(departed.departedAt)
    remoteUpdatedAt = departureTime + 1
    await reconcileBinding(imported, provider)
    expect((await getIssue(issue.id))!.externalRefs![0].departedAt).toBeUndefined()
    expect(
      (await listIssueEvents({ issueId: issue.id })).filter(
        (row) => row.kind === "external_returned"
      )
    ).toHaveLength(1)
  }
)

it("does not remove an unbound row or accept an invalid issue number", async () => {
  const { deps, refresher } = setup({
    reconcileRegistrations: jest.fn(async () => ({ mirror: [], imported: [] })),
  })
  await refresher.handle(event({ eventType: "issues.deleted" }))
  expect(deps.removeFromMirror).not.toHaveBeenCalled()
  for (const number of [undefined, "7", 0, -1, 1.5]) {
    const test = setup()
    await test.refresher.handle(
      event({ eventType: "issues.deleted", payload: { issue: { number } } })
    )
    expect(test.deps.removeFromMirror).not.toHaveBeenCalled()
  }
})

it("ignores GHES, unknown hosts and irrelevant events", async () => {
  for (const host of ["ghe.acme.io", undefined]) {
    const { deps, refresher } = setup({ accountHostId: jest.fn(async () => host) })
    await refresher.handle(event({ eventType: "issues.transferred" }))
    expect(deps.reconcileRegistrations).not.toHaveBeenCalled()
    expect(deps.removeFromMirror).not.toHaveBeenCalled()
  }
  const { deps, refresher } = setup()
  await refresher.handle(event({ eventType: "pull_request.opened" }))
  expect(deps.accountHostId).not.toHaveBeenCalled()
})

it("reports account, registration and departure failures without throwing", async () => {
  for (const fail of ["accountHostId", "reconcileRegistrations", "removeFromMirror"] as const) {
    const { deps, refresher } = setup({
      [fail]: jest.fn(async () => {
        throw new Error("unavailable")
      }),
    })
    await expect(refresher.handle(event({ eventType: "issues.deleted" }))).resolves.toBeUndefined()
    expect(deps.onError).toHaveBeenCalledWith("acme/app", expect.any(Error))
  }
})

it("keeps the explicit refresh API and pending repository list", async () => {
  const { deps, refresher } = setup({
    pendingKeys: () => ["github-mirror:p1:acme/app", "issues:p2:acme/app", "unrelated"],
  })
  expect(refresher.pending()).toEqual(["acme/app"])
  await refresher.refresh("ACME/APP")
  expect(deps.requestSync).toHaveBeenCalledWith("github-mirror:ip1:acme/app", "push")
})
