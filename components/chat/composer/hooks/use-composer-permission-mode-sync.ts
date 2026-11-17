"use client"

import type { ComposerInnerProps } from "../../composer"
import { type PermissionMode } from "@/stores/chat/chat-store"
import { type ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { useEffect, useRef } from "react"

export interface ComposerPermissionModeSyncInput {
  setPermissionMode: (mode: PermissionMode | null, sessionId?: string | null | undefined) => void
  permissionMode: PermissionMode | null
  updateSession: (
    id: string,
    patch: Partial<Omit<ChatSession, "id" | "createdAt" | "workingSet">>
  ) => Promise<void>
  props: Pick<ComposerInnerProps, "session">
}

/**
 * Keeps this conversation's permission mode and its session row in step:
 * hydrates the chat store from the row on a session change, then writes later
 * changes back. The two-phase commit skips the first render after a swap, where
 * the store has not caught up with the row yet.
 */
export function useComposerPermissionModeSync(input: ComposerPermissionModeSyncInput) {
  const { setPermissionMode, permissionMode, updateSession, props } = input

  // --- Hydrate chat-store from session row on first session change -------
  // `hydratedFor` flips to the session id once the hydration write has
  // *committed*, not just been scheduled. The persist effect below reads
  // this ref to skip the first post-hydration render, where the store value
  // hasn't yet caught up with the session row and would otherwise look
  // divergent and trigger a redundant write.
  const hydratedFor = useRef<string | null>(null)
  const pendingHydrationFor = useRef<string | null>(null)
  useEffect(() => {
    if (!props.session) return
    if (
      hydratedFor.current === props.session.id ||
      pendingHydrationFor.current === props.session.id
    ) {
      return
    }
    pendingHydrationFor.current = props.session.id
    setPermissionMode(props.session.permissionMode ?? null, props.session.id)
  }, [props.session, setPermissionMode])

  // --- Persist active permission mode back to session row ---------------
  useEffect(() => {
    if (!props.session) return
    // Hydration two-phase commit: when permissionMode catches up with the
    // session row's value (the value we hydrated *to*), flip the
    // hydratedFor ref. Until that point the persist branch is a no-op so
    // the very first render after a session swap doesn't write the stale
    // store value back to the row.
    if (
      pendingHydrationFor.current === props.session.id &&
      hydratedFor.current !== props.session.id &&
      permissionMode === (props.session.permissionMode ?? null)
    ) {
      hydratedFor.current = props.session.id
      pendingHydrationFor.current = null
      return
    }
    if (hydratedFor.current !== props.session.id) return
    // Same normalization as the hydration check above: the row stores
    // `permissionMode` as optional (absent → `undefined`) while the store
    // uses `null` for "unset". Comparing raw values makes `undefined !== null`
    // diverge forever — each write bumps `updatedAt`, the live query re-emits
    // a fresh session object, this effect re-runs and writes again. That is a
    // self-sustaining IDB write loop that re-renders the whole sidebar tree.
    if ((props.session.permissionMode ?? null) === permissionMode) return
    void updateSession(props.session.id, {
      permissionMode: permissionMode ?? undefined,
    }).catch((err) => {
      loggers.chat.warn("updateSession permissionMode failed", {
        sessionId: props.session?.id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, [permissionMode, props.session, updateSession])
}
