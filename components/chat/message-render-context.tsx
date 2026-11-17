"use client"

/**
 * The React half of `lib/chat/message-render-context.ts` (D10). A list shell
 * provides it once; every `MessageRenderer` and the renderers nested inside a
 * message read it. Providers nest: an inner one overrides the keys it sets and
 * narrows `canMutate`.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react"

import {
  mergeMessageRenderContext,
  type MessageRenderContextValue,
} from "@/lib/chat/message-render-context"

const EMPTY: MessageRenderContextValue = {}

const MessageRenderContext = createContext<MessageRenderContextValue>(EMPTY)

/**
 * Supply `value` to the messages below, on top of any provider above. Pass a
 * memoized value: every row re-renders when it changes.
 */
export function MessageRenderProvider({
  value,
  children,
}: {
  value: MessageRenderContextValue
  children: ReactNode
}) {
  const parent = useContext(MessageRenderContext)
  // An empty value passes the parent through untouched, so a provider that
  // narrows nothing re-renders no row.
  const merged = useMemo(
    () =>
      Object.keys(value).length === 0
        ? parent
        : parent === EMPTY
          ? value
          : mergeMessageRenderContext(parent, value),
    [parent, value]
  )
  return <MessageRenderContext.Provider value={merged}>{children}</MessageRenderContext.Provider>
}

/** What the nearest providers supply; empty outside a message list. */
export function useMessageRenderContext(): MessageRenderContextValue {
  return useContext(MessageRenderContext)
}
