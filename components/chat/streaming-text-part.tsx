"use client"

/**
 * `<StreamingTextPart>` — narrow subtree owning Streamdown's `MessageResponse`
 * for the actively-streaming text branch of `MessageRenderer`. Extracted so:
 *
 *   1. Streamdown's own transition remains at a tight boundary while its
 *      block parser reuses the stable prefix of an append-only response.
 *   2. The outer `MessageRenderer` body (header, mentions, avatar, plugin
 *      slots, action bar) stays out of the per-token render path conceptually.
 *      The memo equality on (text, isStreaming) is a no-op when text changes
 *      per token, but pairs with the heavy-block `next/dynamic` lazy-load in
 *      `markdown-renderer.tsx` to keep the streaming subtree minimal. (An
 *      earlier plan mentioned React `<Activity>`; it was never adopted here —
 *      ADR-0127. The per-block `content-visibility` wrapper that used to live
 *      here is gone — ADR-0138; only settled messages skip render now.)
 *
 * Pairs with the non-streaming text branch in `MessageRenderer`, which
 * routes through `<MarkdownRenderer>` for the finalised message.
 */

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react"
import { Block, parseMarkdownIntoBlocks, type AnimateOptions, type BlockProps } from "streamdown"
import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message"
import {
  createSharedMarkdownComponents,
  MarkdownInlineCode,
} from "@/components/chat/markdown/shared-components"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { ChatLink } from "@/components/chat/markdown/chat-link"
import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "./markdown-renderer"
import type { MessageMarkdownOptions, MessageRichControls } from "@/types/appearance"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"
import { resolveChatStreamdownConfig } from "@/components/chat/markdown/chat-streamdown-config"
import {
  createHeadingIdRegistry,
  type HeadingIdRegistry,
  type MarkdownMention,
} from "@/components/chat/markdown/markdown-plugins"
import {
  createIncrementalMarkdownBlockParser,
  type MarkdownBlockParser,
} from "./incremental-markdown-blocks"
import {
  FENCE_THROTTLE_MS,
  inkActive,
  isLargeOpenFence,
  isSettledBlock,
  settledRehypePlugins,
  TAIL_BLOCK_ATTR,
  useThrottledText,
} from "./streaming-block-policy"

interface Props {
  messageId?: string
  text: string
  isStreaming: boolean
  projectRoot?: string | null
  /** Opens a project file a link or code span names, as the finished branch does. */
  onOpenProjectFile?: (target: ProjectFileReference) => void
  richControls?: MessageRichControls
  /** ADR-0127 — resolved `messageDisplay.markdown` knobs (both renderers read them). */
  markdown?: MessageMarkdownOptions
}

interface FinalizedProps {
  text: string
  messageId?: string
  projectRoot?: string | null
  onOpenProjectFile?: (target: ProjectFileReference) => void
  markdown?: MessageMarkdownOptions
  /** Names drawn as `@mentions` (a user's message); see `MarkdownRenderer`. */
  mentions?: readonly MarkdownMention[]
}

/**
 * The message's heading-id registry, read by each streaming block: Streamdown
 * renders every block as its own tree, so a block numbers its headings after
 * the blocks before it (`setup`, `setup-1`), matching the finished renderer.
 */
const StreamingHeadingIdsContext = createContext<HeadingIdRegistry | null>(null)

export const FINALIZED_MARKDOWN_LAZY_THRESHOLD = 64 * 1024
const FINALIZED_BLOCKS_PER_SECTION = 8
const FINALIZED_EAGER_SECTIONS = 3

/**
 * Ink-bleed reveal for the reply being streamed. Each new character fades in
 * from a 6px blur over 90ms on an ease-out cubic, and neighbours start 30ms
 * apart, so text spreads along the line instead of popping in a glyph at a
 * time. Per character rather than per word because CJK has no spaces: a word
 * split would reveal a whole Chinese sentence as one block. The keyframe
 * (`sd-ink`) and the `[data-sd-animate]` rule live in `app/globals.css`.
 * Streamdown only runs the plugin while `isAnimating`, caps how far the
 * cascade may run ahead of a fast stream, and never touches code blocks.
 * Module-level so the memoised `MessageResponse` sees a stable reference.
 */
export const STREAMING_INK_ANIMATION = {
  animation: "ink",
  duration: 90,
  easing: "cubic-bezier(.215,.61,.355,1)",
  sep: "char",
  stagger: 30,
} as const satisfies AnimateOptions

/** A fence opening at the start of any line, allowing CommonMark's ≤3 spaces of
 *  indentation and the extra indentation a list item or blockquote adds. */
const FENCE_LINE = /^[ \t>]*(?:```|~~~)/m

/**
 * Will this markdown block render a `<pre>` that typeset must not restyle?
 *
 * The streaming branch deliberately leaves `code`/`pre` to `@streamdown/code`
 * (see `createStreamingComponents` below), so there is no component override to
 * hang typeset's opt-out marker on — and typeset's element rules are an
 * unbounded descendant match that would otherwise repaint Streamdown's `<pre>`
 * with its own background, padding and font size. The block wrapper is the one
 * seam we own on that path.
 *
 * Matching only blocks that *open* with a fence was not enough: a fence inside
 * a list item or a blockquote, and an indented code block, all render a `<pre>`
 * the finalised `MarkdownRenderer` styles through its own `code`/`pre`
 * overrides. Missing them is exactly the finalise-time jump the streaming
 * parity work set out to remove — the block was typeset-styled while streaming
 * and swapped the instant the turn ended.
 *
 * Indented code is only claimed when the *whole* block is indented. A list
 * whose continuation lines sit at four spaces would otherwise be marked, and
 * losing typeset's rhythm on ordinary prose is the worse error of the two.
 *
 * Exported for tests: the streamdown module is stubbed there, so the predicate
 * cannot be reached through a real block parse.
 */
export function blockRendersCode(content: unknown): boolean {
  if (typeof content !== "string") return false
  if (FENCE_LINE.test(content)) return true
  const lines = content.split("\n").filter((line) => line.trim() !== "")
  return lines.length > 0 && lines.every((line) => /^(?: {4}|\t)/.test(line))
}

/**
 * Per-block wrapper for the STREAMING branch. It exists for one reason: to hang
 * typeset's opt-out on a block that renders a `<pre>` (see
 * {@link blockRendersCode}).
 *
 * It used to also carry `content-visibility: auto` with a
 * `contain-intrinsic-size: auto 160px` placeholder. That is wrong on this path
 * and was a jitter source (ADR-0138): every block of the reply being streamed is
 * on screen, so skipping render buys nothing — but the row IS measured, so each
 * block flipping between rendered and skipped changes the row's height, which
 * re-publishes the virtualizer's offsets, which moves the block, which flips it
 * again. On first render it is worse still: the remembered size replaces the
 * 160px guess, so every block lands with a height correction under the caret.
 *
 * Settled messages keep it — `FinalizedMarkdownSection` above — where blocks
 * genuinely do leave the viewport and their remembered sizes are already true.
 */
/**
 * It also applies the per-block streaming policy (`streaming-block-policy.ts`):
 * a block before the tail renders without its animate plugin, and a large open
 * fence advances on a timer.
 *
 * Exported for tests.
 */
export const StreamingBlock = memo(function StreamingBlock({
  [TAIL_BLOCK_ATTR]: tailIndex,
  ...props
}: BlockProps & { [TAIL_BLOCK_ATTR]?: number }) {
  const headingIds = useContext(StreamingHeadingIdsContext)
  const settled = props.animatePlugin != null && isSettledBlock(props.index, tailIndex)
  const throttle = isLargeOpenFence(props.content, props.isIncomplete)
  const content = useThrottledText(props.content, throttle, FENCE_THROTTLE_MS)
  const ownPlugins = settled
    ? settledRehypePlugins(props.rehypePlugins, props.animatePlugin!)
    : props.rehypePlugins
  // Seeded from the blocks before this one, which rendered first and
  // registered their sources. Stable per (list, seed), so a settled block keeps
  // its props and skips re-rendering while the tail streams.
  headingIds?.setSource(props.index, props.content)
  const rehypePlugins =
    headingIds && ownPlugins ? headingIds.withPlugins(ownPlugins, props.index) : ownPlugins
  const block = settled ? (
    <Block {...props} animatePlugin={null} content={content} rehypePlugins={rehypePlugins} />
  ) : (
    <Block {...props} content={content} rehypePlugins={rehypePlugins} />
  )
  if (!blockRendersCode(props.content)) return block
  return <div className="not-typeset">{block}</div>
})

function FinalizedMarkdownSection({
  content,
  eager,
  messageId,
  projectRoot,
  onOpenProjectFile,
  markdown,
  headingIds,
  mentions,
}: {
  content: string
  eager: boolean
  messageId?: string
  projectRoot?: string | null
  onOpenProjectFile?: (target: ProjectFileReference) => void
  markdown?: MessageMarkdownOptions
  mentions?: readonly MarkdownMention[]
  headingIds: { registry: HeadingIdRegistry; index: number }
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(eager)

  useEffect(() => {
    if (visible || eager) return
    const element = rootRef.current
    if (!element) return
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      { rootMargin: "1200px 0px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [eager, visible])

  return (
    <div
      ref={rootRef}
      data-testid={visible ? "finalized-markdown-section" : "finalized-markdown-placeholder"}
      className="[content-visibility:auto] [contain-intrinsic-size:auto_320px]"
    >
      {visible ? (
        <MarkdownRenderer
          content={content}
          messageId={messageId}
          projectRoot={projectRoot}
          onOpenProjectFile={onOpenProjectFile}
          markdown={markdown}
          headingIds={headingIds}
          mentions={mentions}
          className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        />
      ) : null}
    </div>
  )
}

/** A link reference or footnote definition (`[label]: url`, `[^label]: text`). */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m

/**
 * The sections a long finished reply mounts lazily (each its own Markdown
 * tree), or `null` when it must render as one tree.
 *
 * A tree resolves link references and footnotes only against definitions in
 * itself, so a reply with any definition renders whole. Streamdown's block
 * parser makes the same call (it returns such a text as one block); this does
 * not rely on it. Heading ids are numbered across sections through one
 * registry.
 *
 * Exported for tests.
 */
export function layoutLongText(text: string): string[] | null {
  const blocks = parseMarkdownIntoBlocks(text)
  if (blocks.some((block) => !blockRendersCode(block) && DEFINITION.test(block))) return null
  const sections: string[] = []
  for (let index = 0; index < blocks.length; index += FINALIZED_BLOCKS_PER_SECTION) {
    sections.push(blocks.slice(index, index + FINALIZED_BLOCKS_PER_SECTION).join(""))
  }
  return sections
}

/**
 * Finalized long-form Markdown keeps the authoritative sanitized renderer, but
 * mounts parsed block groups only as they approach the viewport. Heading ids
 * resolve across the whole reply (see {@link layoutLongText}).
 */
export const FinalizedLongTextPart = memo(function FinalizedLongTextPart({
  text,
  messageId,
  projectRoot,
  onOpenProjectFile,
  markdown,
  mentions,
}: FinalizedProps) {
  const layout = useMemo(() => layoutLongText(text), [text])
  // One registry per reply text: each section's headings continue from the
  // sections before it, whichever mounted first.
  const registry = useMemo(() => {
    const created = createHeadingIdRegistry()
    if (layout) created.setSources(layout)
    return created
  }, [layout])
  const slots = useMemo(
    () => layout?.map((_, index) => ({ registry, index })) ?? [],
    [layout, registry]
  )

  if (!layout) {
    return (
      <MarkdownRenderer
        content={text}
        messageId={messageId}
        projectRoot={projectRoot}
        onOpenProjectFile={onOpenProjectFile}
        markdown={markdown}
        mentions={mentions}
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      />
    )
  }

  return layout.map((content, index) => (
    <FinalizedMarkdownSection
      key={`${index}:${content.length}`}
      content={content}
      eager={index < FINALIZED_EAGER_SECTIONS}
      messageId={messageId}
      projectRoot={projectRoot}
      onOpenProjectFile={onOpenProjectFile}
      markdown={markdown}
      headingIds={slots[index]}
      mentions={mentions}
    />
  ))
})

type StreamdownComponents = NonNullable<MessageResponseProps["components"]>

export function createStreamingComponents(
  projectRoot?: string | null,
  isStreaming = false,
  messageId?: string,
  allowPlugins = true,
  onOpenProjectFile?: (target: ProjectFileReference) => void
): StreamdownComponents {
  return {
    // Shared with `MarkdownRenderer` so images, tables, GitHub alerts,
    // `<details>`, `<kbd>` and task lists don't visually re-lay-out the moment
    // the turn finalises and the renderer swaps branches.
    //
    // Two deliberate omissions:
    //   - `code` / `pre` stay with `@streamdown/code` (theme-aligned in
    //     `ai-elements/streamdown-plugins.ts`) so incremental highlighting
    //     survives.
    // Raw HTML is parsed by Streamdown and then constrained by the shared
    // chat sanitization policy supplied to `MessageResponse` below.
    ...createSharedMarkdownComponents({ isStreaming }),
    // Streamdown routes inline code through `inlineCode`, not `code`, so the
    // shared span can be swapped in without touching the highlighted fences.
    inlineCode({ children }) {
      return (
        <MarkdownInlineCode projectRoot={projectRoot} onOpenProjectFile={onOpenProjectFile}>
          {children}
        </MarkdownInlineCode>
      )
    },
    a({ href, children, node: _node, ...props }) {
      return (
        <ChatLink
          href={href}
          projectRoot={projectRoot}
          onOpenProjectFile={onOpenProjectFile}
          messageId={messageId}
          isStreaming={isStreaming}
          allowPlugins={allowPlugins}
          {...props}
        >
          {children}
        </ChatLink>
      )
    },
  }
}

function StreamingTextPartInner({
  messageId,
  text,
  isStreaming,
  projectRoot,
  onOpenProjectFile,
  richControls = "hover",
  markdown,
}: Props) {
  const [parser] = useState<MarkdownBlockParser>(() =>
    createIncrementalMarkdownBlockParser(parseMarkdownIntoBlocks)
  )
  // Its own instance: Streamdown's parser sees the remended text, this one the
  // raw text, and each reuses its own last frame.
  const [tailParser] = useState<MarkdownBlockParser>(() =>
    createIncrementalMarkdownBlockParser(parseMarkdownIntoBlocks)
  )
  const components = useMemo(
    () => createStreamingComponents(projectRoot, isStreaming, messageId, true, onOpenProjectFile),
    [isStreaming, projectRoot, messageId, onOpenProjectFile]
  )
  // One heading-id registry per reply: blocks number their headings in order.
  const [headingIds] = useState<HeadingIdRegistry>(createHeadingIdRegistry)
  // ADR-0127 / D7: the same configuration the finished branch reads — plugin
  // sets with the app's fence renderers (mermaid, inline charts, diffs,
  // A2UI), the sanitize and URL policy, line numbers, and the knobs that reach
  // Streamdown only as classes (soft-wrap, math scale and alignment).
  // `mathCopy` does not cross over: it is the click-to-copy affordance on
  // `<MathInline>`, a React element this branch never mounts.
  const streamdown = resolveChatStreamdownConfig(markdown)
  const { config } = streamdown
  // LaTeX delimiters are normalised before Streamdown sees the text, as the
  // finished branch does; only complete pairs change, so the stable prefix the
  // block parser reuses stays stable.
  const source = useMemo(() => config.preprocess(text), [config, text])
  // ADR-0138 — the caret is Streamdown's own (`caret="block"`), not a hand-rolled
  // element. Ours was a sibling of `<MessageResponse>` inside `MessageContent`'s
  // flex column, so it held a permanent 16px row plus an 8px gap under the reply
  // for the whole turn and vanished in one 24px step when the turn sealed.
  // Streamdown renders `▋` as an `::after` on the last block: inline, at the end
  // of the last text node, contributing no box of its own — and it suppresses
  // itself inside an unclosed code fence, which the sibling span never did.
  //
  // Reduced motion keeps the caret and drops only the blink, so "more is coming"
  // still reads without an animation. `animate-pulse` is a guaranteed Tailwind
  // utility (no dependency on `animate-caret-blink`). It drops the ink reveal
  // too: text then lands sharp the moment it arrives.
  //
  // Ink runs on the trailing block only, and not at all past `INK_REPLY_LIMIT`
  // (D9). The tail index rides to every block as `data-tail-block`; it comes
  // from the preprocessed text before remend, which splits into the same blocks
  // as the remended text Streamdown renders. Were they ever to differ, a block would only lose (or
  // keep) the reveal, never its text.
  const { reduce } = useFlowMotion()
  const ink = inkActive({ text, isStreaming, reduceMotion: reduce })
  const tailIndex = ink ? tailParser(source).length - 1 : undefined
  return (
    <StreamingHeadingIdsContext.Provider value={headingIds}>
      <MessageResponse
        animated={ink ? STREAMING_INK_ANIMATION : false}
        {...{ [TAIL_BLOCK_ATTR]: tailIndex }}
        BlockComponent={StreamingBlock}
        caret="block"
        className={cn(config.className, !reduce && "[&>*:last-child]:after:animate-pulse")}
        components={components}
        controls={richControls === "hidden" ? false : { table: false }}
        data-rich-controls={richControls}
        isAnimating={isStreaming}
        lineNumbers={streamdown.lineNumbers}
        // ADR-0218: the same `codeMaxHeight` cap the finalised block reads.
        codeBlockMaxHeight="var(--rich-code-max-h)"
        mode="streaming"
        parseMarkdownIntoBlocksFn={parser}
        plugins={streamdown.plugins}
        rehypePlugins={streamdown.rehypePlugins}
        urlTransform={streamdown.urlTransform}
      >
        {source}
      </MessageResponse>
    </StreamingHeadingIdsContext.Provider>
  )
}

export const StreamingTextPart = memo(
  StreamingTextPartInner,
  (prev, next) =>
    prev.messageId === next.messageId &&
    prev.text === next.text &&
    prev.isStreaming === next.isStreaming &&
    prev.projectRoot === next.projectRoot &&
    prev.onOpenProjectFile === next.onOpenProjectFile &&
    prev.richControls === next.richControls &&
    prev.markdown === next.markdown
)
StreamingTextPart.displayName = "StreamingTextPart"
