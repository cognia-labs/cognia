// React reader for a typed topic (`lib/runtime/topics.ts`, ADR-0250 §14):
// the topic's latest value, re-rendering when its publisher sends a new one.
// `undefined` means nobody publishes the topic in this window.

"use client"

import { useCallback, useSyncExternalStore } from "react"
import { readTopic, subscribeTopic, type TopicId, type TopicMap } from "@/lib/runtime/topics"

export function useTopic<K extends TopicId>(id: K): TopicMap[K] | undefined {
  const subscribe = useCallback((onChange: () => void) => subscribeTopic(id, onChange), [id])
  const read = useCallback(() => readTopic(id), [id])
  return useSyncExternalStore(subscribe, read, read)
}
