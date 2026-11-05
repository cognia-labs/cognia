import { loggers } from "@cognia/logging"
import { createDiagnostic } from "@cognia/diagnostics"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import type { HostStateAction } from "@cognia/agent-config-types/host-state"

/**
 * What a paired client does when the Host refuses one of its list intents.
 *
 * The conversation-list intents (`session.pin` / `folder` / `order` /
 * `workspace` / `delete` and the four `folder.*` ones) and a model pick
 * (`session.model`) are routed to the Host instead of being written locally,
 * and every Host of this release knows them. A refusal is the Host's answer:
 * nothing is applied locally, the person is told (a conflict is a race the
 * resync settles, not an answer to report), and the one optimistic write the
 * client made, the row of a `folder.create`, is discarded again so it does
 * not linger as a folder only this device can see.
 *
 * Every other intent kind is left alone: its rejection is already reconciled
 * by the HostState resync the outbound queue requests.
 */
export async function settleRejectedHostStateIntent(
  action: HostStateAction,
  rejectionCode: string | undefined,
  outcome: "rejected" | "conflicted" = "rejected"
): Promise<void> {
  try {
    // Said, not swallowed: the person made this change and nothing happened.
    // A conflict is a race the resync settles, not an answer to report.
    if (outcome === "rejected" && ANNOUNCED_REFUSALS.has(action.action.kind)) {
      announceRefusal(action, rejectionCode)
    }
    if (action.action.kind === "folder.create") {
      const { discardLocalFolder } = await import("@/lib/db/session-folders")
      await discardLocalFolder(action.action.folderId)
    }
  } catch (error) {
    // Settlement runs after the receipt is recorded; a failure here (a local
    // handoff lock, a row deleted meanwhile) must not turn a settled row back
    // into a retry. The Host's refusal stands and the next sync reconciles.
    loggers.sync.warn("[host-state] settling a refused list intent failed", {
      kind: action.action.kind,
      actionId: action.actionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The changes a person makes to a conversation or the list, refused by the
 * Host. A refused send, steer or answer has its own surface (the chat's
 * failure banner, item 9 of the multi-user plan), and a refused new chat is
 * `hostSessionRefused`; a draft is background bookkeeping nobody asked for.
 */
const ANNOUNCED_REFUSALS: ReadonlySet<HostStateAction["action"]["kind"]> = new Set([
  "session.rename",
  "session.archive",
  "session.pin",
  "session.folder",
  "session.order",
  "session.workspace",
  "session.model",
  "session.delete",
  "folder.create",
  "folder.rename",
  "folder.reorder",
  "folder.delete",
])

function announceRefusal(action: HostStateAction, rejectionCode: string | undefined): void {
  dispatchDiagnostic(
    createDiagnostic("hostStateIntentRefused", {
      source: "chat",
      message: rejectionCode ?? "host_state_rejected",
      meta: {
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
        extra: { kind: action.action.kind, actionId: action.actionId },
      },
    })
  )
}
