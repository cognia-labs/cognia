import { act, renderHook } from "@testing-library/react"

import { useTitleBarTier } from "./use-title-bar-tier"

/** A viewport `width` px wide, answering `max-width` queries like a browser. */
function installViewport(initialWidth: number) {
  let width = initialWidth
  const listeners = new Set<() => void>()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const max = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Infinity)
      return {
        get matches() {
          return width <= max
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      }
    },
  })
  return {
    resize(next: number) {
      width = next
      listeners.forEach((cb) => cb())
    },
    listeners,
  }
}

const original = window.matchMedia
afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: original,
  })
})

test.each([
  [700, "compact"],
  [900, "medium"],
  [1100, "regular"],
  [1600, "wide"],
])("a %ipx window is %s", (width, tier) => {
  installViewport(width)
  expect(renderHook(() => useTitleBarTier()).result.current).toBe(tier)
})

test("follows the window as it resizes", () => {
  const viewport = installViewport(1600)
  const { result } = renderHook(() => useTitleBarTier())
  act(() => viewport.resize(900))
  expect(result.current).toBe("medium")
})

test("stops listening on unmount", () => {
  const viewport = installViewport(1600)
  const { unmount } = renderHook(() => useTitleBarTier())
  expect(viewport.listeners.size).toBeGreaterThan(0)
  unmount()
  expect(viewport.listeners.size).toBe(0)
})

test("is wide where matchMedia is missing", () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  })
  expect(renderHook(() => useTitleBarTier()).result.current).toBe("wide")
})
