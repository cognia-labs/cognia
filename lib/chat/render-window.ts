/**
 * How much of a short (document-flow) transcript to mount at once.
 *
 * A conversation under the virtualization threshold (`virtualization-threshold`)
 * renders every row in normal flow — up to 40 markdown messages — and it did so
 * in the very commit that switched to it, on the same frames the switch
 * animation needed. Nobody sees more than a screen of it at that moment.
 *
 * So a flow list opens with enough rows from the foot to fill the viewport
 * about three times over, and reveals the rest a screenful at a time: in idle time
 * right after the switch has settled, at once when the reader scrolls near the
 * top, and all at once when a jump targets an earlier message. The list keeps
 * the reader's place as rows are inserted above (`useStickToBottom`'s prepend
 * anchor). Heights come from the virtualizer's own content estimate, which
 * floors every row at 200px and so over-counts short messages; the list
 * therefore also checks the MEASURED height after mounting and reveals more,
 * before paint, if the window came up short of the viewport.
 */

import type { UIMessage } from "ai"

import { estimateMessageHeight } from "./row-height-estimate"

/** The initial window covers this many viewport heights (by estimate). */
export const INITIAL_WINDOW_SCREENS = 3
/** Each reveal adds at least this many viewport heights of rows. */
export const REVEAL_STEP_SCREENS = 1
/** Never open, or reveal, fewer rows than this. */
export const MIN_WINDOW_ROWS = 8
/** Viewport height assumed when none can be measured (SSR, tests). */
export const FALLBACK_VIEWPORT_PX = 800

/**
 * The index of the first message to mount so that the rows from it to the end
 * fill `screens` viewports. 0 when the whole transcript fits.
 */
export function windowStartFor(
  messages: readonly UIMessage[],
  viewportPx: number,
  screens: number = INITIAL_WINDOW_SCREENS,
  endExclusive: number = messages.length
): number {
  const budget = Math.max(1, viewportPx > 0 ? viewportPx : FALLBACK_VIEWPORT_PX) * screens
  let height = 0
  let rows = 0
  for (let index = endExclusive - 1; index >= 0; index--) {
    const message = messages[index]
    if (message) height += estimateMessageHeight(message)
    rows++
    if (rows >= MIN_WINDOW_ROWS && height >= budget) return index
  }
  return 0
}

/**
 * Where the window starts after one reveal from `currentStart`: another
 * {@link REVEAL_STEP_SCREENS} of rows above it, or 0 when that reaches the top.
 */
export function revealedWindowStart(
  messages: readonly UIMessage[],
  currentStart: number,
  viewportPx: number
): number {
  if (currentStart <= 0) return 0
  return windowStartFor(messages, viewportPx, REVEAL_STEP_SCREENS, currentStart)
}
