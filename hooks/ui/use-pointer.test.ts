/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { usePlatform } from "@/hooks/use-platform"

import { useCoarsePointer, useHasHover, useShowKeyboardHints, useTouchShell } from "./use-pointer"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

interface FakeMql {
  matches: boolean
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fire: () => void
}

/** Installs a matchMedia that answers per-query from `truthy`. */
function installMatchMedia(truthy: Set<string>): Map<string, FakeMql> {
  const mqls = new Map<string, FakeMql>()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string): FakeMql => {
      const cached = mqls.get(query)
      if (cached) return cached
      let listener: (() => void) | null = null
      const mql: FakeMql = {
        matches: truthy.has(query),
        addEventListener: jest.fn((_evt: string, fn: () => void) => {
          listener = fn
        }),
        removeEventListener: jest.fn((_evt: string, fn: () => void) => {
          if (listener === fn) listener = null
        }),
        fire: () => listener?.(),
      }
      mqls.set(query, mql)
      return mql
    }),
  })
  return mqls
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  })
})

describe("useHasHover", () => {
  it("is true on a hover-capable (desktop) device", () => {
    installMatchMedia(new Set(["(hover: hover)"]))
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(true)
  })

  it("is false on a touch device", () => {
    installMatchMedia(new Set(["(pointer: coarse)"]))
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(false)
  })

  it("defaults to true when matchMedia is unavailable (SSR)", () => {
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(true)
  })
})

describe("useCoarsePointer", () => {
  it("is true on a coarse-pointer (touch) device", () => {
    installMatchMedia(new Set(["(pointer: coarse)"]))
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(true)
  })

  it("is false on a fine-pointer (mouse) device and reacts to changes", () => {
    const mqls = installMatchMedia(new Set())
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
    act(() => {
      const mql = mqls.get("(pointer: coarse)")!
      mql.matches = true
      mql.fire()
    })
    expect(result.current).toBe(true)
  })
})

describe("useShowKeyboardHints", () => {
  it("shows hints with a hovering, fine pointer (a keyboard-and-mouse device)", () => {
    installMatchMedia(new Set(["(hover: hover)"]))
    const { result } = renderHook(() => useShowKeyboardHints())
    expect(result.current).toBe(true)
  })

  it("hides hints on a touch device", () => {
    installMatchMedia(new Set(["(pointer: coarse)"]))
    const { result } = renderHook(() => useShowKeyboardHints())
    expect(result.current).toBe(false)
  })

  it("hides hints when the pointer hovers but is coarse (a stylus tablet)", () => {
    installMatchMedia(new Set(["(hover: hover)", "(pointer: coarse)"]))
    const { result } = renderHook(() => useShowKeyboardHints())
    expect(result.current).toBe(false)
  })

  it("renders hints without matchMedia (the SSR default)", () => {
    const { result } = renderHook(() => useShowKeyboardHints())
    expect(result.current).toBe(true)
  })
})

describe("useTouchShell (D2)", () => {
  afterEach(() => (usePlatform as jest.Mock).mockReturnValue("web"))

  it("is on for a touch browser, whatever the runtime", () => {
    installMatchMedia(new Set(["(pointer: coarse)"]))
    const { result } = renderHook(() => useTouchShell())
    expect(result.current).toBe(true)
  })

  it("is off for a mouse, even in a narrow window", () => {
    installMatchMedia(new Set(["(hover: hover)", "(max-width: 767.98px)"]))
    const { result } = renderHook(() => useTouchShell())
    expect(result.current).toBe(false)
  })

  it("is always on in the native shell", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("mobile")
    installMatchMedia(new Set(["(hover: hover)"]))
    const { result } = renderHook(() => useTouchShell())
    expect(result.current).toBe(true)
  })
})
