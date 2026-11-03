/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  latestMirroredUpdate,
  listGithubIssues,
  upsertGithubIssues,
} from "@/lib/db/github-issue-mirror"
import { toMirrorRow, type OctokitLike } from "@/lib/github/issues"
import { claimSyncLease } from "@/lib/db/sync-leases"
import { purgeDerivedData } from "@/lib/external-services/derived-data-registry"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  githubMirrorSyncTarget,
  syncRepoIssues,
  syncWorkspaceRepos,
  GithubMirrorSyncOutcomeError,
  type SyncRepoIssuesDeps,
} from "./github-sync"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const NOW = 1_800_000_000_000
const INPUT = { repoFullName: "o/r", issueProjectId: "p1" }
const key = githubMirrorSyncTarget(INPUT).key
const cursor = () => getDb().externalSyncCursors.get(key)
function rawIssue(number = 1, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    html_url: `https://github.test/o/r/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  }
}
function octokit(
  responses: Array<{ status?: number; headers?: Record<string, string>; data?: unknown }>
) {
  const calls: Array<Record<string, unknown>> = []
  let index = 0
  const client: OctokitLike = {
    async request(_route, params) {
      calls.push(params ?? {})
      const response = responses[Math.min(index++, responses.length - 1)]
      return {
        status: response.status ?? 200,
        headers: response.headers ?? {},
        data: response.data ?? [],
      }
    },
  }
  return { client, calls }
}
const deps = (client: OctokitLike, over: Partial<SyncRepoIssuesDeps> = {}): SyncRepoIssuesDeps => ({
  resolveOctokit: async () => client,
  now: () => NOW,
  ...over,
})
async function cache(number: number, over: Record<string, unknown> = {}) {
  await upsertGithubIssues([toMirrorRow(rawIssue(number, over), { ...INPUT, syncedAt: NOW })])
}
async function seedCursor(value = Date.parse("2026-01-05T00:00:00Z")) {
  await getDb().externalSyncCursors.put({
    ...githubMirrorSyncTarget(INPUT),
    failures: 0,
    cursor: String(value),
  })
}

it("uses the stored cursor, never the newest cached row or its ETag", async () => {
  await seedCursor()
  await cache(99, { updated_at: "2026-10-01T00:00:00Z" })
  const { client, calls } = octokit([{ data: [] }])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "completed",
    written: 0,
    notModified: false,
  })
  expect(calls[0]).toMatchObject({
    since: "2026-01-04T23:59:59.000Z",
    sort: "updated",
    state: "all",
    direction: "asc",
  })
  expect(calls[0]).not.toHaveProperty("headers")
})

it("stamps durable connection and consumer ownership on mirrored rows", async () => {
  const ref = "mirror-connection" as AuthConnectionRef
  await getDb().authConnections.put({
    id: ref,
    status: "connected",
    ownerPluginId: "auth-plugin",
  } as never)
  const { client } = octokit([{ data: [rawIssue(1)] }])
  expect(
    await syncRepoIssues(INPUT, {
      resolveReadClient: async () => ({
        octokit: client,
        connectionRef: ref,
        consumerPluginId: "reader",
      }),
    })
  ).toMatchObject({ status: "completed", written: 1 })
  await getDb().externalSyncCursors.clear()
  expect(await listGithubIssues()).toEqual([
    expect.objectContaining({
      connectionRef: ref,
      consumerPluginId: "reader",
      providerPluginId: "auth-plugin",
    }),
  ])
})

it.each(["fetch", "credential"] as const)(
  "plugin-data purge fences a mirror paused in %s before its first row",
  async (phase) => {
    const ref = "purge-ref" as AuthConnectionRef
    await getDb().authConnections.put({
      id: ref,
      status: "connected",
      ownerPluginId: "auth-plugin",
    } as never)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client: OctokitLike = {
      request: async () => {
        if (phase === "fetch") {
          entered()
          await gate
        }
        return { status: 200, headers: {}, data: [rawIssue(1)] }
      },
    }
    const pending = syncRepoIssues(INPUT, {
      resolveReadClient: async () => {
        if (phase === "credential") {
          entered()
          await gate
        }
        return { octokit: client, connectionRef: ref, consumerPluginId: "reader" }
      },
    })
    // Observe rejection immediately for a credential factory fenced before core starts.
    const settled = pending.then(
      (value) => value,
      (error: unknown) => error
    )
    await started
    const purge = purgeDerivedData({ kind: "plugin-data", pluginId: "reader" })
    if (phase === "credential") await purge
    else {
      const deadline = Date.now() + 5000
      while (await cursor()) {
        if (Date.now() >= deadline) throw new Error("Mirror cursor purge did not start")
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
    }
    release()
    const result = await settled
    expect(result).toMatchObject(
      phase === "credential" ? { name: "AbortError" } : { status: "cancelled" }
    )
    expect((await purge).failed).toEqual([])
    expect(await listGithubIssues()).toEqual([])
    expect(await cursor()).toBeUndefined()
  }
)

it("heals old gaps with a first full scan instead of seeding from latestMirroredUpdate", async () => {
  await cache(99, { updated_at: "2026-10-01T00:00:00Z" })
  expect(await latestMirroredUpdate("o/r")).toBe(Date.parse("2026-10-01T00:00:00Z"))
  const { client, calls } = octokit([{ data: [rawIssue(1)] }])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "completed",
    written: 1,
    removed: 1,
  })
  expect(calls[0].since).toBe("1970-01-01T00:00:00.000Z")
  expect((await listGithubIssues())[0]).toMatchObject({ id: "o/r#1", issueProjectId: "p1" })
})

it("resumes the stored page after truncation, committing no cursor or tombstones early", async () => {
  await seedCursor(1)
  await cache(9)
  const { client, calls } = octokit([
    { data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } },
    { data: [rawIssue(2, { updated_at: "2026-01-03T00:00:00Z" })] },
  ])
  expect(
    await syncRepoIssues({ ...INPUT, full: true }, deps(client, { pageBudget: 1 }))
  ).toMatchObject({ status: "completed", truncated: true, written: 1, removed: 0 })
  expect(await cursor()).toMatchObject({ cursor: "1", generation: { mode: "full", pages: 1 } })
  const page = JSON.parse((await cursor())!.generation!.page!)
  expect(page).toMatchObject({ since: Date.parse("2026-01-02T00:00:00Z"), page: 1 })
  // Auto must resume the pending full scan even though an older cursor exists.
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "completed",
    truncated: false,
    written: 1,
    removed: 1,
  })
  expect(calls[1].since).toBe("2026-01-01T23:59:59.000Z")
  expect((await listGithubIssues()).map((row) => row.number).sort()).toEqual([1, 2])
  expect((await cursor())?.cursor).toBe(String(Date.parse("2026-01-03T00:00:00Z")))
})

it("resumes a failed later page even after page one moved latestMirroredUpdate", async () => {
  const { client, calls } = octokit([
    { data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } },
    { status: 500 },
    { data: [rawIssue(2)] },
  ])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "failed",
    written: 1,
    errorCode: "sync-failed",
  })
  expect(await latestMirroredUpdate("o/r")).toBe(Date.parse("2026-01-02T00:00:00Z"))
  expect((await cursor())?.cursor).toBeUndefined()
  expect(await syncRepoIssues(INPUT, deps(client, { now: () => NOW + 60_000 }))).toMatchObject({
    status: "completed",
    written: 1,
  })
  expect(calls[2]).toEqual(calls[1])
  expect((await listGithubIssues()).map((row) => row.number).sort()).toEqual([1, 2])
})

it("reapplies a page after an upsert writes and then fails", async () => {
  const { client, calls } = octokit([{ data: [rawIssue(1)] }])
  const write = jest.fn(async (rows: Parameters<typeof upsertGithubIssues>[0]) => {
    await upsertGithubIssues(rows)
    if (write.mock.calls.length === 1) throw new Error("crashed after writing")
  })
  expect(await syncRepoIssues(INPUT, deps(client, { upsertGithubIssues: write }))).toMatchObject({
    status: "failed",
  })
  expect((await cursor())?.generation?.pages).toBe(0)
  expect(
    await syncRepoIssues(
      INPUT,
      deps(client, { upsertGithubIssues: write, now: () => NOW + 60_000 })
    )
  ).toMatchObject({ status: "completed", written: 1 })
  expect(calls[1]).toEqual(calls[0])
  expect(await listGithubIssues()).toHaveLength(1)
})

it("full scans delete unseen rows only in their container; incremental scans never prune", async () => {
  await seedCursor()
  await cache(1)
  await cache(3)
  await upsertGithubIssues([
    toMirrorRow(rawIssue(8), { repoFullName: "o/r", issueProjectId: "other", syncedAt: NOW }),
  ])
  const { client } = octokit([{ data: [rawIssue(1)] }])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({ removed: 0 })
  expect(await listGithubIssues()).toHaveLength(3)
  expect(await syncRepoIssues({ ...INPUT, full: true }, deps(client))).toMatchObject({ removed: 1 })
  expect((await listGithubIssues()).map((row) => row.number).sort()).toEqual([1, 8])
})

it("never tombstones a full scan which used tie-bucket offsets, including across runs", async () => {
  await cache(9)
  const { client } = octokit([
    { data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } },
    { data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } },
    { data: [rawIssue(2)] },
  ])
  expect(await syncRepoIssues(INPUT, deps(client, { pageBudget: 2 }))).toMatchObject({
    truncated: true,
  })
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({ removed: 0 })
  expect((await listGithubIssues()).map((row) => row.number).sort()).toEqual([1, 2, 9])
})

it("does not regress a stored cursor during a full scan", async () => {
  await seedCursor()
  const { client } = octokit([{ data: [rawIssue(1)] }])
  await syncRepoIssues({ ...INPUT, full: true }, deps(client))
  expect((await cursor())?.cursor).toBe(String(Date.parse("2026-01-05T00:00:00Z")))
})

it("carries progress across PR-only pages without mirroring PRs", async () => {
  const { client } = octokit([
    { data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } },
    { data: [rawIssue(2, { pull_request: {}, updated_at: "2026-01-03T00:00:00Z" })] },
  ])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({ written: 1, truncated: false })
  expect((await cursor())?.cursor).toBe(String(Date.parse("2026-01-03T00:00:00Z")))
})

it.each([401, 403, 404, 304])("preserves the mirror on unexpected HTTP %s", async (status) => {
  await cache(9)
  const { client } = octokit([{ status }])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "failed",
    written: 0,
    removed: 0,
  })
  expect(await listGithubIssues()).toHaveLength(1)
})

it("429 persists backoff and makes no requests before Retry-After", async () => {
  const { client, calls } = octokit([
    { status: 429, headers: { "retry-after": "120" } },
    { data: [rawIssue(1)] },
  ])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "backoff",
    errorCode: "rate-limited",
  })
  expect((await cursor())?.backoffUntil).toBe(NOW + 120_000)
  expect(await syncRepoIssues(INPUT, deps(client, { now: () => NOW + 119_999 }))).toMatchObject({
    status: "backoff",
  })
  expect(calls).toHaveLength(1)
  expect(await syncRepoIssues(INPUT, deps(client, { now: () => NOW + 120_000 }))).toMatchObject({
    status: "completed",
  })
  expect(calls).toHaveLength(2)
})

it("surfaces the remaining rate-limit budget and normal quiet windows", async () => {
  const { client } = octokit([{ headers: { "x-ratelimit-remaining": "17" } }])
  expect(await syncRepoIssues(INPUT, deps(client))).toMatchObject({
    status: "completed",
    written: 0,
    notModified: false,
    rateLimitRemaining: 17,
  })
})

it("two independent mirror runs exclude each other and busy is not a workspace failure", async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const client: OctokitLike = {
    request: async () => {
      entered()
      await gate
      return { status: 200, headers: {}, data: [] }
    },
  }
  const first = syncRepoIssues(INPUT, deps(client))
  await started
  try {
    const second = await syncWorkspaceRepos({ bindings: [INPUT] }, deps(client))
    expect(second.results[0].status).toBe("busy")
    expect(second.failures).toEqual([])
  } finally {
    release()
    await first
  }
})

it("uses the Host connection lease when its credential came from a connection", async () => {
  const connectionRef = "github-connection" as AuthConnectionRef
  const { client, calls } = octokit([{ data: [] }])
  await getDb().authConnections.put({ id: connectionRef, status: "connected" } as never)
  const lease = await claimSyncLease(connectionRef, `sync:${key}`, "other-window", 60_000)
  expect(lease).not.toBeNull()
  expect(
    await syncRepoIssues(INPUT, {
      resolveReadClient: async () => ({ octokit: client, connectionRef }),
    })
  ).toMatchObject({ status: "busy" })
  expect(calls).toHaveLength(0)
})

it("imports more than 1,000 API records with PR-only pages and identical timestamps", async () => {
  const records = Array.from({ length: 1201 }, (_, i) =>
    rawIssue(i + 1, i < 200 ? { pull_request: {} } : {})
  )
  const client: OctokitLike = {
    request: async (_route, params = {}) => {
      const eligible = records.filter(
        (row) => Date.parse(row.updated_at) > Date.parse(String(params.since))
      )
      const offset = (Number(params.page) - 1) * 100
      return {
        status: 200,
        headers: offset + 100 < eligible.length ? { link: '<x>; rel="next"' } : {},
        data: eligible.slice(offset, offset + 100),
      }
    },
  }
  await syncRepoIssues(INPUT, deps(client))
  expect(await listGithubIssues()).toHaveLength(1001)
  records.push(rawIssue(1202))
  await syncRepoIssues(INPUT, deps(client))
  expect(await listGithubIssues()).toHaveLength(1002)
})

describe("syncWorkspaceRepos", () => {
  const bindings = [INPUT, { repoFullName: "o/b", issueProjectId: "p2" }]
  it("syncs each binding and propagates full mode", async () => {
    const { client, calls } = octokit([{ data: [rawIssue(1)] }])
    const result = await syncWorkspaceRepos({ bindings, full: true }, deps(client))
    expect(result.results.map((r) => r.repoFullName)).toEqual(["o/r", "o/b"])
    expect(result.failures).toEqual([])
    expect(calls.every((call) => call.since === "1970-01-01T00:00:00.000Z")).toBe(true)
  })
  it("reports typed outcomes and keeps going when one repository fails", async () => {
    const { client } = octokit([{ status: 429, headers: { "retry-after": "60" } }, { data: [] }])
    const result = await syncWorkspaceRepos({ bindings }, deps(client))
    expect(result.results.map((r) => r.status)).toEqual(["backoff", "completed"])
    expect(result.failures[0]).toMatchObject({
      repoFullName: "o/r",
      error: { code: "rate-limited" },
    })
    expect(result.failures[0].error).toBeInstanceOf(GithubMirrorSyncOutcomeError)
  })
  it("isolates credential failures and does nothing when unbound", async () => {
    const error = new Error("no credential")
    expect(
      await syncWorkspaceRepos(
        { bindings: [INPUT] },
        {
          resolveOctokit: async () => {
            throw error
          },
        }
      )
    ).toEqual({ results: [], failures: [{ repoFullName: "o/r", error }] })
    expect(await syncWorkspaceRepos({ bindings: [] }, {})).toEqual({ results: [], failures: [] })
  })
})
