// ── Topics the connectors publish (ADR-0250 §14) ─────────────────────────────
// Read with `useTopic` / `readTopic` / `subscribeTopic` (`lib/runtime/topics.ts`).
// A reader imports only these types, never the connectors' code; `undefined`
// means no connector bus has seen an inbound message in this window yet.

/**
 * `connectors.inbound`: the latest inbound platform message this window's
 * connector bus processed. `seq` grows by one per message, so a reader that
 * reacts to each one compares it with the last value it saw.
 */
export interface ConnectorsInboundTopic {
  seq: number
  /** When the bus processed it (ms since the epoch). */
  at: number
}

declare module "@/lib/runtime/topics" {
  interface TopicMap {
    "connectors.inbound": ConnectorsInboundTopic
  }
}
