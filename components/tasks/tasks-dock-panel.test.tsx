/**
 * @jest-environment jsdom
 */

import { act, render, waitFor } from "@testing-library/react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { SESSION_TASKS_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import TasksDockPanel, { TASKS_PANEL_WATCH_LIMIT, sessionTasksPanel } from "./tasks-dock-panel"

// The plans a conversation has, served through Dexie's `liveQuery`: each
// subscriber gets the current list on subscribe and again after a change.
let plansBySession: Record<string, Array<{ id: string; status: string }>> = {}
interface MockSubscriber {
  query: () => Promise<unknown[]>
  next: (plans: unknown[]) => void
}
const subscribers = new Set<MockSubscriber>()
const mockUnsubscribe = jest.fn()
jest.mock("dexie", () => ({
  liveQuery: (query: () => Promise<unknown[]>) => ({
    subscribe: ({ next }: { next: (plans: unknown[]) => void }) => {
      const subscriber = { query, next }
      subscribers.add(subscriber)
      void query().then(next)
      return {
        unsubscribe: () => {
          subscribers.delete(subscriber)
          mockUnsubscribe()
        },
      }
    },
  }),
}))
jest.mock("@/lib/db/plans", () => ({
  listPlansBySession: async (sessionId: string) => plansBySession[sessionId] ?? [],
}))
async function changePlans(sessionId: string, plans: Array<{ id: string; status: string }>) {
  plansBySession[sessionId] = plans
  for (const subscriber of subscribers) subscriber.next(await subscriber.query())
}

// The agent's task list comes from the conversation's transcript in the chat
// store; the fold is replaced by a count per conversation.
const openTasks: Record<string, number | null> = {}
jest.mock("@/hooks/chat/use-session-tasks", () => ({
  sessionTaskTimeline: (messages: { sessionId: string }[]) => {
    const open = openTasks[messages[0].sessionId]
    if (open === null || open === undefined) return { current: null }
    return {
      current: {
        items: Array.from({ length: open }, () => ({ status: "pending" })),
      },
    }
  },
}))
jest.mock("@/stores/chat", () => {
  const { create } = jest.requireActual<typeof import("zustand")>("zustand")
  return { useChatStore: create(() => ({ sessions: {} as Record<string, unknown> })) }
})
import type { StoreApi } from "zustand"
import { useChatStore } from "@/stores/chat"
const chatStore = useChatStore as unknown as StoreApi<{ sessions: Record<string, unknown> }>
function setOpenTasks(sessionId: string, open: number | null) {
  openTasks[sessionId] = open
  chatStore.setState((state) => ({
    sessions: { ...state.sessions, [sessionId]: { messages: [{ sessionId }] } },
  }))
}

const mockPanel = jest.fn((_props: { sessionId: string }) => null)
jest.mock("./session-tasks-panel", () => ({
  SessionTasksPanel: (props: { sessionId: string }) => mockPanel(props),
}))

const session = (sessionId: string) => ({ kind: "session" as const, sessionId, capabilities: [] })
const artifact = { kind: "artifact", artifactId: "a1", capabilities: [] } as never

afterEach(() => {
  plansBySession = {}
  mockUnsubscribe.mockClear()
  for (const key of Object.keys(openTasks)) delete openTasks[key]
  useChatStore.setState({ sessions: {} })
})

describe("TasksDockPanel", () => {
  it("registers the Tasks panel while mounted and takes it back on unmount", () => {
    expect(contextPanelRegistry.get(SESSION_TASKS_PANEL_ID)).toBeUndefined()
    const view = render(<TasksDockPanel />)
    expect(contextPanelRegistry.get(SESSION_TASKS_PANEL_ID)).toMatchObject({
      id: "plan",
      activity: "review",
      labelKey: "contextWorkbench.planPanel.title",
      order: 12,
      retention: "stateful",
    })
    view.unmount()
    expect(contextPanelRegistry.get(SESSION_TASKS_PANEL_ID)).toBeUndefined()
  })

  it("claims a slot only once the conversation has a plan, and badges plans awaiting a decision", async () => {
    const view = render(<TasksDockPanel />)
    try {
      plansBySession.s1 = []
      expect(sessionTasksPanel.appliesTo(session("s1"))).toBe(false)
      expect(sessionTasksPanel.appliesTo(artifact)).toBe(false)
      expect(sessionTasksPanel.getBadge?.(session("s1"))).toBe(0)

      const refresh = jest.spyOn(contextPanelRegistry, "refresh")
      await act(() =>
        changePlans("s1", [
          { id: "p1", status: "awaiting_approval" },
          { id: "p2", status: "completed" },
        ])
      )
      expect(refresh).toHaveBeenCalled()
      expect(sessionTasksPanel.appliesTo(session("s1"))).toBe(true)
      // Only plans waiting on a decision count toward the badge.
      expect(sessionTasksPanel.getBadge?.(session("s1"))).toBe(1)
    } finally {
      view.unmount()
    }
  })

  it("claims the slot for the agent's task list alone, badges its open tasks, and refreshes when they move", async () => {
    const view = render(<TasksDockPanel />)
    try {
      setOpenTasks("s2", 3)
      expect(sessionTasksPanel.appliesTo(session("s2"))).toBe(true)
      expect(sessionTasksPanel.getBadge?.(session("s2"))).toBe(3)

      const refresh = jest.spyOn(contextPanelRegistry, "refresh")
      refresh.mockClear()
      act(() => setOpenTasks("s2", 1))
      expect(refresh).toHaveBeenCalled()
      expect(sessionTasksPanel.getBadge?.(session("s2"))).toBe(1)

      // A plan awaiting a decision outranks the open-task count.
      setOpenTasks("s2", 4)
      await act(() => changePlans("s2", [{ id: "p1", status: "awaiting_approval" }]))
      expect(sessionTasksPanel.getBadge?.(session("s2"))).toBe(1)
      await act(() => changePlans("s2", []))
      expect(sessionTasksPanel.getBadge?.(session("s2"))).toBe(4)
    } finally {
      view.unmount()
    }
  })

  it("watches a bounded number of conversations and lets the oldest go", async () => {
    const view = render(<TasksDockPanel />)
    try {
      for (let i = 0; i < TASKS_PANEL_WATCH_LIMIT; i++)
        sessionTasksPanel.appliesTo(session(`w${i}`))
      expect(subscribers.size).toBe(TASKS_PANEL_WATCH_LIMIT)
      // Asking again about a watched conversation starts nothing new.
      sessionTasksPanel.appliesTo(session("w0"))
      expect(mockUnsubscribe).not.toHaveBeenCalled()
      // One more conversation drops the least recently asked one (w1).
      sessionTasksPanel.appliesTo(session("extra"))
      expect(subscribers.size).toBe(TASKS_PANEL_WATCH_LIMIT)
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(sessionTasksPanel.getBadge?.(session("w0"))).toBe(0))
    } finally {
      view.unmount()
    }
  })

  it("renders the conversation's Tasks panel", () => {
    const Renderer = sessionTasksPanel.renderer
    render(<Renderer workbenchInstanceId="w" resource={session("s1")} active />)
    expect(mockPanel).toHaveBeenCalledWith({ sessionId: "s1" })
  })
})
