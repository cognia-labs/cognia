// The `inbound-jobs` capability port (ADR-0090 Phase 8, ADR-0250 §14): the
// durable jobs an IM message becomes. The connectors provide it
// (`lib/connectors/ports/inbound-jobs.ts`). Crash recovery finds the job a
// crashed agent run belongs to and continues it with a recovery anchor, and
// the plugin testing API seeds a job a test conversation is processing,
// without either importing the connectors' job store. With no provider there
// is no IM runtime: recovery refuses with `inbound-jobs-unavailable`, and the
// test seed throws.

import type { ConnectorInboundJobRow } from "@/lib/db/connector-types"

/** The fields recovery checks before it continues a job. */
export type RecoverableInboundJob = Pick<ConnectorInboundJobRow, "id" | "status" | "executionRunId">

export interface SeedRunningInboundJobInput {
  adapterId: string
  conversationKey: string
  platform: string
  /** The verified sender whose message is driving the turn. */
  sender: { id: string; remoteUserId: string; displayName?: string }
}

export interface InboundJobsPort {
  /** The job whose turn is execution run `runId`, if any. */
  findJobForRun(runId: string): Promise<RecoverableInboundJob | undefined>
  /** Continue a `recovery_required` job with its recovery anchor; false when it was not resumable. */
  continueJob(id: string, options: { recoveryAnchor: Record<string, unknown> }): Promise<boolean>
  /** Seed a conversation with a claimed job from a verified sender (plugin testing API). */
  seedRunningJob(input: SeedRunningInboundJobInput): Promise<{ id: string }>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "inbound-jobs": InboundJobsPort
  }
}
