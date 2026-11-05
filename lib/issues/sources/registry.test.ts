import { statusCategoryOf } from "@/types/issues"
import type {
  IssueSourceAdapter,
  IssueSourceKind,
  IssueSourceObserver,
  IssueSourceQuery,
  UnifiedIssueItem,
} from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, makeUnifiedIssueId } from "@/types/issues/unified"
import {
  createIssueSourceRegistry,
  getIssueSourceRegistry,
  resetIssueSourceRegistry,
  type IssueSourceSnapshot,
} from "./registry"

function item(kind: IssueSourceKind, sourceId: string, order = 0): UnifiedIssueItem {
  return {
    unifiedId: makeUnifiedIssueId(kind, sourceId),
    kind,
    sourceId,
    identifier: sourceId,
    title: sourceId,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order,
    createdAt: 0,
    updatedAt: 0,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
  }
}

interface StubSource extends IssueSourceAdapter {
  /** Deliver rows to every live subscriber. */
  push(items: UnifiedIssueItem[]): void
  fail(error: unknown): void
  queries: IssueSourceQuery[]
  stops: number
}

/** A source the test drives by hand; `initial` is delivered on subscribe. */
function stubSource(kind: IssueSourceKind, initial?: UnifiedIssueItem[]): StubSource {
  const observers = new Set<IssueSourceObserver>()
  const source: StubSource = {
    kind,
    label: kind,
    list: async () => initial ?? [],
    subscribe(query, observer) {
      source.queries.push(query)
      observers.add(observer)
      if (initial) observer.next(initial)
      return () => {
        source.stops += 1
        observers.delete(observer)
      }
    },
    push: (items) => observers.forEach((observer) => observer.next(items)),
    fail: (error) => observers.forEach((observer) => observer.error(error)),
    queries: [],
    stops: 0,
  }
  return source
}

const QUERY = { projectId: "w1" }

function watch(
  registry: ReturnType<typeof createIssueSourceRegistry>,
  query: IssueSourceQuery = QUERY
) {
  const snapshots: IssueSourceSnapshot[] = []
  const stop = registry.subscribeAll(query, (snapshot) => snapshots.push(snapshot))
  const ids = () => snapshots.at(-1)?.items.map((i) => i.unifiedId)
  return { snapshots, stop, ids }
}

describe("IssueSourceRegistry", () => {
  it("registers, resolves and unregisters by kind", () => {
    const registry = createIssueSourceRegistry()
    const source = stubSource("local", [])
    registry.register(source)

    expect(registry.has("local")).toBe(true)
    expect(registry.getSource("local")).toBe(source)
    expect(registry.listAllSources()).toEqual([source])

    registry.unregister("local")
    expect(registry.has("local")).toBe(false)
    expect(registry.getSource("local")).toBeUndefined()
  })

  it("replaces a source registered twice for the same kind", () => {
    const registry = createIssueSourceRegistry()
    const first = stubSource("local", [])
    const second = stubSource("local", [])
    registry.register(first)
    registry.register(second)
    expect(registry.listAllSources()).toEqual([second])
  })

  it("clears every source", () => {
    const registry = createIssueSourceRegistry()
    registry.register(stubSource("local", []))
    registry.clear()
    expect(registry.listAllSources()).toEqual([])
  })

  it("tells listeners when the set of sources changes, and not for a repeat", () => {
    const registry = createIssueSourceRegistry()
    const listener = jest.fn()
    const stop = registry.onSourcesChanged(listener)
    const source = stubSource("local", [])
    registry.register(source)
    registry.register(source)
    registry.unregister("github")
    registry.unregister("local")
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    registry.register(source)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe("IssueSourceRegistry.subscribeAll", () => {
  it("passes the query through to each source", () => {
    const registry = createIssueSourceRegistry()
    const local = stubSource("local", [])
    registry.register(local)
    watch(registry, { projectId: "w1", issueProjectId: "p1" })
    expect(local.queries).toEqual([{ projectId: "w1", issueProjectId: "p1" }])
  })

  it("waits for every source before the first snapshot, then merges sorted", () => {
    const registry = createIssueSourceRegistry()
    const local = stubSource("local", [item("local", "b", 1)])
    const github = stubSource("github")
    registry.register(local)
    registry.register(github)
    const seen = watch(registry)
    expect(seen.snapshots).toEqual([])

    github.push([item("github", "a", 0)])
    expect(seen.snapshots).toHaveLength(1)
    expect(seen.snapshots[0]!.errors).toEqual([])
    expect(seen.ids()).toEqual(["github:a", "local:b"])
  })

  it("delivers a fresh snapshot each time any source changes", () => {
    const registry = createIssueSourceRegistry()
    const local = stubSource("local", [item("local", "a")])
    const team = stubSource("agent-team", [])
    registry.register(local)
    registry.register(team)
    const seen = watch(registry)

    team.push([item("agent-team", "t1", 2)])
    expect(seen.ids()).toEqual(["local:a", "agent-team:t1"])
    local.push([])
    expect(seen.ids()).toEqual(["agent-team:t1"])
  })

  it("delivers an empty snapshot when nothing is registered", () => {
    const seen = watch(createIssueSourceRegistry())
    expect(seen.snapshots).toEqual([{ items: [], errors: [] }])
  })

  it("subscribes a source registered after the board did, and drops a removed one", () => {
    const registry = createIssueSourceRegistry()
    const seen = watch(registry)
    expect(seen.ids()).toEqual([])

    const local = stubSource("local", [item("local", "late")])
    registry.register(local)
    expect(seen.ids()).toEqual(["local:late"])

    registry.unregister("local")
    expect(local.stops).toBe(1)
    expect(seen.ids()).toEqual([])
    local.push([item("local", "ghost")])
    expect(seen.ids()).toEqual([])
  })

  it("moves to the new source when a kind is re-registered", () => {
    const registry = createIssueSourceRegistry()
    const first = stubSource("local", [item("local", "old")])
    registry.register(first)
    const seen = watch(registry)
    registry.register(stubSource("local", [item("local", "new")]))
    expect(first.stops).toBe(1)
    expect(seen.ids()).toEqual(["local:new"])
  })

  it("keeps a healthy source's items when another source fails, and lets it rejoin", () => {
    // A broken GitHub token must never blank out the user's local issues.
    const registry = createIssueSourceRegistry()
    const boom = new Error("token expired")
    registry.register(stubSource("local", [item("local", "kept")]))
    const github = stubSource("github")
    registry.register(github)
    const seen = watch(registry)

    github.fail(boom)
    expect(seen.ids()).toEqual(["local:kept"])
    expect(seen.snapshots.at(-1)!.errors).toEqual([{ kind: "github", error: boom }])

    github.push([item("github", "back")])
    expect(seen.snapshots.at(-1)!.errors).toEqual([])
    expect(seen.ids()).toEqual(["github:back", "local:kept"])
  })

  it("reports every failing source, including one whose subscribe throws", () => {
    const registry = createIssueSourceRegistry()
    const github = stubSource("github")
    registry.register(github)
    registry.register({
      ...stubSource("agent-team"),
      subscribe: () => {
        throw new Error("agent-team")
      },
    })
    const seen = watch(registry)
    github.fail(new Error("github"))
    expect(seen.snapshots.at(-1)!.items).toEqual([])
    expect(
      seen.snapshots
        .at(-1)!
        .errors.map((e) => e.kind)
        .sort()
    ).toEqual(["agent-team", "github"])
  })

  it("stops every source and ignores late deliveries once stopped", () => {
    const registry = createIssueSourceRegistry()
    const local = stubSource("local", [])
    registry.register(local)
    const seen = watch(registry)
    seen.stop()
    seen.stop()
    expect(local.stops).toBe(1)
    const count = seen.snapshots.length
    local.push([item("local", "late")])
    registry.register(stubSource("github", []))
    expect(seen.snapshots).toHaveLength(count)
  })
})

describe("getIssueSourceRegistry", () => {
  afterEach(resetIssueSourceRegistry)

  it("returns a stable singleton", () => {
    expect(getIssueSourceRegistry()).toBe(getIssueSourceRegistry())
  })

  it("hands out a fresh instance after a reset, so tests stay isolated", () => {
    const first = getIssueSourceRegistry()
    first.register(stubSource("local", []))
    resetIssueSourceRegistry()
    expect(getIssueSourceRegistry()).not.toBe(first)
    expect(getIssueSourceRegistry().has("local")).toBe(false)
  })
})
