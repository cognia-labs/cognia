import type { InboundJobsPort } from "@/types/modules/ports/inbound-jobs"
import { getDb } from "@/lib/db/schema"
import {
  claimConnectorInboundJob,
  continueConnectorInboundJobSafely,
  enqueueConnectorInboundJob,
} from "@/lib/db/connector-inbound-jobs"

export const port: InboundJobsPort = {
  findJobForRun: (runId) =>
    getDb()
      .connectorInboundJobs.filter((job) => job.executionRunId === runId)
      .first(),

  continueJob: (id, options) => continueConnectorInboundJobSafely(id, options),

  // A running job carries the VERIFIED sender, and that sender becomes the
  // only person (besides operators) the callback guard accepts a tap from, so
  // a test that proves an approval is not tappable by the wrong person needs
  // one of these.
  seedRunningJob: async (input) => {
    const job = await enqueueConnectorInboundJob(
      {
        platform: input.platform,
        adapterId: input.adapterId,
        selfId: "bot",
        messageId: `m_${input.sender.remoteUserId}`,
        conversationRef: { platform: input.platform, adapterId: input.adapterId },
        conversationKey: input.conversationKey,
        sender: {
          id: input.sender.id,
          platform: input.platform,
          adapterId: input.adapterId,
          remoteUserId: input.sender.remoteUserId,
          ...(input.sender.displayName ? { displayName: input.sender.displayName } : {}),
        },
        channel: { id: input.conversationKey, kind: "group" },
        segments: [{ type: "text", text: "run it" }],
        plainText: "run it",
        mentions: { selfMentioned: false, users: [] },
        timestamp: Date.now(),
        raw: {},
      } as never,
      "queue"
    )
    await claimConnectorInboundJob(job.id, { leaseOwner: "test", leaseMs: 60_000 })
    return { id: job.id }
  },
}
