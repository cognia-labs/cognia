/**
 * A session's *effective* working directory, resolved once: the exact same
 * chain `resolveSendOptions` applies at send time (session override → the
 * session's execution binding → its workspace primary root → character
 * default → app default, see `lib/workspace/effective-cwd.ts`).
 *
 * Both the workspace and the execution root are resolved from the SESSION, not
 * from whatever is active in the UI: a background pane or a cross-workspace
 * selection would otherwise show the focused workspace's directory for a
 * conversation that runs somewhere else entirely.
 *
 * The reactive form for React is `useEffectiveCwd`
 * (`hooks/chat/use-effective-cwd.ts`); this one serves async call sites that
 * hold the session row themselves (the room runner, best-of-N, a Squad
 * start), and lives below the UI layer so they need not import a hook.
 */

import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { resolveCharacterById } from "@/lib/db/characters"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import type { ChatSession } from "@cognia/agent-config-types"

export type SessionCwdFields = Pick<
  ChatSession,
  "workingDir" | "characterId" | "projectId" | "executionContext"
>

/** The root of the session's own execution binding, if it has one. */
export function executionRootOf(session: SessionCwdFields | null | undefined): string | undefined {
  return session?.executionContext
    ? resolveSessionWorkspaceRoot(session.executionContext)
    : undefined
}

/** The app's default working directory now. */
export function defaultWorkingDirNow(): string | undefined {
  return useSettingsStore.getState().settings?.defaultWorkingDir
}

/**
 * Hear changes of the settings, for `useSyncExternalStore` with
 * {@link defaultWorkingDirNow}: the hook reads the default through here
 * rather than importing the settings store itself.
 */
export function subscribeDefaultWorkingDir(listener: () => void): () => void {
  return useSettingsStore.subscribe(listener)
}

/**
 * Reads the stores via `getState()` and resolves the character from Dexie.
 */
export async function resolveEffectiveCwdForSession(
  session: SessionCwdFields | null | undefined
): Promise<string | null> {
  const ps = useProjectStore.getState()
  const activeProject = resolveSessionWorkspace(session, ps.projects, ps.activeProjectId)
  const character = session?.characterId
    ? await resolveCharacterById(session.characterId).catch(() => undefined)
    : undefined
  return (
    resolveEffectiveCwd({
      sessionWorkingDir: session?.workingDir,
      executionWorkspaceRoot: executionRootOf(session),
      activeProject,
      characterWorkingDir: character?.workingDir,
      defaultWorkingDir: defaultWorkingDirNow(),
    }) ?? null
  )
}
