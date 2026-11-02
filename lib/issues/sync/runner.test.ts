import type { IssueProject } from "@/types/issues"
import { IssueSyncRegistry } from "./registry"
import { resolveWorkspaceSyncBindings, runWorkspaceIssueSync } from "./runner"
import type { IssueSyncBinding, IssueSyncProvider, ReconcileOutcome } from "./types"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { reconcileIssueSyncRegistrations } from "./runtime"
import { installExternalSyncRuntime } from "@/lib/external-services/sync/runtime"
import { issueSyncTarget } from "./engine"
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
let dispose: () => void
beforeEach(() => {
  dispose = installExternalSyncRuntime()
})
afterEach(() => dispose())

function container(id: string, projectId = "w1"): IssueProject {
  return {
    id,
    projectId,
    key: id.toUpperCase(),
    name: id,
    status: "backlog",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function binding(providerId: string, issueProjectId: string): IssueSyncBinding {
  return {
    providerId,
    projectId: "w1",
    issueProjectId,
    projectKey: issueProjectId.toUpperCase(),
    resource: { kind: "github-repo", repoFullName: "o/r", addedAt: 1 },
    key: `${providerId}:${issueProjectId}`,
  }
}

function provider(id: string, bindings: IssueSyncBinding[]): IssueSyncProvider {
  return {
    id,
    label: id,
    pullFields: [],
    pushFields: [],
    resolveBindings: () => bindings,
    pull: async () => ({ items: [], notModified: true }),
  }
}

const outcome = (b: IssueSyncBinding): ReconcileOutcome => ({
  status: "completed",
  pages: 1,
  tombstoned: 0,
  binding: b,
  created: 1,
  updated: 0,
  pushed: 0,
  queued: 0,
  conflicts: 0,
  linked: 0,
  cycles: 0,
  notModified: false,
  truncated: false,
})

describe("resolveWorkspaceSyncBindings", () => {
  it("asks every registered provider, in registration order, with the scoped containers", async () => {
    const registry = new IssueSyncRegistry()
    const a = binding("a", "p1")
    const b = binding("b", "p1")
    registry.register(provider("a", [a]))
    registry.register(provider("b", [b]))
    const listContainers = jest.fn(async () => [container("p1")])
    const bindings = await resolveWorkspaceSyncBindings("w1", registry, listContainers as never)
    expect(bindings).toEqual([a, b])
    expect(listContainers).toHaveBeenCalledWith({ projectId: "w1" })
    await resolveWorkspaceSyncBindings(undefined, registry, listContainers as never)
    expect(listContainers).toHaveBeenLastCalledWith({})
  })
})

describe("runWorkspaceIssueSync", () => {
  it.each(["earlier target", "credential preparation"])(
    "skips an import unbound during %s",
    async (window) => {
      const registry = new IssueSyncRegistry()
      const a = binding("github", "p1")
      const b = binding("github", "p2")
      let live = [a, b]
      await getDb().issueProjects.bulkPut([container("p1"), container("p2")])
      let entered!: () => void
      let release!: () => void
      const blocked = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const pull = jest.fn(async (current: IssueSyncBinding) => {
        if (window === "earlier target" && current.issueProjectId === "p1") {
          entered()
          await gate
        }
        return {
          items: [
            {
              externalId: `${current.key}#7`,
              title: "Imported",
              status: "todo" as const,
              remoteUpdatedAt: 1000,
            },
          ],
          cursor: "1000",
        }
      })
      const currentProvider: IssueSyncProvider = {
        ...provider("github", []),
        resolveBindings: () => live,
        pullPage: pull,
        prepare: async (current) => {
          if (window === "credential preparation" && current.issueProjectId === "p2") {
            entered()
            await gate
          }
          return { provider: currentProvider }
        },
      }
      registry.register(currentProvider)
      const running = runWorkspaceIssueSync(
        { mirror: false },
        { registry, listContainers: async () => [] }
      )
      await blocked
      try {
        live = [a]
        await reconcileIssueSyncRegistrations({
          registry,
          mirrorBindings: async () => [],
          importBindings: async () => live,
        })
      } finally {
        release()
      }
      const result = await running
      expect(result.failures).toEqual([])
      expect(result.outcomes.map((row) => row.binding.issueProjectId)).toEqual(["p1"])
      expect(pull.mock.calls.some(([current]) => current.issueProjectId === "p2")).toBe(false)
      expect(await getDb().externalSyncCursors.get(issueSyncTarget(b).key)).toBeUndefined()
      expect(await getDb().issues.where("issueProjectId").equals("p2").count()).toBe(0)
    }
  )
  it("runs an import bound while the mirror sync was running", async () => {
    const registry = new IssueSyncRegistry()
    const a = binding("a", "p1")
    const b = binding("a", "p2")
    let live = [a]
    registry.register({ ...provider("a", []), resolveBindings: () => live })
    let release!: () => void
    const mirrorDone = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const mirrorStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const reconcile = jest.fn(async (current: IssueSyncBinding) => outcome(current))
    const running = runWorkspaceIssueSync(
      {},
      {
        registry,
        reconcile,
        listContainers: async () => [],
        runMirror: async () => {
          started()
          await mirrorDone
          return { repoCount: 0, results: [], failures: [] }
        },
      }
    )
    await mirrorStarted
    live = [a, b]
    release()
    const result = await running
    expect(result.outcomes.map((row) => row.binding.issueProjectId)).toEqual(["p1", "p2"])
    expect(result.bindingCount).toBe(2)
  })
  it("reports failed/backoff outcomes as typed failures and keeps sequential binding order", async () => {
    const registry = new IssueSyncRegistry()
    const bindings = [binding("a", "p1"), binding("a", "p2"), binding("a", "p3")]
    registry.register(provider("a", bindings))
    const order: string[] = []
    const result = await runWorkspaceIssueSync(
      { mirror: false },
      {
        registry,
        listContainers: async () => [],
        reconcile: async (b) => {
          order.push(b.issueProjectId)
          return {
            ...outcome(b),
            status:
              b.issueProjectId === "p1" ? "failed" : b.issueProjectId === "p2" ? "backoff" : "busy",
            errorCode: b.issueProjectId === "p2" ? "rate-limited" : "sync-failed",
          }
        },
      }
    )
    expect(order).toEqual(["p1", "p2", "p3"])
    expect(result.outcomes).toHaveLength(3)
    expect(result.failures.map((failure) => failure.error)).toEqual([
      expect.objectContaining({ name: "IssueSyncOutcomeError", code: "sync-failed" }),
      expect.objectContaining({ name: "IssueSyncOutcomeError", code: "rate-limited" }),
    ])
  })
  it("defers remaining snapshot bindings when a provider is replaced mid-sweep", async () => {
    const registry = new IssueSyncRegistry()
    registry.register(provider("a", [binding("a", "p1"), binding("a", "p2")]))
    const reconcile = jest.fn(async (b: IssueSyncBinding) => {
      registry.register(provider("a", [binding("a", "p2")]))
      return outcome(b)
    })
    const result = await runWorkspaceIssueSync(
      { mirror: false },
      { registry, reconcile, listContainers: async () => [] }
    )
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(result.outcomes).toEqual([])
    expect(result.failures).toEqual([])
  })
  it("runs the mirror, then every binding, isolating failures", async () => {
    const registry = new IssueSyncRegistry()
    const good = binding("a", "p1")
    const bad = binding("b", "p1")
    registry.register(provider("a", [good]))
    registry.register(provider("b", [bad]))
    const runMirror = jest.fn(async () => ({ repoCount: 2, results: [], failures: [] }))
    const reconcile = jest.fn(
      async (
        b: IssueSyncBinding,
        _registry: import("./registry").IssueSyncRegistry,
        _options: { full?: boolean }
      ) => {
        if (b.providerId === "b") throw new Error("boom")
        return outcome(b)
      }
    )
    const result = await runWorkspaceIssueSync(
      { projectId: "w1", full: true },
      {
        registry,
        runMirror: runMirror as never,
        reconcile: reconcile as never,
        listContainers: (async () => [container("p1")]) as never,
      }
    )
    expect(runMirror).toHaveBeenCalledWith({ projectId: "w1", full: true })
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile.mock.calls[0][2]).toEqual({ full: true, signal: expect.any(AbortSignal) })
    expect(result.bindingCount).toBe(4)
    expect(result.outcomes).toHaveLength(1)
    expect(result.failures).toEqual([{ binding: bad, error: expect.any(Error) }])
  })

  it("can skip the mirror and narrow to one provider", async () => {
    const registry = new IssueSyncRegistry()
    registry.register(provider("a", [binding("a", "p1")]))
    registry.register(provider("b", [binding("b", "p1")]))
    const runMirror = jest.fn()
    const reconcile = jest.fn(
      async (
        b: IssueSyncBinding,
        _registry: import("./registry").IssueSyncRegistry,
        _options: { full?: boolean }
      ) => outcome(b)
    )
    const result = await runWorkspaceIssueSync(
      { providerId: "b", mirror: false },
      {
        registry,
        runMirror: runMirror as never,
        reconcile: reconcile as never,
        listContainers: (async () => [container("p1")]) as never,
      }
    )
    expect(runMirror).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(result.bindingCount).toBe(1)
    expect(result.mirror.repoCount).toBe(0)
  })
})
