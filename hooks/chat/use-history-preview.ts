"use client"

import { useCallback, useSyncExternalStore } from "react"

import {
  getHistoryPreview,
  subscribeHistoryPreview,
  type HistoryPreview,
} from "@/lib/chat/history-preview"

const noopSubscribe = () => () => undefined
const readNull = () => null

/** The tail preview a pane shows for `sessionId` while its full history loads. */
export function useHistoryPreview(sessionId: string | null | undefined): HistoryPreview | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? subscribeHistoryPreview(sessionId, listener) : noopSubscribe(),
    [sessionId]
  )
  const read = useCallback(() => getHistoryPreview(sessionId), [sessionId])
  return useSyncExternalStore(subscribe, read, readNull)
}
