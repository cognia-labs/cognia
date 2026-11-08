// Connector inbox → pet events. Every inbound platform message gives the pet a
// little nudge (and a sliver of XP) so it feels aware of incoming activity.
// The connectors announce each one on the `connectors.inbound` topic, so the
// pet never imports their code.

import { readTopic, subscribeTopic } from "@/lib/runtime/topics"
import type {} from "@/types/connectors/events"
import type { PetEmit } from "../pet-event-bus"

export function wireConnectorSource(emit: PetEmit): () => void {
  let lastSeq = readTopic("connectors.inbound")?.seq ?? 0
  return subscribeTopic("connectors.inbound", (inbound) => {
    if (!inbound || inbound.seq === lastSeq) return
    lastSeq = inbound.seq
    emit({ source: "connector", kind: "inboundMessage", xp: 1 })
  })
}
