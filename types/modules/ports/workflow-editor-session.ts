// The `workflow-editor-session` capability port (ADR-0250 §14): what a
// conversation mounted in the visual workflow editor runs as. The send
// resolver keeps the session kind (`ChatSession.kind === "workflow-editor"`),
// the editor's specialist subagents and the continuity logic; the workflow
// module (`lib/workflow/module.ts`) provides the Workflow Copilot itself: its
// identity, the open workflow's snapshot, the strict tool lists and the one
// directory it may read. With no provider, the session keeps the prompt the
// resolver built and the resolver logs that the Copilot was not installed.

export interface WorkflowEditorSessionSetup {
  /** Replaces the system prompt: the Workflow Copilot identity, no character prelude. */
  systemPrompt: string
  /** Replaces the appended prompt: the open workflow's snapshot, when an editor is open. */
  appendSystemPrompt?: string
  /** Replaces the allow-list: the `wf_*` tools and Read. */
  allowedTools: readonly string[]
  /** Replaces the deny-list (defence in depth: Bash, writes, Computer Use). */
  disallowedTools: readonly string[]
  /** Replaces the directories the Read tool may reach. */
  additionalDirectories: readonly string[]
}

export interface WorkflowEditorSessionPort {
  /**
   * The setup for the editor conversation `sessionId` (minted as
   * `workflow:<workflowId>`). Without an open editor for that workflow the
   * snapshot is left out; the Copilot reads the graph with its tools.
   */
  prepare(sessionId: string): Promise<WorkflowEditorSessionSetup>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "workflow-editor-session": WorkflowEditorSessionPort
  }
}
