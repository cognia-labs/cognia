import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { initialState } from "./initial-state"
import { createExternalAgentActionsSlice } from "./slices/actions.slice"
import type { ExternalAgentStore } from "./types"
import { withoutEnvironmentScopedVerdicts } from "@/lib/ai/agent/external/canonical-contract"

export const useExternalAgentStore = create<ExternalAgentStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      ...createExternalAgentActionsSlice(set, get),
    }),
    {
      name: "cognia-external-agents",
      version: 7,
      storage: persistLocalStorage(),
      partialize: (state) => ({
        agents: state.agents,
        delegationRules: state.delegationRules,
        activeAgentId: state.activeAgentId,
        agentValidity: withoutEnvironmentScopedVerdicts(state.agentValidity),
        benchmarkCapabilityMap: state.benchmarkCapabilityMap,
        lastRunSnapshots: state.lastRunSnapshots,
        defaultPermissionMode: state.defaultPermissionMode,
        autoConnectOnStartup: state.autoConnectOnStartup,
        showConnectionNotifications: state.showConnectionNotifications,
        chatFailurePolicy: state.chatFailurePolicy,
        overviewBannerCollapsed: state.overviewBannerCollapsed,
        railGroupBy: state.railGroupBy,
      }),
    }
  )
)

export default useExternalAgentStore
