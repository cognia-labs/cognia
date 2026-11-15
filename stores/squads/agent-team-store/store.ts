import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { registerProjectBucketPurger } from "@/lib/project/project-bucket-purge"
import { initialState } from "./initial-state"
import { createAgentTeamActionsSlice } from "./slices/actions.slice"
import type { AgentTeamState } from "./types"

/**
 * Persisted-state version. Bump it whenever the persisted shape changes
 * incompatibly; a blob written under another version is discarded and the
 * store starts from its defaults. Teams, teammates and tasks are not in this
 * blob: Dexie owns them (`dexie-bridge.ts`).
 */
const PERSIST_VERSION = 9
const AGENT_TEAM_STORAGE_KEY = "cognia-agent-teams"

function agentTeamAccountStorageKey(accountId: string): string {
  return `${AGENT_TEAM_STORAGE_KEY}:${accountId}`
}

/**
 * Select the persisted slice of the store. Exported for tests.
 *
 * Persists team templates + defaults + UI tab state + the adapter-sync cursor.
 * Live runtime ephemera (messages / events / consensus / delegations /
 * shared-memory) are intentionally excluded — they carry non-serializable
 * handles + unbounded churn, and run history lives in Dexie `workflowRuns`.
 */
export function partializeAgentTeamState(state: AgentTeamState) {
  return {
    templates: state.templates,
    defaultConfig: state.defaultConfig,
    displayMode: state.displayMode,
    workspaceTab: state.workspaceTab,
    tasksView: state.tasksView,
    lastAdapterSyncVersion: state.lastAdapterSyncVersion,
    // teams / teammates / tasks are Dexie's from v8 on. Leaving them here as
    // well would give the subsystem two durable copies with no rule for which
    // wins, and the localStorage one cannot be workspace-scoped or synced.
    // `dexie-bridge.ts` owns them; only what is left is UI-shaped preference.
  }
}

export const useAgentTeamStore = create<AgentTeamState>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createAgentTeamActionsSlice(set, get),
    }),
    {
      name: AGENT_TEAM_STORAGE_KEY,
      storage: persistLocalStorage(),
      version: PERSIST_VERSION,
      partialize: partializeAgentTeamState,
    }
  )
)

registerProjectBucketPurger("agent-teams", (projectId) => {
  useAgentTeamStore.getState().purgeProject(projectId)
})

export function activateAgentTeamAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  const storageKey = agentTeamAccountStorageKey(accountId)
  useAgentTeamStore.persist.setOptions({ name: storageKey })
  useAgentTeamStore.setState({
    ...initialState,
    ...readAgentTeamPersistedState(storageKey),
  })
}

export function clearAgentTeamAccountStorage(): void {
  if (typeof window === "undefined") return
  useAgentTeamStore.persist.setOptions({ name: AGENT_TEAM_STORAGE_KEY })
  useAgentTeamStore.setState(initialState)
}

export function purgeAgentTeamAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(agentTeamAccountStorageKey(accountId))
}

/** Only the fields `partializeAgentTeamState` writes. */
function pickPersistedFields(state: Partial<AgentTeamState>): Partial<AgentTeamState> {
  const picked: Partial<AgentTeamState> = {}
  if (state.templates && typeof state.templates === "object") picked.templates = state.templates
  if (state.defaultConfig && typeof state.defaultConfig === "object")
    picked.defaultConfig = state.defaultConfig
  if (state.displayMode !== undefined) picked.displayMode = state.displayMode
  if (state.workspaceTab !== undefined) picked.workspaceTab = state.workspaceTab
  if (state.tasksView !== undefined) picked.tasksView = state.tasksView
  if (state.lastAdapterSyncVersion && typeof state.lastAdapterSyncVersion === "object")
    picked.lastAdapterSyncVersion = state.lastAdapterSyncVersion
  return picked
}

function readAgentTeamPersistedState(storageKey: string): Partial<AgentTeamState> {
  if (typeof window === "undefined") return {}
  const snapshot = window.localStorage.getItem(storageKey)
  if (!snapshot) return {}
  try {
    const parsed = JSON.parse(snapshot) as { state?: unknown; version?: unknown }
    // Same rule as the persist middleware: another version's blob is not read.
    if (parsed.version !== PERSIST_VERSION) return {}
    return parsed.state && typeof parsed.state === "object"
      ? pickPersistedFields(parsed.state as Partial<AgentTeamState>)
      : {}
  } catch {
    return {}
  }
}

export default useAgentTeamStore
