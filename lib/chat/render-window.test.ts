import type { UIMessage } from "ai"

import {
  FALLBACK_VIEWPORT_PX,
  INITIAL_WINDOW_SCREENS,
  MIN_WINDOW_ROWS,
  revealedWindowStart,
  windowStartFor,
} from "./render-window"
import { estimateMessageHeight } from "./row-height-estimate"

const msg = (i: number, text = "short line"): UIMessage =>
  ({
    id: `m${i}`,
    role: i % 2 ? "assistant" : "user",
    parts: [{ type: "text", text }],
  }) as UIMessage

const many = (count: number, text?: string) => Array.from({ length: count }, (_, i) => msg(i, text))

describe("windowStartFor", () => {
  it("mounts everything when the transcript fits the budget", () => {
    expect(windowStartFor(many(4), 800)).toBe(0)
  })

  it("opens with enough rows from the foot to fill the initial screens", () => {
    const messages = many(40)
    const budget = 800 * INITIAL_WINDOW_SCREENS
    const start = windowStartFor(messages, 800)
    const height = messages.slice(start).reduce((sum, m) => sum + estimateMessageHeight(m), 0)
    expect(start).toBeGreaterThan(0)
    expect(height).toBeGreaterThanOrEqual(budget)
    // One row fewer would not have filled it.
    expect(height - estimateMessageHeight(messages[start]!)).toBeLessThan(budget)
  })

  it("never opens with fewer than the minimum rows, however tall they are", () => {
    const tall = many(30, "word ".repeat(4000))
    expect(30 - windowStartFor(tall, 800)).toBe(MIN_WINDOW_ROWS)
  })

  it("falls back to a nominal viewport when none was measured", () => {
    const messages = many(40)
    expect(windowStartFor(messages, 0)).toBe(windowStartFor(messages, FALLBACK_VIEWPORT_PX))
  })
})

describe("revealedWindowStart", () => {
  it("adds about one viewport of rows above the current start", () => {
    const messages = many(40)
    const start = windowStartFor(messages, 800)
    const next = revealedWindowStart(messages, start, 800)
    expect(next).toBeLessThan(start)
    const added = messages.slice(next, start).reduce((sum, m) => sum + estimateMessageHeight(m), 0)
    expect(added).toBeGreaterThanOrEqual(800)
  })

  it("reaches and stays at the top", () => {
    const messages = many(10)
    expect(revealedWindowStart(messages, 3, 800)).toBe(0)
    expect(revealedWindowStart(messages, 0, 800)).toBe(0)
  })
})
