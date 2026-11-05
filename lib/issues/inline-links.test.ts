import {
  findInlineLinks,
  getInlineLinkKind,
  getInlineLinksRevision,
  resolveInlineLinkHref,
} from "@/lib/chat/inline-links"
import { installIssueInlineLinks, ISSUE_INLINE_LINK_KIND } from "./inline-links"
import type { IssueProjectKeysStore } from "./project-keys"

function fakeStores(initial: Record<string, string[]>) {
  const keys = new Map(Object.entries(initial).map(([id, list]) => [id, new Set(list)]))
  const listeners = new Map<string, Set<() => void>>()
  const storeFor = (projectId: string | null): IssueProjectKeysStore => ({
    subscribe(listener) {
      const id = projectId ?? ""
      if (!listeners.has(id)) listeners.set(id, new Set())
      listeners.get(id)!.add(listener)
      return () => listeners.get(id)!.delete(listener)
    },
    getSnapshot: () => keys.get(projectId ?? "") ?? new Set(),
  })
  return {
    storeFor,
    set(projectId: string, list: string[]) {
      keys.set(projectId, new Set(list))
      for (const listener of listeners.get(projectId) ?? []) listener()
    },
    listenerCount: (projectId: string) => listeners.get(projectId)?.size ?? 0,
  }
}

function fakeWorkspace(initial: string | null) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    current: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    switchTo(next: string | null) {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

describe("installIssueInlineLinks", () => {
  it("registers identifier syntax and the exact in-app address", () => {
    const stores = fakeStores({ w1: ["MERC"] })
    const dispose = installIssueInlineLinks(fakeWorkspace("w1"), stores.storeFor)
    try {
      expect(findInlineLinks("MERC-12 and MERC-0").map((match) => match.text)).toEqual(["MERC-12"])
      const kind = getInlineLinkKind(ISSUE_INLINE_LINK_KIND)!
      expect(kind.href("MERC-12")).toBe("/issues?identifier=MERC-12")
      expect(resolveInlineLinkHref("/issues?identifier=MERC-12")?.text).toBe("MERC-12")
      expect(kind.accepts("MERC-12")).toBe(true)
      expect(kind.accepts("ABC-1")).toBe(false)
    } finally {
      dispose()
    }
    expect(getInlineLinkKind(ISSUE_INLINE_LINK_KIND)).toBeUndefined()
  })

  it("re-checks drawn links when the workspace's keys change", () => {
    const stores = fakeStores({ w1: [] })
    const dispose = installIssueInlineLinks(fakeWorkspace("w1"), stores.storeFor)
    const kind = getInlineLinkKind(ISSUE_INLINE_LINK_KIND)!
    const before = getInlineLinksRevision()
    expect(kind.accepts("MERC-1")).toBe(false)
    stores.set("w1", ["MERC"])
    expect(getInlineLinksRevision()).toBeGreaterThan(before)
    expect(kind.accepts("MERC-1")).toBe(true)
    dispose()
    expect(stores.listenerCount("w1")).toBe(0)
  })

  it("follows a workspace switch and stops hearing the old one", () => {
    const stores = fakeStores({ w1: ["MERC"], w2: ["COG"] })
    const workspace = fakeWorkspace("w1")
    const dispose = installIssueInlineLinks(workspace, stores.storeFor)
    const kind = getInlineLinkKind(ISSUE_INLINE_LINK_KIND)!
    const before = getInlineLinksRevision()
    workspace.switchTo("w2")
    expect(getInlineLinksRevision()).toBeGreaterThan(before)
    expect(kind.accepts("MERC-1")).toBe(false)
    expect(kind.accepts("COG-1")).toBe(true)
    expect(stores.listenerCount("w1")).toBe(0)
    expect(stores.listenerCount("w2")).toBe(1)
    const settled = getInlineLinksRevision()
    workspace.switchTo("w2")
    expect(getInlineLinksRevision()).toBe(settled)
    dispose()
  })
})
