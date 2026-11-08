/**
 * What the bot module contributes to companion sync (ADR-0250 §14
 * `syncHandlers`): the pulls of the installations (which skip rows a relayed
 * lifecycle mutation from this client still has in flight), the deliveries
 * (bounded by retention, with an opaque cursor) and the definitions. The host
 * reads all three tables with its own projections.
 */

import type { ModuleSyncHandlersModule } from "@/lib/modules/manifest-types"
import { syncBotDefinitions } from "./bot-definitions"
import { syncBotEventDeliveries } from "./bot-event-deliveries"
import { syncBotInstallations } from "./bot-installations"

export const syncHandlers: ModuleSyncHandlersModule["syncHandlers"] = {
  botInstallations: { pull: syncBotInstallations },
  botEventDeliveries: { pull: syncBotEventDeliveries },
  botDefinitions: { pull: syncBotDefinitions },
}
