/** @jest-environment jsdom */
import {
  documentTabKey,
  artifactTabKey,
  orderDockTabs,
  pageTabKey,
  panelTabKey,
  parseDockTabKey,
  rememberedDockFor,
  selectActivePageTab,
  selectPageTabs,
  useDockTabsStore,
  type DockPageTab,
  type DockTabKey,
} from "./dock-tabs-store"
import {
  CONTEXT_WORKBENCH_LAYOUT_LIMIT,
  CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS,
} from "@/stores/context-workbench/context-workbench-store"

it("parses document keys explicitly and preserves only present documents in stored order", () => {
  const doc = documentTabKey("d1")
  expect(parseDockTabKey(doc)).toEqual({ kind: "doc", docTabId: "d1" })
  expect(
    orderDockTabs(["panel:browser", doc, "artifact:a"], ["panel:browser", "artifact:a"])
  ).toEqual(["panel:browser", "artifact:a"])
  expect(
    orderDockTabs(["panel:browser", doc, "artifact:a"], [doc, "artifact:a", "panel:browser"])
  ).toEqual(["panel:browser", doc, "artifact:a"])
})

const A = artifactTabKey("a1")
const B = artifactTabKey("a2")
const P = panelTabKey("browser")
const N = panelTabKey("new-tab")

describe("conversation routing memory", () => {
  it("consumes only the matching request and keeps other conversations queued (B09)", () => {
    const store = useDockTabsStore.getState()
    store.queueBrowserRequest("a", { url: "https://a.example/", backend: "embedded" })
    const first = useDockTabsStore.getState().bySession.a.pendingBrowserRequests![0]
    store.queueBrowserRequest("b", { url: "https://b.example/", backend: "remote" })
    store.queueBrowserRequest("a", { url: "https://new.example/", backend: "local-chromium" })
    expect(
      useDockTabsStore.getState().bySession.a.pendingBrowserRequests?.map((request) => request.url)
    ).toEqual(["https://a.example/", "https://new.example/"])
    store.consumeBrowserRequest("a", "stale-request")
    expect(useDockTabsStore.getState().bySession.a.pendingBrowserRequests).toHaveLength(2)
    store.consumeBrowserRequest("a", first.id)
    const latest = useDockTabsStore.getState().bySession.a.pendingBrowserRequests![0]
    expect(latest.url).toBe("https://new.example/")
    store.consumeBrowserRequest("a", latest.id)
    expect(useDockTabsStore.getState().bySession.a.pendingBrowserRequests).toEqual([])
    expect(useDockTabsStore.getState().bySession.b.pendingBrowserRequests?.[0]?.backend).toBe(
      "remote"
    )
  })

  it("keeps review destinations and attention per conversation at runtime only (B10/DG06)", () => {
    const store = useDockTabsStore.getState()
    store.setReviewDestination("a", {
      id: "review-1",
      kind: "review",
      sessionId: "a",
      rootPath: "/a",
      scope: { scope: "commit", commitSha: "abc" },
    })
    store.setReviewAttention("a", true)
    store.queueBrowserRequest("a", { url: "https://a.example/", backend: "embedded" })
    store.setReviewAttention("b", true)
    store.setReviewAttention("b", false)
    expect(useDockTabsStore.getState().bySession.a.reviewAttention).toBe(true)
    const persisted = useDockTabsStore.persist.getOptions().partialize!(
      useDockTabsStore.getState()
    ) as { bySession: Record<string, Record<string, unknown>> }
    expect(persisted.bySession.a.pendingBrowserRequests).toBeUndefined()
    expect(persisted.bySession.a.reviewDestination).toBeUndefined()
    expect(persisted.bySession.a.reviewAttention).toBeUndefined()
    expect(useDockTabsStore.getState().bySession.a.reviewDestination?.scope).toEqual({
      scope: "commit",
      commitSha: "abc",
    })
    store.setReviewDestination("a", null)
    expect(useDockTabsStore.getState().bySession.a.reviewDestination).toBeNull()
  })

  it.each([1, 2])(
    "discards review state persisted by older builds at version %s",
    async (version) => {
      localStorage.setItem(
        "cognia-dock-tabs-v1",
        JSON.stringify({
          version,
          state: {
            bySession: {
              a: {
                order: [P],
                lastUsedAt: Date.now(),
                reviewAttention: true,
                reviewDestination: { id: "old", kind: "review", sessionId: "a", rootPath: "/old" },
              },
            },
          },
        })
      )
      await useDockTabsStore.persist.rehydrate()
      const entry = useDockTabsStore.getState().bySession.a
      expect(entry.order).toEqual([P])
      expect(entry.reviewDestination).toBeUndefined()
      expect(entry.reviewAttention).toBeUndefined()
    }
  )
})

beforeEach(() => {
  window.localStorage.clear()
  useDockTabsStore.setState({ bySession: {} })
})

describe("tab keys", () => {
  it("round-trips every kind", () => {
    expect(parseDockTabKey(P)).toEqual({ kind: "panel", panelId: "browser" })
    expect(parseDockTabKey(pageTabKey("pt-1"))).toEqual({ kind: "page", tabId: "pt-1" })
    expect(parseDockTabKey(A)).toEqual({ kind: "artifact", artifactId: "a1" })
    // An artifact id may itself contain a colon.
    expect(parseDockTabKey(artifactTabKey("doc:1"))).toEqual({
      kind: "artifact",
      artifactId: "doc:1",
    })
  })
})

describe("orderDockTabs", () => {
  it("keeps the arrival order when nothing was arranged", () => {
    expect(orderDockTabs(undefined, [P, A, B])).toEqual([P, A, B])
  })

  it("keeps arranged tabs in place, appends newcomers and drops the gone", () => {
    expect(orderDockTabs([B, N, A], [A, B, P])).toEqual([B, A, P])
  })
})

describe("moveTab", () => {
  it("stores the whole strip as drawn, so unarranged tabs stay where they were", () => {
    const strip: DockTabKey[] = [P, A, B]
    useDockTabsStore.getState().moveTab("s1", strip, B, 0)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([B, P, A])
  })

  it("ignores a move to the same place or of a tab not on the strip", () => {
    const before = useDockTabsStore.getState()
    before.moveTab("s1", [P, A], P, 0)
    before.moveTab("s1", [P, A], B, 1)
    expect(useDockTabsStore.getState()).toBe(before)
  })

  it("clamps the target into the strip", () => {
    useDockTabsStore.getState().moveTab("s1", [P, A, B], P, 99)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([A, B, P])
  })
})

describe("replaceTab", () => {
  it("puts the tool where the New Tab page was", () => {
    useDockTabsStore.getState().replaceTab("s1", [A, N, B], N, P)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([A, P, B])
  })

  it("leaves a tool already on the strip in its place", () => {
    useDockTabsStore.getState().replaceTab("s1", [P, A, N], N, P)
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([P, A])
  })

  it("ignores a tab that is not on the strip", () => {
    const before = useDockTabsStore.getState()
    before.replaceTab("s1", [A], N, P)
    expect(useDockTabsStore.getState()).toBe(before)
  })
})

describe("rememberDock", () => {
  it("remembers the dock per conversation", () => {
    useDockTabsStore.getState().rememberDock("s1", { open: true, dismissed: false })
    useDockTabsStore.getState().rememberDock("s2", { open: false, dismissed: true })
    expect(rememberedDockFor("s1")).toEqual({ open: true, dismissed: false })
    expect(rememberedDockFor("s2")).toEqual({ open: false, dismissed: true })
    expect(rememberedDockFor("s3")).toBeNull()
    expect(rememberedDockFor(null)).toBeNull()
  })

  it("does not churn on an unchanged dock", () => {
    useDockTabsStore.getState().rememberDock("s1", { open: true, dismissed: false })
    const before = useDockTabsStore.getState()
    before.rememberDock("s1", { open: true, dismissed: false })
    expect(useDockTabsStore.getState()).toBe(before)
  })

  it("keeps the arrangement when the dock is remembered, and vice versa", () => {
    useDockTabsStore.getState().moveTab("s1", [P, A], A, 0)
    useDockTabsStore.getState().rememberDock("s1", { open: false, dismissed: false })
    expect(useDockTabsStore.getState().bySession.s1).toMatchObject({
      order: [A, P],
      dock: { open: false, dismissed: false },
    })
  })
})

function page(id: string, url = `https://${id}.test/`): DockPageTab {
  return { id, url, title: "", engine: "auto" }
}

describe("page tabs", () => {
  it.each(["chrome-error://chromewebdata/", "https://chrome-error//chromewebdata/"])(
    "keeps the last real address when the runtime reports %s",
    (url) => {
      const store = useDockTabsStore.getState()
      store.addPageTab("s1", page("a", "http://localhost:8765/spa"))
      store.updatePageTab("s1", "a", { url, title: "Error" })
      expect(selectActivePageTab(useDockTabsStore.getState(), "s1")).toEqual(
        page("a", "http://localhost:8765/spa")
      )
    }
  )
  it("adds a tab, showing the first one opened", () => {
    const store = useDockTabsStore.getState()
    store.addPageTab("s1", page("a"))
    store.addPageTab("s1", page("b"))
    const state = useDockTabsStore.getState()
    expect(selectPageTabs(state, "s1").map((tab) => tab.id)).toEqual(["a", "b"])
    expect(selectActivePageTab(state, "s1")?.id).toBe("a")
    store.addPageTab("s1", page("c"), { activate: true })
    expect(selectActivePageTab(useDockTabsStore.getState(), "s1")?.id).toBe("c")
  })

  it("puts a page where the New Tab page was", () => {
    useDockTabsStore.getState().addPageTab("s1", page("a"), {
      replacing: N,
      currentOrder: [A, N, B],
    })
    expect(useDockTabsStore.getState().bySession.s1.order).toEqual([A, pageTabKey("a"), B])
  })

  it("updates a tab only when something changed", () => {
    const store = useDockTabsStore.getState()
    store.addPageTab("s1", page("a"))
    const before = useDockTabsStore.getState().bySession
    store.updatePageTab("s1", "a", { url: "https://a.test/" })
    expect(useDockTabsStore.getState().bySession).toBe(before)
    store.updatePageTab("s1", "a", { title: "A", engine: "embedded" })
    expect(selectPageTabs(useDockTabsStore.getState(), "s1")[0]).toMatchObject({
      title: "A",
      engine: "embedded",
    })
    store.updatePageTab("s1", "missing", { title: "x" })
    expect(selectPageTabs(useDockTabsStore.getState(), "s1")).toHaveLength(1)
  })

  it("closes a tab, handing the panel to the most recently opened one left", () => {
    const store = useDockTabsStore.getState()
    store.addPageTab("s1", page("a"))
    store.addPageTab("s1", page("b"))
    store.addPageTab("s1", page("c"), { activate: true })
    store.moveTab("s1", [pageTabKey("a"), pageTabKey("b"), pageTabKey("c")], pageTabKey("c"), 0)
    store.removePageTab("s1", "c")
    const entry = useDockTabsStore.getState().bySession.s1
    expect(entry.activePageTabId).toBe("b")
    expect(entry.order).toEqual([pageTabKey("a"), pageTabKey("b")])
    store.removePageTab("s1", "a")
    store.removePageTab("s1", "b")
    expect(useDockTabsStore.getState().bySession.s1.activePageTabId).toBeNull()
  })

  it("shows only a tab the conversation has", () => {
    const store = useDockTabsStore.getState()
    store.addPageTab("s1", page("a"))
    store.setActivePageTab("s1", "nope")
    expect(selectActivePageTab(useDockTabsStore.getState(), "s1")?.id).toBe("a")
    store.setActivePageTab("s1", null)
    expect(selectActivePageTab(useDockTabsStore.getState(), "s1")).toBeNull()
    expect(selectPageTabs(useDockTabsStore.getState(), "other")).toEqual([])
  })
})

describe("persistence", () => {
  it("keeps the bootstrap token for navigation but omits it from persisted tabs", () => {
    const url = "http://p-grant.localhost:42000/__cognia_bootstrap#capability-secret"
    useDockTabsStore.getState().addPageTab("s1", page("a", url))
    expect(selectActivePageTab(useDockTabsStore.getState(), "s1")?.url).toBe(url)
    const saved = window.localStorage.getItem("cognia-dock-tabs-v1") ?? ""
    expect(saved).not.toContain("capability-secret")
    expect(saved).not.toContain("__cognia_bootstrap")
  })

  it("restores a previously corrupted address as New Tab without losing the tab or its engine", async () => {
    window.localStorage.setItem(
      "cognia-dock-tabs-v1",
      JSON.stringify({
        version: 2,
        state: {
          bySession: {
            s1: {
              order: [pageTabKey("a")],
              activePageTabId: "a",
              lastUsedAt: Date.now(),
              pages: [
                {
                  ...page("a", "https://chrome-error//chromewebdata/"),
                  title: "Error",
                  engine: "remote",
                },
              ],
            },
          },
        },
      })
    )
    await useDockTabsStore.persist.rehydrate()
    expect(selectActivePageTab(useDockTabsStore.getState(), "s1")).toEqual({
      ...page("a", ""),
      engine: "remote",
    })
  })
  it("reads a version-1 entry as one with no page tabs", async () => {
    window.localStorage.setItem(
      "cognia-dock-tabs-v1",
      JSON.stringify({
        version: 1,
        state: {
          bySession: {
            s1: { order: [A], dock: { open: true, dismissed: false }, lastUsedAt: Date.now() },
          },
        },
      })
    )
    await useDockTabsStore.persist.rehydrate()
    expect(useDockTabsStore.getState().bySession.s1).toMatchObject({
      order: [A],
      pages: [],
      activePageTabId: null,
    })
  })

  it("remembers page tabs across a reload", async () => {
    useDockTabsStore.getState().addPageTab("s1", page("a", "http://localhost:3000/"))
    const saved = window.localStorage.getItem("cognia-dock-tabs-v1")
    useDockTabsStore.setState({ bySession: {} })
    window.localStorage.setItem("cognia-dock-tabs-v1", saved ?? "")
    await useDockTabsStore.persist.rehydrate()
    expect(selectActivePageTab(useDockTabsStore.getState(), "s1")).toEqual(
      page("a", "http://localhost:3000/")
    )
  })

  it("persists the memory and forgets it with the workbench's retention", () => {
    const now = Date.now()
    const entries = Object.fromEntries(
      Array.from({ length: CONTEXT_WORKBENCH_LAYOUT_LIMIT + 5 }, (_, index) => [
        `s${index}`,
        {
          order: [],
          dock: { open: true, dismissed: false },
          pages: [],
          activePageTabId: null,
          lastUsedAt: now - index,
        },
      ])
    )
    useDockTabsStore.setState({
      bySession: {
        ...entries,
        stale: {
          order: [],
          dock: { open: true, dismissed: false },
          pages: [],
          activePageTabId: null,
          lastUsedAt: now - CONTEXT_WORKBENCH_LAYOUT_MAX_AGE_MS - 1,
        },
      },
    })
    useDockTabsStore.getState().rememberDock("fresh", { open: false, dismissed: true })
    const raw = JSON.parse(window.localStorage.getItem("cognia-dock-tabs-v1") ?? "{}") as {
      state: { bySession: Record<string, unknown> }
    }
    const kept = Object.keys(raw.state.bySession)
    expect(kept).toHaveLength(CONTEXT_WORKBENCH_LAYOUT_LIMIT)
    expect(kept).toContain("fresh")
    expect(kept).not.toContain("stale")
  })
})

it("remembers the selected comparison independently for each conversation", () => {
  useDockTabsStore.getState().setBestOfNGroup("s1", "g1")
  useDockTabsStore.getState().setBestOfNGroup("s2", "g2")
  useDockTabsStore.getState().setBestOfNGroup("s1", "g3")
  expect(useDockTabsStore.getState().bySession.s1.bestOfNGroupId).toBe("g3")
  expect(useDockTabsStore.getState().bySession.s2.bestOfNGroupId).toBe("g2")
})
