/**
 * What the connectors contribute to companion sync (ADR-0250 §14
 * `syncHandlers`): the `conversationOverrides` pull, which skips rows a
 * relayed override mutation from this client still has in flight
 * (`./conversation-overrides.ts`). The host reads the table with its generic
 * reader.
 */

import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"
import { syncConversationOverrides } from "./conversation-overrides"

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  conversationOverrides: { pull: syncConversationOverrides },
}
