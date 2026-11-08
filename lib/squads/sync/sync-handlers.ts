/**
 * What the squads module contributes to companion sync (ADR-0250 §14
 * `syncHandlers`): the pulls of the three team definition tables, which run
 * every inbound row through the squads definition contract
 * (`./agent-team-definitions.ts`). The host reads them with its generic reader.
 */

import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"
import { syncAgentTeamTasks, syncAgentTeammates, syncAgentTeams } from "./agent-team-definitions"

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  agentTeams: { pull: syncAgentTeams },
  agentTeammates: { pull: syncAgentTeammates },
  agentTeamTasks: { pull: syncAgentTeamTasks },
}
