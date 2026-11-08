"use client"

/**
 * Reactive access to the session's *effective* working directory — the exact
 * same resolution chain `resolveSendOptions` applies at send time (session
 * override → the session's execution binding → its workspace primary root →
 * character default → app default, see `lib/workspace/effective-cwd.ts`).
 *
 * Chat surfaces that gate behaviour on "is there a working directory?" must
 * resolve through here instead of reading `session.workingDir` directly —
 * otherwise selecting a workspace updates what the model runs in while the
 * UI still claims no working directory exists.
 *
 * Both the workspace and the execution root are resolved from the SESSION, not
 * from whatever is active in the UI. The one-shot form for async call sites is
 * `resolveEffectiveCwdForSession` (`lib/chat/session-effective-cwd.ts`).
 */

import { useSyncExternalStore } from "react"
import { useProjectStore } from "@/stores/project/project-store"
import { useCharacter } from "@/lib/data-hooks/context"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import {
  defaultWorkingDirNow,
  executionRootOf,
  subscribeDefaultWorkingDir,
  type SessionCwdFields,
} from "@/lib/chat/session-effective-cwd"

/** Reactive effective cwd for a session (or the fallback chain when null). */
export function useEffectiveCwd(session: SessionCwdFields | null | undefined): string | null {
  const activeProject = useProjectStore((s) =>
    resolveSessionWorkspace(session, s.projects, s.activeProjectId)
  )
  const character = useCharacter(session?.characterId)
  const defaultWorkingDir = useSyncExternalStore(
    subscribeDefaultWorkingDir,
    defaultWorkingDirNow,
    defaultWorkingDirNow
  )
  return (
    resolveEffectiveCwd({
      sessionWorkingDir: session?.workingDir,
      executionWorkspaceRoot: executionRootOf(session),
      activeProject,
      characterWorkingDir: character?.workingDir,
      defaultWorkingDir,
    }) ?? null
  )
}
