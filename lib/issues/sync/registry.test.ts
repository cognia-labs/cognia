import type { IssueSyncProvider } from "./types"
import {
  IssueSyncRegistry,
  getIssueSyncRegistry,
  registerIssueSyncProvider,
  resetIssueSyncRegistry,
} from "./registry"

function provider(id: string): IssueSyncProvider {
  return {
    id,
    label: id,
    pullFields: [],
    pushFields: [],
    resolveBindings: () => [],
    pull: async () => ({ items: [], notModified: true }),
  }
}

describe("IssueSyncRegistry", () => {
  beforeEach(resetIssueSyncRegistry)

  it("registers, lists in order, replaces on the same id and disposes", () => {
    const registry = new IssueSyncRegistry()
    const first = provider("a")
    const dispose = registry.register(first)
    registry.register(provider("b"))
    expect(registry.list().map((p) => p.id)).toEqual(["a", "b"])

    const replacement = provider("a")
    registry.register(replacement)
    expect(registry.get("a")).toBe(replacement)
    // Disposing the first registration must not remove the replacement.
    dispose()
    expect(registry.get("a")).toBe(replacement)
    registry.unregister("a")
    expect(registry.get("a")).toBeUndefined()
  })

  it("hands out one singleton until reset", () => {
    registerIssueSyncProvider(provider("x"))
    expect(getIssueSyncRegistry().get("x")).toBeDefined()
    resetIssueSyncRegistry()
    expect(getIssueSyncRegistry().get("x")).toBeUndefined()
  })

  it("does not dispose a newer lifetime when the very same provider object is re-registered", () => {
    const registry = new IssueSyncRegistry()
    const same = provider("same")
    const stale = registry.register(same)
    const current = registry.register(same)
    stale()
    expect(registry.get("same")).toBe(same)
    current()
    expect(registry.get("same")).toBeUndefined()
  })

  it("bumps revision, emits changes and aborts the disposed lifetime including on replacement", () => {
    const registry = new IssueSyncRegistry()
    const revisions: number[] = []
    const off = registry.subscribe(() => revisions.push(registry.getRevision()))
    const first = provider("a")
    const dispose = registry.register(first)
    const signal = registry.signal("a", first)
    expect(signal.aborted).toBe(false)
    const replacement = provider("a")
    const disposeReplacement = registry.register(replacement)
    expect(signal.aborted).toBe(true)
    expect(revisions).toEqual([1, 2, 3])
    dispose()
    expect(revisions).toEqual([1, 2, 3])
    disposeReplacement()
    disposeReplacement()
    expect(revisions).toEqual([1, 2, 3, 4])
    off()
    registry.register(provider("b"))
    expect(revisions).toEqual([1, 2, 3, 4])
  })
})
