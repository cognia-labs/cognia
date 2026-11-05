import { act, renderHook } from "@testing-library/react"

import { createIssueSourceRegistry } from "@/lib/issues/sources/registry"
import { statusCategoryOf } from "@/types/issues"
import type {
  IssueSourceAdapter,
  IssueSourceKind,
  IssueSourceObserver,
  IssueSourceQuery,
  UnifiedIssueItem,
} from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, makeUnifiedIssueId } from "@/types/issues/unified"
import { useUnifiedIssues } from "./use-unified-issues"

function item(kind: IssueSourceKind, sourceId: string): UnifiedIssueItem {
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
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
  }
}

/** A source whose subscribers the test drives; it records every query and stop. */
function manualSource(kind: IssueSourceKind) {
  const live = new Map<IssueSourceObserver, IssueSourceQuery>()
  const stops: IssueSourceQuery[] = []
  const source: IssueSourceAdapter = {
    kind,
    label: kind,
    list: async () => [],
    subscribe(query, observer) {
      live.set(observer, query)
      return () => {
        live.delete(observer)
        stops.push(query)
      }
    },
  }
  return {
    source,
    stops,
    live,
    push(items: UnifiedIssueItem[], projectId?: string) {
      for (const [observer, query] of live) {
        if (!projectId || query.projectId === projectId) observer.next(items)
      }
    },
  }
}

describe("useUnifiedIssues", () => {
  it("reads nothing without a workspace", () => {
    const local = manualSource("local")
    const registry = createIssueSourceRegistry()
    registry.register(local.source)
    const { result } = renderHook(() => useUnifiedIssues(undefined, undefined, registry))
    expect(result.current).toEqual({ items: [], errors: [], ready: false })
    expect(local.live.size).toBe(0)
  })

  it("is not ready until the sources answer, then follows each change", () => {
    const local = manualSource("local")
    const team = manualSource("agent-team")
    const registry = createIssueSourceRegistry()
    registry.register(local.source)
    registry.register(team.source)
    const { result } = renderHook(() => useUnifiedIssues("w1", undefined, registry))
    expect(result.current.ready).toBe(false)

    act(() => {
      local.push([item("local", "a")])
      team.push([])
    })
    expect(result.current.ready).toBe(true)
    expect(result.current.items.map((i) => i.unifiedId)).toEqual(["local:a"])

    // A federated change alone, with no local write, reaches the board.
    act(() => team.push([item("agent-team", "t")]))
    expect(result.current.items.map((i) => i.unifiedId)).toEqual(["agent-team:t", "local:a"])
  })

  it("keeps the same result object between renders with no delivery", () => {
    const local = manualSource("local")
    const registry = createIssueSourceRegistry()
    registry.register(local.source)
    const { result, rerender } = renderHook(() => useUnifiedIssues("w1", undefined, registry))
    act(() => local.push([item("local", "a")]))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("passes the container through, and drops old rows the moment the query changes", () => {
    const local = manualSource("local")
    const registry = createIssueSourceRegistry()
    registry.register(local.source)
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useUnifiedIssues(projectId, "ip-1", registry),
      { initialProps: { projectId: "w1" } }
    )
    expect([...local.live.values()]).toEqual([{ projectId: "w1", issueProjectId: "ip-1" }])
    act(() => local.push([item("local", "old")], "w1"))
    expect(result.current.items).toHaveLength(1)

    rerender({ projectId: "w2" })
    expect(result.current).toEqual({ items: [], errors: [], ready: false })
    expect(local.stops).toEqual([{ projectId: "w1", issueProjectId: "ip-1" }])
    act(() => local.push([item("local", "new")], "w2"))
    expect(result.current.items.map((i) => i.sourceId)).toEqual(["new"])
  })

  it("surfaces failing sources and unsubscribes on unmount", () => {
    const local = manualSource("local")
    const registry = createIssueSourceRegistry()
    registry.register(local.source)
    const boom = new Error("closed")
    registry.register({
      kind: "github",
      label: "GitHub",
      list: async () => [],
      subscribe: (_query, observer) => {
        observer.error(boom)
        return () => {}
      },
    })
    const { result, unmount } = renderHook(() => useUnifiedIssues("w1", undefined, registry))
    act(() => local.push([]))
    expect(result.current.errors).toEqual([{ kind: "github", error: boom }])
    unmount()
    expect(local.live.size).toBe(0)
  })
})
