// The `twin-answer` capability port (ADR-0252 §3, ADR-0250 §14): an Employee
// Digital Twin answers a question as a child run of another run. The kernel's
// launcher (`lib/execution/launch-child-run.ts`) asks for it and writes the
// child's row first; the provider only runs the answer.
//
// The squads module provides it today, because a twin answer has so far only
// been a Squad delegation and its persona injection lives with the
// teammates (`lib/squads/teammate/twin-context.ts`). It moves to the twin
// module when that module has a manifest; the contract does not change.

import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import type { StartedChildEngine } from "@/types/execution/child-run"

export interface TwinAnswerInput {
  twinId: string
  question: string
  /** Base instructions the twin's persona and knowledge are added to. */
  systemPrompt?: string
  /** Applied by the agent the twin answers through (ADR-0198). */
  grants: readonly AgentCapabilityGrantV1[]
}

export interface TwinAnswerPort {
  start(input: TwinAnswerInput): StartedChildEngine
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "twin-answer": TwinAnswerPort
  }
}
