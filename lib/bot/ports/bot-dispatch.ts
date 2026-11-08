import type { BotDispatchPort } from "@/types/modules/ports/bot-dispatch"
import { getDb } from "@/lib/db/schema"

// The bot module's `bot-dispatch` provider. Each method imports its source on
// first use, so a deployment with no bot installed does not load the control
// plane's module graph for every inbound message or finished run.
export const port: BotDispatchPort = {
  connectorInbound: async (input) => {
    const { dispatchConnectorInboundToBots } = await import("../sources/connector-inbound")
    const result = await dispatchConnectorInboundToBots(input)
    return result?.deferred ? { deferred: true } : {}
  },

  desktopEvent: async (input) => {
    const { dispatchDesktopEventToBots } = await import("../sources/desktop-event")
    await dispatchDesktopEventToBots(input)
  },

  workflowCompleted: async (input) => {
    const { dispatchWorkflowCompletedToBots } = await import("../sources/workflow-completed")
    await dispatchWorkflowCompletedToBots(input)
  },

  // Host-owned deliveries only: a row synced from the host is the host's to
  // cancel. Each one is cancelled through the runtime, which also stops a run
  // it already started.
  cancelConversationDeliveries: async ({ adapterId, conversationKey, cutoff }) => {
    const deliveries = await getDb()
      .botEventDeliveries.filter(
        (row) =>
          !row.syncedFromHost &&
          (row.envelope.receivedAt ?? row.receivedAt) <= cutoff &&
          row.envelope.binding?.adapterId === adapterId &&
          row.envelope.binding.conversationKey === conversationKey
      )
      .toArray()
    if (deliveries.length === 0) return 0
    const { cancelAcceptedBotDeliveries } = await import("../runtime/run")
    let cancelled = 0
    for (const row of deliveries)
      cancelled += await cancelAcceptedBotDeliveries(row.installationId, row.id)
    return cancelled
  },
}
