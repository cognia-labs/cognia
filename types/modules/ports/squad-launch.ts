// The `squad-launch` capability port (ADR-0252 §3, ADR-0250 §14): start a
// Squad run as the child of another run. The kernel's launcher
// (`lib/execution/launch-child-run.ts`) asks for it; the squads module
// (`lib/squads/module.ts`) provides it. Nothing outside the squads module
// imports `startSquadRun` to launch a child.
//
// Unlike the launcher's other engines, a Squad run writes its own
// `execution:team:` row, inside the same admission transaction that writes
// its durable record. So the port takes the launching run's id and links it
// there, rather than the launcher writing a row first.

import type { StartedChildEngine } from "@/types/execution/child-run"

export interface SquadLaunchInput {
  squadId: string
  /** The work the Squad is asked to do, seeded as its objective. Blank keeps its own. */
  brief: string
  /** Gate-policy origin (`"delegation"`, `"room"`, …). */
  origin: string
  /** The run that launched this one; written as the Squad run's parent. */
  launchedByRunId?: string
  /** The conversation the parent belongs to, when it has one. */
  sessionId?: string
  ultracode?: boolean
}

export type SquadLaunchResult =
  | (StartedChildEngine & { started: true; executionRunId: string; squadRunId: string })
  | { started: false; reason: string }

export interface SquadLaunchPort {
  start(input: SquadLaunchInput): Promise<SquadLaunchResult>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "squad-launch": SquadLaunchPort
  }
}
