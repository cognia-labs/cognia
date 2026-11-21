/**
 * Webhook-reply placement check (WF-09).
 *
 * A workflow with an `io.webhook.respond` node asks the receiver to hold the
 * inbound request open until the run replies. Only the Host that received the
 * request holds that connection, so a run that needs a dynamic reply is always
 * admitted on the ingress Host (`dispatchPlacedWorkflowTrigger` overrides the
 * Run Policy for it). A pin to another Host can therefore never be honoured for
 * those runs; refusing it here is what keeps the setting from silently lying.
 *
 * `colocate` and `auto` stay allowed (auto resolves to the ingress Host for a
 * held request), and so does a pin to `local` or to this Host's own ref. The
 * check is an error, so the publish gate refuses it on publish and on rollback.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { isLocalWorkflowHostRef } from "@/lib/workflow/runtime/local-host-ref"
import { makeDiagnostic } from "../diagnostic-id"
import type { Diagnostic } from "../types"

export function checkWebhookReplyPlacement(
  wf: VisualWorkflow,
  localHostRef?: string
): Diagnostic[] {
  const runOn = wf.settings?.runOn
  if (runOn?.mode !== "pinned" || isLocalWorkflowHostRef(runOn.ref, localHostRef)) return []
  // The same predicate the trigger sync uses to ask the router to hold the
  // request: any reply node, and a webhook trigger that is actually armed.
  const receivesWebhooks = wf.nodes.some(
    (node) => node.type === "trigger.webhook" && !node.data?.disabled
  )
  if (!receivesWebhooks) return []
  return wf.nodes
    .filter((node) => node.type === "io.webhook.respond")
    .map((node) =>
      makeDiagnostic({
        severity: "error",
        code: "webhookReplyPinnedRemote",
        nodeId: node.id,
        messageParams: { ref: runOn.ref },
      })
    )
}
