/**
 * Lark bot-menu (快捷指令) → internal action mapping.
 *
 * Feishu bot menus are configured in the developer console; clicking one fires
 * an `application.bot.menu_v6` event carrying the menu item's `event_key`.
 * Feishu exposes no OpenAPI to create menus, so "registering" a quick command
 * in cognia-next means mapping that `event_key` to an action — a prompt or a
 * slash-command line — that the assistant turn should run.
 *
 * The command rows are the cross-adapter `IMQuickCommand` type; Feishu's
 * `event_key` is the row's `triggerKey`.
 */

import {
  resolveQuickCommand as resolveSharedQuickCommand,
  type IMQuickCommand,
} from "@/lib/connectors/quick-commands"

export type LarkQuickCommandActionType = "prompt" | "slash"

/**
 * First-match lookup of the Feishu `event_key` against the configured
 * quick-command list. Thin wrapper over the shared resolver so the Lark
 * adapter doesn't have to import from two paths.
 */
export function resolveQuickCommand(
  commands: IMQuickCommand[] | undefined,
  eventKey: string
): IMQuickCommand | undefined {
  return resolveSharedQuickCommand(commands, eventKey)
}
