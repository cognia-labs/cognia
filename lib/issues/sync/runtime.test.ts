/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  installExternalSyncRuntime,
  hasExternalSyncRegistration,
  pendingExternalSyncKeys,
  requestExternalSync,
} from "@/lib/external-services/sync/runtime"
import {
  reconcileIssueSyncRegistrations,
  runRegisteredIssueSync,
  type IssueSyncRuntimeDeps,
} from "./runtime"
import { IssueSyncRegistry } from "./registry"
import type { IssueSyncBinding, IssueSyncProvider } from "./types"
import { getGithubIssue } from "@/lib/db/github-issue-mirror"
import type { OctokitLike } from "@/lib/github/issues"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
let dispose: () => void
beforeEach(() => {
  dispose = installExternalSyncRuntime()
})
afterEach(() => dispose())
const binding: IssueSyncBinding = {
  providerId: "github",
  issueProjectId: "p1",
  projectId: "ws",
  projectKey: "IP",
  resource: { kind: "github-repo", repoFullName: "o/r", addedAt: 1, sync: { mode: "import" } },
  key: "o/r",
}
const importKey = "issues:p1:o/r"
const mirrorKey = "github-mirror:p2:o/r"
async function settle() {
  for (let i = 0; i < 300 && pendingExternalSyncKeys().length; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  expect(pendingExternalSyncKeys()).toEqual([])
}
function setup() {
  const registry = new IssueSyncRegistry()
  const pull = jest.fn(async () => ({ items: [], cursor: "1" }))
  const provider: IssueSyncProvider = {
    id: "github",
    label: "GitHub",
    pullFields: [],
    pushFields: [],
    resolveBindings: () => [binding],
    pullPage: pull,
    pull: async () => ({ items: [], notModified: false }),
  }
  registry.register(provider)
  const request = jest.fn(async (): ReturnType<OctokitLike["request"]> => ({
    status: 200,
    headers: {},
    data: [],
  }))
  const deps: IssueSyncRuntimeDeps = {
    registry,
    importBindings: async () => [binding],
    mirrorBindings: async () => [{ repoFullName: "o/r", issueProjectId: "p2" }],
    mirrorDeps: { resolveOctokit: async () => ({ request }) },
  }
  return { deps, pull, request, provider, registry }
}

it("registers both target kinds, retains unchanged registrations and removes vanished bindings", async () => {
  const { deps, pull, request } = setup()
  await reconcileIssueSyncRegistrations(deps)
  await reconcileIssueSyncRegistrations(deps)
  expect(hasExternalSyncRegistration(importKey)).toBe(true)
  expect(hasExternalSyncRegistration(mirrorKey)).toBe(true)
  requestExternalSync(importKey, "push")
  requestExternalSync(mirrorKey, "push")
  await reconcileIssueSyncRegistrations({
    ...deps,
    importBindings: async () => [],
    mirrorBindings: async () => [],
  })
  expect(hasExternalSyncRegistration(importKey)).toBe(false)
  expect(hasExternalSyncRegistration(mirrorKey)).toBe(false)
  expect(pendingExternalSyncKeys()).toEqual([])
  requestExternalSync(importKey, "manual")
  requestExternalSync(mirrorKey, "manual")
  expect(pull).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})

it("resolves the mirror binding freshly instead of retaining its old repo spelling", async () => {
  const { deps, request } = setup()
  let repoFullName = "o/r"
  deps.mirrorBindings = async () => [{ repoFullName, issueProjectId: "p2" }]
  request.mockResolvedValue({
    status: 200,
    headers: {},
    data: [
      {
        number: 7,
        title: "Remote",
        state: "open",
        html_url: "url",
        created_at: "2026-01-01",
        updated_at: "2026-01-02",
      },
    ],
  })
  await reconcileIssueSyncRegistrations(deps)
  repoFullName = "O/R"
  requestExternalSync(mirrorKey, "manual")
  await settle()
  expect(request).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ owner: "O", repo: "R" })
  )
  expect(await getGithubIssue("O/R", 7)).toMatchObject({ issueProjectId: "p2" })
})

it("resolves the import binding freshly and runs the existing import engine driver", async () => {
  const { deps, pull } = setup()
  let current = binding
  deps.importBindings = async () => [current]
  await getDb().issueProjects.put({
    id: "p1",
    projectId: "ws",
    key: "IP",
    name: "Import",
    status: "planned",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  })
  await reconcileIssueSyncRegistrations(deps)
  current = { ...binding, projectKey: "NEW" }
  requestExternalSync(importKey, "manual")
  await settle()
  expect(pull).toHaveBeenCalledWith(current, expect.objectContaining({ mode: "full" }))
  expect((await getDb().externalSyncCursors.get(importKey))?.cursor).toBe("1")
})

it("re-registers after runtime disposal and does not remove another workspace's target", async () => {
  const { deps } = setup()
  await reconcileIssueSyncRegistrations(deps)
  dispose()
  await reconcileIssueSyncRegistrations(deps)
  expect(hasExternalSyncRegistration(importKey)).toBe(true)
  expect(hasExternalSyncRegistration(mirrorKey)).toBe(true)
  await reconcileIssueSyncRegistrations({ ...deps, importBindings: async () => [] })
  expect(hasExternalSyncRegistration(importKey)).toBe(false)
  expect(hasExternalSyncRegistration(mirrorKey)).toBe(true)
})

it("does not resurrect a removed binding when an older lookup finishes later", async () => {
  const { deps } = setup()
  let release!: (bindings: Array<{ repoFullName: string; issueProjectId: string }>) => void
  const staleBindings = new Promise<Array<{ repoFullName: string; issueProjectId: string }>>(
    (resolve) => {
      release = resolve
    }
  )
  const older = reconcileIssueSyncRegistrations({
    ...deps,
    mirrorBindings: () => staleBindings,
    importBindings: async () => [],
  })
  await reconcileIssueSyncRegistrations({
    ...deps,
    mirrorBindings: async () => [],
    importBindings: async () => [],
  })
  release([{ repoFullName: "o/r", issueProjectId: "p2" }])
  await older
  expect(hasExternalSyncRegistration(mirrorKey)).toBe(false)
})

it("an overlapping caller receives the winning snapshot before requesting refreshes", async () => {
  const { deps } = setup()
  let release!: (bindings: Array<{ repoFullName: string; issueProjectId: string }>) => void
  const newerBindings = new Promise<Array<{ repoFullName: string; issueProjectId: string }>>(
    (resolve) => {
      release = resolve
    }
  )
  const older = reconcileIssueSyncRegistrations(deps)
  const newer = reconcileIssueSyncRegistrations({ ...deps, mirrorBindings: () => newerBindings })
  release([
    { repoFullName: "o/r", issueProjectId: "p2" },
    { repoFullName: "o/other", issueProjectId: "p3" },
  ])
  const [first, second] = await Promise.all([older, newer])
  expect(first).toEqual(second)
  expect(hasExternalSyncRegistration("github-mirror:p3:o/other")).toBe(true)
})

it("an old credential preparation cannot run a newly re-registered target with the same key", async () => {
  const { deps, request } = setup()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  deps.mirrorDeps = {
    resolveOctokit: async () => {
      entered()
      await gate
      return { request }
    },
  }
  await reconcileIssueSyncRegistrations(deps)
  const old = runRegisteredIssueSync(mirrorKey)
  await started
  try {
    await reconcileIssueSyncRegistrations({ ...deps, mirrorBindings: async () => [] })
    await reconcileIssueSyncRegistrations(deps)
  } finally {
    release()
  }
  expect(await old).toBeUndefined()
  expect(request).not.toHaveBeenCalled()
  expect(await getDb().externalSyncCursors.get(mirrorKey)).toBeUndefined()
  expect(await runRegisteredIssueSync(mirrorKey)).toMatchObject({ status: "completed" })
  expect(request).toHaveBeenCalledTimes(1)
})
