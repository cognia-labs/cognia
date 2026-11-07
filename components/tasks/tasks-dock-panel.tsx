"use client"

// The conversation's Tasks panel in the chat dock (ADR-0214): the agent's
// current task list, the open plan and earlier plans. The tasks module
// contributes it through its UI manifest's `effects`, by registering it with
// the context panel registry the dock already resolves, rather than the dock
// importing tasks: tasks depends on the artifact module the dock lives in
// (a `spawn_task` handoff opens the dock's sidechat), and module dependencies
// are acyclic (ADR-0250 §14, G6).
//
// The panel claims its rail slot only when the conversation has a task list
// or a plan, and its badge counts plans awaiting a decision first, else the
// agent's open tasks. A registry definition answers both synchronously per
// conversation, so this file keeps a small watched summary of each
// conversation the dock has asked about and refreshes the registry when one
// changes.

import { useEffect } from "react"
import { liveQuery, type Subscription } from "dexie"
import { ListTodoIcon } from "lucide-react"
import { sessionTaskTimeline } from "@/hooks/chat/use-session-tasks"
import { SESSION_TASKS_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { listPlansBySession } from "@/lib/db/plans"
import { isSettledTaskStatus } from "@/lib/tasks/task-view"
import { useChatStore } from "@/stores/chat"
import type { AgentPlan } from "@/types/agent/plan"
import type { ContextPanelDefinition, ContextPanelRenderProps } from "@/types/context-workbench"
import { SessionTasksPanel } from "./session-tasks-panel"

/** How many conversations' plans are watched at once; the oldest is dropped. */
export const TASKS_PANEL_WATCH_LIMIT = 8

interface WatchedPlans {
  /** `undefined` until the first read lands. */
  plans: readonly AgentPlan[] | undefined
  subscription: Subscription
}

const watched = new Map<string, WatchedPlans>()

/** Start (or keep) watching a conversation's plans, most recently asked last. */
function watchPlans(sessionId: string): WatchedPlans {
  const known = watched.get(sessionId)
  if (known) {
    watched.delete(sessionId)
    watched.set(sessionId, known)
    return known
  }
  const entry: WatchedPlans = { plans: undefined, subscription: undefined as never }
  entry.subscription = liveQuery(() => listPlansBySession(sessionId)).subscribe({
    next: (plans) => {
      entry.plans = plans
      contextPanelRegistry.refresh()
    },
    // A failed read leaves the plans unknown; the task list still decides.
    error: () => {},
  })
  watched.set(sessionId, entry)
  for (const [oldest, stale] of watched) {
    if (watched.size <= TASKS_PANEL_WATCH_LIMIT) break
    stale.subscription.unsubscribe()
    watched.delete(oldest)
  }
  return entry
}

/** How many of the conversation's tasks are still open, or null with no task list. */
function openTaskCount(sessionId: string): number | null {
  const messages = useChatStore.getState().sessions[sessionId]?.messages
  if (!messages) return null
  const current = sessionTaskTimeline(messages).current
  if (!current) return null
  return current.items.filter((item) => !isSettledTaskStatus(item.status)).length
}

export interface SessionTasksSummary {
  /** The conversation has a task list or a plan, so the panel claims its slot. */
  visible: boolean
  /** Plans awaiting a decision, else open tasks. */
  badge: number
}

/** The panel's visibility and badge for one conversation, as now known. */
export function sessionTasksSummary(sessionId: string): SessionTasksSummary {
  const plans = watchPlans(sessionId).plans
  const open = openTaskCount(sessionId)
  const pending = plans?.filter((plan) => plan.status === "awaiting_approval").length ?? 0
  return {
    visible: (plans?.length ?? 0) > 0 || open !== null,
    badge: pending > 0 ? pending : (open ?? 0),
  }
}

function TasksPanelRenderer({ resource }: ContextPanelRenderProps) {
  if (resource.kind !== "session") return null
  // Keyed on the conversation, so switching conversations starts it afresh.
  return <SessionTasksPanel key={resource.sessionId} sessionId={resource.sessionId} />
}

/**
 * The Tasks panel. Sits beside the artifact list: both are the session's
 * reviewable outputs. The id stays `plan` for stored layouts.
 */
export const sessionTasksPanel: ContextPanelDefinition = {
  id: SESSION_TASKS_PANEL_ID,
  activity: "review",
  labelKey: "contextWorkbench.planPanel.title",
  icon: ListTodoIcon,
  order: 12,
  appliesTo: (resource) =>
    resource.kind === "session" && sessionTasksSummary(resource.sessionId).visible,
  retention: "stateful",
  getBadge: (resource) =>
    resource.kind === "session" ? sessionTasksSummary(resource.sessionId).badge : undefined,
  renderer: TasksPanelRenderer,
}

/**
 * Registers the Tasks panel while mounted, in every window, and refreshes the
 * registry when a watched conversation's open task count moves. Renders
 * nothing.
 */
export default function TasksDockPanel() {
  useEffect(() => {
    const unregister = contextPanelRegistry.register(sessionTasksPanel)
    const signature = () =>
      [...watched.keys()].map((sessionId) => `${sessionId}:${openTaskCount(sessionId)}`).join()
    let last = signature()
    const unsubscribe = useChatStore.subscribe(() => {
      const next = signature()
      if (next === last) return
      last = next
      contextPanelRegistry.refresh()
    })
    return () => {
      unsubscribe()
      unregister()
      for (const entry of watched.values()) entry.subscription.unsubscribe()
      watched.clear()
    }
  }, [])
  return null
}
