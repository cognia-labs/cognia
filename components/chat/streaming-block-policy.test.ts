import { act, renderHook } from "@testing-library/react"

import {
  FENCE_THROTTLE_MS,
  INK_REPLY_LIMIT,
  inkActive,
  isLargeOpenFence,
  isSettledBlock,
  LARGE_FENCE_CHARS,
  settledRehypePlugins,
  useThrottledText,
} from "./streaming-block-policy"

describe("inkActive", () => {
  it("runs while a reply streams, up to the length limit", () => {
    const base = { isStreaming: true, reduceMotion: false }
    expect(inkActive({ ...base, text: "a".repeat(INK_REPLY_LIMIT) })).toBe(true)
    expect(inkActive({ ...base, text: "a".repeat(INK_REPLY_LIMIT + 1) })).toBe(false)
  })

  it("is off under reduced motion and once the reply stops streaming", () => {
    expect(inkActive({ text: "a", isStreaming: true, reduceMotion: true })).toBe(false)
    expect(inkActive({ text: "a", isStreaming: false, reduceMotion: false })).toBe(false)
  })
})

describe("isSettledBlock", () => {
  it("settles every block before the tail and nothing without a tail index", () => {
    expect(isSettledBlock(0, 2)).toBe(true)
    expect(isSettledBlock(2, 2)).toBe(false)
    // The raw text may split into fewer blocks than the remended one.
    expect(isSettledBlock(3, 2)).toBe(false)
    expect(isSettledBlock(0, undefined)).toBe(false)
    expect(isSettledBlock(0, "2")).toBe(false)
  })
})

describe("settledRehypePlugins", () => {
  const harden = () => undefined
  const animate = { rehypePlugin: () => undefined } as never

  it("drops the animate plugin and keeps one list per block", () => {
    const list = [harden, (animate as { rehypePlugin: () => undefined }).rehypePlugin]
    const stripped = settledRehypePlugins(list, animate)
    expect(stripped).toEqual([harden])
    // `Block` compares the list by identity: the same input yields the same list.
    expect(settledRehypePlugins(list, animate)).toBe(stripped)
    expect(settledRehypePlugins(undefined, animate)).toBeUndefined()
  })
})

describe("isLargeOpenFence", () => {
  it("only claims an incomplete fence past the size limit", () => {
    const large = "x".repeat(LARGE_FENCE_CHARS + 1)
    expect(isLargeOpenFence(large, true)).toBe(true)
    expect(isLargeOpenFence(large, false)).toBe(false)
    expect(isLargeOpenFence("x".repeat(LARGE_FENCE_CHARS), true)).toBe(false)
    expect(isLargeOpenFence(undefined, true)).toBe(false)
  })
})

describe("useThrottledText", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("passes the text through while inactive", () => {
    const { result, rerender } = renderHook(({ text }) => useThrottledText(text, false, 200), {
      initialProps: { text: "a" },
    })
    rerender({ text: "ab" })
    expect(result.current).toBe("ab")
  })

  it("advances at most once per interval while active, and catches up on the trailing edge", () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledText(text, active, FENCE_THROTTLE_MS),
      { initialProps: { text: "a", active: true } }
    )
    act(() => jest.advanceTimersByTime(0))
    expect(result.current).toBe("a")

    rerender({ text: "ab", active: true })
    rerender({ text: "abc", active: true })
    expect(result.current).toBe("a")

    act(() => jest.advanceTimersByTime(FENCE_THROTTLE_MS - 1))
    expect(result.current).toBe("a")
    act(() => jest.advanceTimersByTime(1))
    expect(result.current).toBe("abc")

    // No new text: no further updates are scheduled.
    expect(jest.getTimerCount()).toBe(0)
  })

  it("shows the full text the moment it stops being active", () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledText(text, active, FENCE_THROTTLE_MS),
      { initialProps: { text: "a", active: true } }
    )
    act(() => jest.advanceTimersByTime(0))
    rerender({ text: "abc", active: true })
    expect(result.current).toBe("a")

    rerender({ text: "abcd", active: false })
    expect(result.current).toBe("abcd")
    // The held text is dropped, so a later activation starts from the current text.
    act(() => jest.advanceTimersByTime(0))
    rerender({ text: "abcde", active: true })
    expect(result.current).toBe("abcde")
  })
})
