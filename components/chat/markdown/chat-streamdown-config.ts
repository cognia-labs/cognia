/**
 * Streamdown's half of the chat Markdown configuration (D7), derived from the
 * same resolved object `MarkdownRenderer` reads: the plugin set for the knobs
 * with the app's fence renderers (mermaid, inline charts, diffs, A2UI), the
 * sanitize and URL policy, and line numbers. Kept apart from
 * `chat-markdown-config.ts` so the react-markdown branch does not load
 * Streamdown's renderers.
 *
 * Streamdown surfaces only render trusted text; untrusted text goes through
 * `MarkdownRenderer`.
 */

import { createMathPlugin } from "@streamdown/math"
import type { PluginConfig, StreamdownProps } from "streamdown"

import { selectStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import type { MessageMarkdownOptions } from "@/types/appearance"

import { resolveChatMarkdownConfig, type ChatMarkdownConfig } from "./chat-markdown-config"
import { chatMarkdownUrlTransform, chatStreamdownRehypePlugins } from "./rendering-policy"
import { withStreamingFenceRenderers } from "./streaming-fence-renderers"

export interface ChatStreamdownConfig {
  readonly config: ChatMarkdownConfig
  readonly plugins: PluginConfig
  /**
   * Heading ids are added per block by the streaming branch (one Streamdown
   * block is one tree; see `createHeadingIdRegistry`), so they are not here.
   */
  readonly rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]>
  readonly urlTransform: NonNullable<StreamdownProps["urlTransform"]>
  readonly lineNumbers: boolean
}

/**
 * Streamdown's math plugin with single-dollar inline math, as remark-math reads
 * it in the finished branch. The stock plugin turns it off, so `$x^2$` (and
 * `\(x^2\)`, which `preprocessLatex` rewrites to it) stayed text while a reply
 * streamed and became math the moment it finished.
 */
export const chatStreamdownMath = createMathPlugin({ singleDollarTextMath: true })

const derived = new WeakMap<ChatMarkdownConfig, ChatStreamdownConfig>()

const withMath = new WeakMap<PluginConfig, PluginConfig>()

/** The selected set with the chat math plugin in place of the stock one; stable per set. */
function withChatMath(plugins: PluginConfig): PluginConfig {
  if (!plugins.math) return plugins
  let swapped = withMath.get(plugins)
  if (!swapped) {
    swapped = { ...plugins, math: chatStreamdownMath }
    withMath.set(plugins, swapped)
  }
  return swapped
}

export function resolveChatStreamdownConfig(
  markdown?: Partial<MessageMarkdownOptions>
): ChatStreamdownConfig {
  const config = resolveChatMarkdownConfig(markdown)
  const cached = derived.get(config)
  if (cached) return cached
  const { options } = config
  const streamdown: ChatStreamdownConfig = {
    config,
    // The fences the finished branch draws with its own blocks render through
    // the same components while streaming (ADR-0218).
    plugins: withStreamingFenceRenderers(
      withChatMath(
        selectStreamdownPlugins({
          math: config.math,
          mermaid: options.mermaid,
          codeTheme: options.codeTheme,
        })
      ),
      { mermaid: options.mermaid, charts: options.charts, diff: options.diff }
    ),
    rehypePlugins: chatStreamdownRehypePlugins,
    urlTransform: chatMarkdownUrlTransform,
    lineNumbers: options.codeLineNumbers,
  }
  derived.set(config, streamdown)
  return streamdown
}
