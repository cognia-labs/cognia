"use client"

import { createContext, createElement, useContext, type ReactNode } from "react"
import { useAgentChat as useAgentChatController } from "./use-agent-chat-controller"

export { shouldGenerateTitle } from "@/lib/ai/generation/run-title-task"

type AgentChatRuntime = ReturnType<typeof useAgentChatController>
const AgentChatRuntimeContext = createContext<AgentChatRuntime | null>(null)

/** One application-owned controller survives pane navigation and retained surfaces. */
export function AgentChatRuntimeProvider({ children }: { children: ReactNode }) {
  const parent = useContext(AgentChatRuntimeContext)
  if (parent) {
    throw new Error("AgentChatRuntimeProvider must be mounted once at application bootstrap")
  }
  return createElement(AgentChatRuntimeOwner, null, children)
}

function AgentChatRuntimeOwner({ children }: { children: ReactNode }) {
  const runtime = useAgentChatController()
  return createElement(AgentChatRuntimeContext.Provider, { value: runtime }, children)
}

/** Every surface shares the same commands, streaming mirror and event queue. */
export function useAgentChat(): AgentChatRuntime {
  const runtime = useOptionalAgentChat()
  if (!runtime) {
    throw new Error("useAgentChat requires AgentChatRuntimeProvider")
  }
  return runtime
}

/**
 * The runtime if one is mounted, otherwise null.
 *
 * For surfaces that are CONSTRUCTED outside the provider but only ever SEND
 * inside it — the artifacts dock body renders in the app (provider present),
 * in Storybook and in unit tests (no provider), and a hook that throws on
 * construction would make the panel unrenderable in the latter two. Callers
 * must still refuse to send when this returns null rather than pretending the
 * message went out.
 */
export function useOptionalAgentChat(): AgentChatRuntime | null {
  return useContext(AgentChatRuntimeContext)
}
