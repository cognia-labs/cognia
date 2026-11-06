"use client"

/**
 * A shared workspace's current members as assignee options (ADR-0149 §10).
 *
 * The server accepts a human assignee only if they are a current member of the
 * issue's workspace, so the roster comes from the server, the same request the
 * comment composer's mention picker makes (`useCollabMentionCandidates`), never
 * from the mirrored roster. The signed-in person is left out: they are "Me".
 *
 * `reload` asks again; the board calls it each time an assignee menu opens on
 * a shared row, so somebody who left since the last read is not offered. A
 * workspace that is not shared, no collaboration server, offline or a refused
 * read all give an empty list: the board then offers what it offered before.
 */

import { useCallback, useMemo, useState } from "react"

import { memberAssigneeOptions, type AssigneeOption } from "@/components/issues/assignee-picker"
import {
  useCollabMentionCandidates,
  type UseCollabMentionCandidatesDeps,
} from "@/hooks/collab/use-collab-mention-candidates"
import { useClientLiveQuery } from "@/hooks/data"
import { getCollabWorkspace } from "@/lib/db/collab-workspace-mirror"
import type { CollabWorkspaceMirrorRow } from "@/lib/db/collab-workspace-mirror-types"

export interface CollabAssigneeMembers {
  options: readonly AssigneeOption[]
  reload: () => void
}

export interface UseCollabAssigneeMembersDeps {
  readWorkspace?: (id: string) => Promise<CollabWorkspaceMirrorRow | undefined>
  resolveContext?: UseCollabMentionCandidatesDeps["resolveContext"]
}

export function useCollabAssigneeMembers(
  workspaceId: string | null | undefined,
  deps: UseCollabAssigneeMembersDeps = {}
): CollabAssigneeMembers {
  const readWorkspace = deps.readWorkspace ?? getCollabWorkspace
  // The mirror names the org a shared workspace belongs to; a local-only
  // workspace has no row, so nothing is asked.
  const workspace = useClientLiveQuery(
    () => (workspaceId ? readWorkspace(workspaceId) : Promise.resolve(undefined)),
    [workspaceId, readWorkspace],
    undefined
  )
  const orgId = workspace?.orgId
  const scope = useMemo(
    () => (orgId && workspaceId ? { orgId, workspaceId } : null),
    [orgId, workspaceId]
  )
  const [reloadToken, setReloadToken] = useState(0)
  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const candidates = useCollabMentionCandidates(scope, {
    ...(deps.resolveContext ? { resolveContext: deps.resolveContext } : {}),
    reloadToken,
  })
  const options = useMemo(() => memberAssigneeOptions(candidates), [candidates])
  return { options, reload }
}
