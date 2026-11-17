"use client"

import { memo, useMemo } from "react"

import { MessageResponse } from "@/components/ai-elements/message"
import { createStreamingComponents } from "@/components/chat/streaming-text-part"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import { cn } from "@/lib/utils"

import { resolveChatStreamdownConfig } from "./chat-streamdown-config"

/**
 * Assistant Markdown outside the chat transcript (the pet's replies, the
 * skill editor's suggestions) drawn with the chat configuration (D7): the
 * user's display knobs, the app's fence renderers, and the chat sanitize and
 * URL policy, which a bare `MessageResponse` leaves at Streamdown's defaults.
 * The surface keeps its own typography; only the knob classes are added.
 */
export const ChatMarkdownResponse = memo(function ChatMarkdownResponse({
  children,
  className,
  isAnimating = false,
}: {
  children: string
  className?: string
  /** True while the text is still arriving. */
  isAnimating?: boolean
}) {
  const display = useMessageDisplay()
  const streamdown = resolveChatStreamdownConfig(display.markdown)
  const { config } = streamdown
  const components = useMemo(
    () => createStreamingComponents(null, isAnimating, undefined, true),
    [isAnimating]
  )
  const source = useMemo(() => config.preprocess(children), [config, children])
  return (
    <MessageResponse
      className={cn(config.knobClassName, className)}
      components={components}
      controls={{ table: false }}
      isAnimating={isAnimating}
      lineNumbers={streamdown.lineNumbers}
      mode={isAnimating ? "streaming" : "static"}
      plugins={streamdown.plugins}
      rehypePlugins={streamdown.rehypePlugins}
      urlTransform={streamdown.urlTransform}
    >
      {source}
    </MessageResponse>
  )
})
