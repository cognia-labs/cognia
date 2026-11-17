/**
 * One Markdown configuration for chat (D7).
 *
 * Chat draws Markdown with two engines: react-markdown (`MarkdownRenderer`) for
 * finished text and Streamdown for text still arriving (the streaming answer,
 * reasoning, the pet's replies, the skill editor's suggestions). Both used to
 * assemble their plugin lists, URL policy and fence renderers on their own,
 * and the two drifted: the streaming branch had no LaTeX preprocessing, no
 * `diff` fence, no heading ids, and reasoning had no fence renderers at all.
 *
 * This module turns the resolved display knobs (`messageDisplay.markdown`) and
 * the text's trust into everything both engines read; `chat-streamdown-config.ts`
 * derives Streamdown's plugin set from the same object, so react-markdown
 * callers never load Streamdown's fence renderers. React components stay
 * with each engine (`MarkdownRenderer`'s overrides and
 * `createStreamingComponents`), both built on `markdown/shared-components.tsx`.
 *
 * Results are cached by their inputs, so a renderer handed the same knobs gets
 * the same lists and plugin sets: Streamdown re-parses every block when its
 * `plugins` or `rehypePlugins` identity changes.
 */

import type { Options as ReactMarkdownOptions } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import { cjk } from "@streamdown/cjk"

import { resolveChatCodeTheme, type ChatCodeThemePair } from "@/lib/chat/code-theme"
import { DEFAULT_MESSAGE_MARKDOWN_OPTIONS } from "@/lib/chat/message-display"
import { cn } from "@/lib/utils"
import type { MessageMarkdownOptions, MessageMathFontScale } from "@/types/appearance"

import {
  preprocessLatex,
  rehypeMarkdownHeadingIds,
  remarkLimitUntrustedDepth,
} from "./markdown-plugins"
import { rehypeInlineLinks } from "./rehype-inline-links"
import {
  chatMarkdownSanitizeSchema,
  chatMarkdownUrlTransform,
  untrustedMarkdownUrlTransform,
} from "./rendering-policy"

type RemarkPlugins = NonNullable<ReactMarkdownOptions["remarkPlugins"]>
type RehypePlugins = NonNullable<ReactMarkdownOptions["rehypePlugins"]>
type UrlTransform = NonNullable<ReactMarkdownOptions["urlTransform"]>

/** Who wrote the text, which decides what it may do. */
export interface ChatMarkdownTrust {
  /**
   * Written by a third party (an inbound IM message or card): raw HTML is
   * dropped, links are limited to web and mail targets, deep nesting is
   * flattened, and math is off unless {@link untrustedMath}.
   */
  untrusted?: boolean
  /** Keep LaTeX on for untrusted text meant as a document (a shared conversation). */
  untrustedMath?: boolean
}

export interface ChatMarkdownConfig {
  /** The knobs with every default filled in. */
  readonly options: MessageMarkdownOptions
  /** Whether math renders, after trust. */
  readonly math: boolean
  readonly untrusted: boolean
  readonly codeTheme: ChatCodeThemePair
  /** Applied to the source before either engine parses it. */
  readonly preprocess: (content: string) => string
  /** react-markdown (`MarkdownRenderer`). */
  readonly remarkPlugins: RemarkPlugins
  readonly rehypePlugins: RehypePlugins
  /**
   * {@link rehypePlugins} without the heading-id step, for a message drawn as
   * several trees that number their headings through one
   * `createHeadingIdRegistry` instead.
   */
  readonly rehypePluginsForSections: RehypePlugins
  readonly urlTransform: UrlTransform
  /**
   * Typography plus the knobs Streamdown takes only as classes: code soft-wrap
   * and the math scale and alignment (`className` is the one prop Streamdown
   * forwards to a DOM node; see {@link mathScaleClass}).
   */
  readonly className: string
  /** Only the knob classes, for surfaces that keep their own typography. */
  readonly knobClassName: string
}

/**
 * Scale class for KaTeX output Streamdown renders. Keyed by the closed
 * `MESSAGE_MATH_FONT_SCALES` set because a class is the only thing that reaches
 * the DOM there; the default scale needs no rule, so it maps to `undefined`.
 * Pinned against every declared scale by its test, so adding a scale without an
 * `app/globals.css` rule fails instead of rendering at 1x while the finished
 * branch scales.
 */
export function mathScaleClass(scale: MessageMathFontScale | number): string | undefined {
  if (scale === 0.8) return "chat-math-sm"
  if (scale === 1.2) return "chat-math-lg"
  return undefined
}

// CJK's before/after ordering is load-bearing: emphasis parsing runs before
// GFM, while autolink punctuation and CJK strikethrough fixes run after it.
const baseRemarkPlugins: RemarkPlugins = [
  ...cjk.remarkPluginsBefore,
  remarkGfm,
  ...cjk.remarkPluginsAfter,
]
const mathRemarkPlugins: RemarkPlugins = [...baseRemarkPlugins, remarkMath]
const untrustedRemarkPlugins: RemarkPlugins = [...baseRemarkPlugins, remarkLimitUntrustedDepth]
const untrustedMathRemarkPlugins: RemarkPlugins = [...untrustedRemarkPlugins, remarkMath]

// In-app references are linked after sanitization, so their marks survive it.
// Heading ids come last, from the sanitized text.
const finishedSectionRehypePlugins: RehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, chatMarkdownSanitizeSchema],
  rehypeInlineLinks,
]
const finishedRehypePlugins: RehypePlugins = [
  ...finishedSectionRehypePlugins,
  rehypeMarkdownHeadingIds,
]
// Without rehype-raw, react-markdown drops HTML in the source: no element (and
// no allow-listed `style`) from a third party reaches the DOM.
const untrustedSectionRehypePlugins: RehypePlugins = [
  [rehypeSanitize, chatMarkdownSanitizeSchema],
  rehypeInlineLinks,
]
const untrustedRehypePlugins: RehypePlugins = [
  ...untrustedSectionRehypePlugins,
  rehypeMarkdownHeadingIds,
]

const identity = (content: string) => content

const cache = new Map<string, ChatMarkdownConfig>()
const CACHE_LIMIT = 64

function cacheKey(options: MessageMarkdownOptions, trust: Required<ChatMarkdownTrust>): string {
  return [
    options.math,
    options.mermaid,
    options.diff,
    options.charts,
    options.codeLineNumbers,
    options.codeWrap,
    options.mathFontScale,
    options.mathAlign,
    options.mathCopy,
    options.codeTheme,
    options.blockDensity,
    options.blockBorder,
    options.blockHeader,
    options.codeMaxHeight,
    trust.untrusted,
    trust.untrustedMath,
  ].join("|")
}

/**
 * The configuration for these knobs and this trust. `markdown` may be partial
 * (a caller overriding one knob); missing knobs take the chat defaults.
 */
export function resolveChatMarkdownConfig(
  markdown?: Partial<MessageMarkdownOptions>,
  trust: ChatMarkdownTrust = {}
): ChatMarkdownConfig {
  const options: MessageMarkdownOptions = { ...DEFAULT_MESSAGE_MARKDOWN_OPTIONS, ...markdown }
  const resolvedTrust = {
    untrusted: trust.untrusted === true,
    untrustedMath: trust.untrustedMath === true,
  }
  const key = cacheKey(options, resolvedTrust)
  const cached = cache.get(key)
  if (cached) return cached

  // A third party's `$5 and $10` or escaped `\[x\]` is not LaTeX, unless the
  // caller says the text is a document.
  const math = resolvedTrust.untrusted && !resolvedTrust.untrustedMath ? false : options.math
  const knobClassName = cn(
    options.codeWrap && "[&_pre]:whitespace-pre-wrap",
    mathScaleClass(options.mathFontScale),
    options.mathAlign === "left" && "chat-math-left"
  )
  const config: ChatMarkdownConfig = {
    options,
    math,
    untrusted: resolvedTrust.untrusted,
    codeTheme: resolveChatCodeTheme(options.codeTheme),
    preprocess: math ? preprocessLatex : identity,
    remarkPlugins: resolvedTrust.untrusted
      ? math
        ? untrustedMathRemarkPlugins
        : untrustedRemarkPlugins
      : math
        ? mathRemarkPlugins
        : baseRemarkPlugins,
    rehypePlugins: resolvedTrust.untrusted ? untrustedRehypePlugins : finishedRehypePlugins,
    rehypePluginsForSections: resolvedTrust.untrusted
      ? untrustedSectionRehypePlugins
      : finishedSectionRehypePlugins,
    urlTransform: resolvedTrust.untrusted
      ? untrustedMarkdownUrlTransform
      : chatMarkdownUrlTransform,
    className: cn("typeset typeset-chat", knobClassName),
    knobClassName,
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, config)
  return config
}
