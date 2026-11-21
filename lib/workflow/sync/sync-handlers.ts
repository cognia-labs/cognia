/**
 * What the workflow module contributes to companion sync (ADR-0250 §14
 * `syncHandlers`): the pull of the workflow definitions, which holds back
 * rows a paired client's queued edit has not reached the Host with yet.
 */

import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"

import { syncWorkflows } from "./workflows"

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  workflows: { pull: syncWorkflows },
}
