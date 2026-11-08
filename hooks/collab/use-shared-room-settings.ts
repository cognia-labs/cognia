"use client"

/**
 * Whether this member may change a shared room's settings, and the one call
 * that does (ADR-0177 batch 5).
 *
 * The role is read from the membership mirror the sync keeps
 * (`collabChatMemberships`), keyed the way the sync keys it, for the user the
 * current collaboration context signs in as. The server decides every write
 * again; this only lets the editor say "owners and maintainers change this"
 * before the click instead of after it.
 */

import { useCallback, useEffect, useState } from "react"

import type { ChatSession, SessionRole } from "@cognia/agent-config-types"
import { useClientLiveQuery } from "@/hooks/data"
import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import {
  canManageSharedRoomSettings,
  updateSharedRoomSettings,
  type SharedRoomSettingsChange,
} from "@/lib/collab/shared-room-settings"
import { sharedChatCacheKey } from "@/lib/db/collab-chat-mirror"
import { getDb } from "@/lib/db/schema"

export type SharedRoomSettingsAccess =
  { state: "checking" } | { state: "allowed" } | { state: "denied"; role: SessionRole | null }

interface MemberRef {
  key: string
  userId: string
}

export function useSharedRoomSettings(
  session: Pick<ChatSession, "id" | "collaboration" | "roomSettings"> | undefined
): {
  access: SharedRoomSettingsAccess
  update: (change: SharedRoomSettingsChange) => Promise<void>
} {
  const binding = session?.collaboration
  const orgId = binding?.orgId
  const remoteSessionId = binding?.sessionId
  const endpoint = binding?.endpoint
  const [member, setMember] = useState<MemberRef | null | undefined>(undefined)

  useEffect(() => {
    if (!orgId || !remoteSessionId) return
    let cancelled = false
    void resolveCurrentCollabContext()
      .then((context) => {
        if (cancelled) return
        if (
          !context ||
          context.orgId !== orgId ||
          (endpoint && endpoint !== context.client.baseUrl)
        ) {
          setMember(null)
          return
        }
        setMember({
          key: sharedChatCacheKey(orgId, remoteSessionId, context.client.baseUrl),
          userId: context.userId,
        })
      })
      .catch(() => {
        if (!cancelled) setMember(null)
      })
    return () => {
      cancelled = true
    }
  }, [orgId, remoteSessionId, endpoint])

  const role = useClientLiveQuery<SessionRole | null | undefined>(
    async () => {
      if (!member) return member === null ? null : undefined
      const row = await getDb().collabChatMemberships.get([member.key, member.userId])
      return row?.role ?? null
    },
    // `null` (no member to read) and `undefined` (not resolved yet) must
    // differ to the query, or settling on "none" never re-runs it.
    [member === null ? "none" : member === undefined ? "pending" : member.key, member?.userId],
    undefined
  )

  const access: SharedRoomSettingsAccess =
    !binding || role === undefined
      ? { state: "checking" }
      : canManageSharedRoomSettings(role)
        ? { state: "allowed" }
        : { state: "denied", role }

  const update = useCallback(
    async (change: SharedRoomSettingsChange) => {
      if (!session) return
      await updateSharedRoomSettings(session, change)
    },
    [session]
  )

  return { access, update }
}
