/**
 * What the memory module contributes to companion sync (ADR-0250 §14
 * `syncHandlers`): the `memories` table, whose rows cross encrypted under the
 * shared memory DEK, so both the pull and the host-side reader are the
 * module's (`./memory-sync.ts`).
 */

import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"
import { readMemoriesDelta, syncMemories } from "./memory-sync"

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  memories: { pull: syncMemories, serve: readMemoriesDelta },
}
