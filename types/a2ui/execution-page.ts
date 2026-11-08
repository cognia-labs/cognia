/**
 * What an interactive page is built from (ADR-0250 §14 `interactive-page`
 * port): a completed workflow run with its event log, or a chat conversation
 * with its messages. a2ui's page builders (`lib/a2ui/from-execution/`) and the
 * modules that open a page through the port share these.
 */

import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

/** A completed (or terminal) workflow run plus its event log. */
export interface WorkflowRunPageSource {
  kind: "workflow-run"
  run: WorkflowRunRow
  events: WorkflowRunEventRow[]
  /** Falls back to `run.workflowSnapshot.name` when omitted. */
  workflowName?: string
}

/** A chat session plus its persisted messages, oldest-first. */
export interface ConversationPageSource {
  kind: "conversation"
  session: ChatSession
  messages: StoredMessage[]
}

export type ExecutionPageSource = WorkflowRunPageSource | ConversationPageSource
