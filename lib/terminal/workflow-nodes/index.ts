/**
 * The terminal module's workflow nodes (ADR-0250 §14 `workflowNodes`): the
 * dock command and its history and exit reads (`./dock`), the persistent
 * sessions (`./session`), which also register their run-end release, and
 * the script-file node (`./script`). Importing this file registers them.
 */

import type { ModuleWorkflowNodesModule } from "@/lib/modules/manifest-types"
import "./dock"
import "./session"
import "./script"

export const workflowNodeKinds: ModuleWorkflowNodesModule["workflowNodeKinds"] = [
  "action.system.terminal",
  "action.terminal.readRecent",
  "action.terminal.waitForExit",
  "trigger.terminal.command",
  "action.terminal.session.open",
  "action.terminal.session.run",
  "action.terminal.session.close",
  "action.terminal.script",
]
