"use client"

/**
 * The session's current task list, live from the transcript in the chat
 * store (`lib/chat/session-tasks.ts`), plus the display state every task
 * surface shares: the progress, items still marked in progress after their
 * run ended (`stopped`), and whether the list is finished.
 *
 * One derivation per messages array: the transcript diff rows, the progress
 * chip, the summary card and the Tasks panel all read the same memoized fold.
 */

import { useMemo } from "react"
import type { UIMessage } from "ai"

import {
  deriveSessionTasks,
  type SessionTaskTimeline,
  type TaskFamily,
} from "@/lib/chat/session-tasks"
import {
  isSettledTaskStatus,
  summarizeTasks,
  withStoppedItems,
  type TaskProgress,
  type TaskViewItem,
} from "@/lib/tasks/task-view"
import { useChatStore, useSessionMessages, useSessionStatus } from "@/stores/chat"

const timelines = new WeakMap<readonly UIMessage[], SessionTaskTimeline>()

/** The memoized fold for one messages array (shared across hooks and rows). */
export function sessionTaskTimeline(messages: readonly UIMessage[]): SessionTaskTimeline {
  let timeline = timelines.get(messages)
  if (!timeline) {
    timeline = deriveSessionTasks(messages)
    timelines.set(messages, timeline)
  }
  return timeline
}

export interface SessionTasksView {
  family: TaskFamily
  /** With `stopped` applied when the session is not running. */
  items: readonly TaskViewItem[]
  progress: TaskProgress
  /** A turn is streaming or waiting on an approval. */
  running: boolean
  /** Every item done and no turn running: surfaces fold the list away. */
  finished: boolean
  /** Some item was left in progress by a run that ended. */
  stopped: boolean
  lastToolCallId: string
  lastMessageId: string
}

export function useSessionTaskTimeline(sessionId: string | null | undefined): SessionTaskTimeline {
  const messages = useSessionMessages(sessionId ?? null)
  return useMemo(() => sessionTaskTimeline(messages), [messages])
}

/** The current task list, or null when the agent has kept none in this session. */
export function useSessionTasks(sessionId: string | null | undefined): SessionTasksView | null {
  const timeline = useSessionTaskTimeline(sessionId)
  const status = useSessionStatus(sessionId ?? null)
  const running = status === "streaming" || status === "awaiting_approval"
  return useMemo(() => {
    const current = timeline.current
    if (!current) return null
    const items = withStoppedItems(current.items, running)
    const progress = summarizeTasks(items)
    return {
      family: current.family,
      items,
      progress,
      running,
      finished: progress.allDone && !running,
      stopped: items !== current.items,
      lastToolCallId: current.lastToolCallId,
      lastMessageId: current.lastMessageId,
    }
  }, [timeline, running])
}

/**
 * How many of the session's tasks are still open: `null` when the agent keeps
 * no task list here. A primitive selector, so a host that only needs to know
 * whether to show the Tasks panel (and its badge) re-renders when that number
 * moves, not on every streamed frame.
 */
export function useSessionOpenTaskCount(sessionId: string | null | undefined): number | null {
  return useChatStore((state) => {
    const messages = sessionId ? state.sessions[sessionId]?.messages : undefined
    if (!messages) return null
    const current = sessionTaskTimeline(messages).current
    if (!current) return null
    return current.items.filter((item) => !isSettledTaskStatus(item.status)).length
  })
}
