/**
 * What each block of the reply being streamed pays for (chat-surface overhaul,
 * D8 and D9). `StreamingTextPart` and its block wrapper read these.
 *
 * - Ink runs on the trailing block only. Streamdown hands every block its own
 *   animate plugin for as long as the reply streams, so a settled block kept
 *   one `<span>` per character until the turn sealed: a 50 KB reply streamed
 *   4.4 MB of DOM. A block that is no longer last drops the plugin and renders
 *   plain text once.
 * - Ink is off for long replies, where the reveal is no longer what the reader
 *   is watching.
 * - An open fence past {@link LARGE_FENCE_CHARS} is re-highlighted at most every
 *   {@link FENCE_THROTTLE_MS}: `@streamdown/code` does not cache an incomplete
 *   fence, so each delta re-tokenized the whole block.
 */

import { useEffect, useState } from "react"
import type { BlockProps } from "streamdown"

/**
 * Index of the reply's last block, passed to `MessageResponse` and from there
 * by Streamdown to every block (it forwards `data-*` props to each one). Blocks
 * before it are settled.
 */
export const TAIL_BLOCK_ATTR = "data-tail-block"

/** Ink stops once the streamed reply passes this many characters. */
export const INK_REPLY_LIMIT = 12_000

/** An open fence longer than this is highlighted on a timer, not per delta. */
export const LARGE_FENCE_CHARS = 4_000

/** How often a large open fence's content advances. */
export const FENCE_THROTTLE_MS = 200

/** Does the reply being streamed still get the ink reveal? */
export function inkActive({
  text,
  isStreaming,
  reduceMotion,
}: {
  text: string
  isStreaming: boolean
  reduceMotion: boolean
}): boolean {
  return isStreaming && !reduceMotion && text.length <= INK_REPLY_LIMIT
}

/** A block is settled once it sits before the tail. No tail index: nothing is. */
export function isSettledBlock(index: number, tailIndex: unknown): boolean {
  return typeof tailIndex === "number" && index < tailIndex
}

type RehypePlugins = BlockProps["rehypePlugins"]
type AnimatePlugin = NonNullable<BlockProps["animatePlugin"]>

const withoutAnimate = new WeakMap<object, RehypePlugins>()

/**
 * The block's rehype list without its animate plugin. Cached per list: the
 * list Streamdown passes is stable per block, and a new array on every render
 * would defeat `Block`'s memo, which compares it by identity.
 */
export function settledRehypePlugins(
  rehypePlugins: RehypePlugins,
  animatePlugin: AnimatePlugin
): RehypePlugins {
  if (!rehypePlugins) return rehypePlugins
  const cached = withoutAnimate.get(rehypePlugins)
  if (cached) return cached
  const stripped = rehypePlugins.filter((plugin) => plugin !== animatePlugin.rehypePlugin)
  withoutAnimate.set(rehypePlugins, stripped)
  return stripped
}

/** Is this block an open fence large enough to throttle? */
export function isLargeOpenFence(content: unknown, isIncomplete: boolean | undefined): boolean {
  return isIncomplete === true && typeof content === "string" && content.length > LARGE_FENCE_CHARS
}

/**
 * `text` while `active` is false; while it is true, the latest text at most
 * once per `intervalMs` (leading and trailing), so a fence that keeps growing
 * still advances.
 */
export function useThrottledText(text: string, active: boolean, intervalMs: number): string {
  const [held, setHeld] = useState<{ text: string; at: number } | null>(null)

  useEffect(() => {
    if (!active) {
      if (!held) return
      // Drop the held text so a later activation does not show it.
      const timer = setTimeout(() => setHeld(null), 0)
      return () => clearTimeout(timer)
    }
    if (held?.text === text) return
    const wait = held ? Math.max(0, held.at + intervalMs - Date.now()) : 0
    const timer = setTimeout(() => setHeld({ text, at: Date.now() }), wait)
    return () => clearTimeout(timer)
  }, [active, held, intervalMs, text])

  return active && held ? held.text : text
}
