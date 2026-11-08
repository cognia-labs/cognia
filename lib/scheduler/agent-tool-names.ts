/**
 * The agent's scheduler tools (`schedule_task`, `list_scheduled_tasks`,
 * `cancel_scheduled_task` on the `cognia` MCP server,
 * `lib/external-bridge/mcp-server/server.ts`). They are never offered by
 * default: a run gets them only where a conversation opted in and its channel
 * allows them (`schedule_tools`), or the run's own ceiling denies them.
 */
export const SCHEDULER_AGENT_TOOL_NAMES = [
  "mcp__cognia__schedule_task",
  "mcp__cognia__list_scheduled_tasks",
  "mcp__cognia__cancel_scheduled_task",
] as const
