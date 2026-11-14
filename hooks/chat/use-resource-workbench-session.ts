"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import {
  ensureResourceWorkbenchSession,
  fillResourceSessionConfigGaps,
  migrateResourceSessionBinding,
  surfaceBindingForContextResource,
  AsideParentGoneError,
} from "@/lib/context-workbench/resource-session"
import { createResourceSessionRepository } from "@/lib/db/resource-workbench-sessions"
import { getContextResourceKey, type ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useSessionAsideIdentity } from "./use-session-aside-identity"
import { useChatStore } from "@/stores/chat"

export function useResourceWorkbenchSession(
  resource: ContextResource,
  enabled: boolean,
  workbenchInstanceId: string
): ChatSession | null {
  const t = useTranslations("contextWorkbench.asides")
  // Main conversations can own an aside; embedded asides cannot nest another.
  const isAside = useSessionAsideIdentity(resource.kind === "session" ? resource.sessionId : null)
  const surfaceBinding = surfaceBindingForContextResource(resource, !isAside)
  const bindingKey = surfaceBinding ? JSON.stringify(surfaceBinding) : null
  const binding = useMemo(
    () => (bindingKey ? (JSON.parse(bindingKey) as SessionSurfaceBinding) : null),
    [bindingKey]
  )
  const resourceKey = getContextResourceKey(resource)
  const sessionOverrideId = useContextWorkbenchStore(
    (state) => state.sessionOverrides?.[resourceKey]
  )
  const setSessionOverride = useContextWorkbenchStore((state) => state.setSessionOverride)
  const [session, setSession] = useState<ChatSession | null>(null)

  useEffect(() => {
    if (!enabled || !binding || resource.kind === "workflow") return
    let cancelled = false
    const db = getDb()
    const repository = createResourceSessionRepository()
    const ensure = async () => {
      if (sessionOverrideId) {
        const overridden = await db.sessions.get(sessionOverrideId)
        if (overridden?.kind === "resource-workbench") {
          await migrateResourceSessionBinding(sessionOverrideId, binding, repository)
          return fillResourceSessionConfigGaps(
            { ...overridden, surfaceBinding: binding },
            binding,
            repository
          )
        }
        setSessionOverride(resourceKey, null)
      }
      return ensureResourceWorkbenchSession(binding, resourceKey, repository, workbenchInstanceId)
    }
    void ensure()
      .then((nextSession) => {
        if (!cancelled) setSession(nextSession)
      })
      .catch((error) => {
        if (!cancelled) {
          setSession(null)
          if (error instanceof AsideParentGoneError && binding.kind === "session") {
            // The owner has already been deleted. Close its stale navigation
            // tab so the dock renders its existing no-conversation placeholder.
            useChatStore.getState().closeSession(binding.sessionId)
            toast.error(t("openError"))
          }
        }
        console.error("Failed to ensure resource workbench session", error)
      })
    return () => {
      cancelled = true
    }
  }, [
    binding,
    bindingKey,
    enabled,
    resource.kind,
    resourceKey,
    sessionOverrideId,
    setSessionOverride,
    t,
    workbenchInstanceId,
  ])

  return session && bindingKey && JSON.stringify(session.surfaceBinding) === bindingKey
    ? session
    : null
}
