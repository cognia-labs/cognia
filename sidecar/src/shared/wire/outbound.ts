/** Provider payloads are opaque at the transport boundary; event kinds are stable. */
export interface CanonicalEvent {
  kind: string
  [key: string]: unknown
}
export interface AgentEventEnvelope {
  schemaVersion: 1
  eventId: string
  sequence: number
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  parentRunId?: string
  hostRef: string
  runtime?: string
  timestamp: string
  event: CanonicalEvent
}
export type OutboundFrame =
  | { type: "agent_event"; sessionId: string; envelope: AgentEventEnvelope }
  | { type: "ready"; sdkVersion?: string; sidecarVersion?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "runtime_warning"; sessionId: string; code: string; message: string }
  | {
      type: "session_ended"
      sessionId: string
      turnId?: string
      error?: string
      /**
       * The `result` frame that ended the turn. Both built-in rails attach it,
       * so a consumer settles off one terminal decision
       * (`@cognia/agent-config-types/turn-outcome`).
       */
      result?: unknown
      /** A Stop ended the turn: neither finished nor failed. */
      interrupted?: true
    }
  | {
      type: "control_response"
      sessionId: string
      requestId: string
      method: string
      ok: boolean
      result?: unknown
      error?: string
    }
