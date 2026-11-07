import { defineHostModule } from "@/lib/modules/define"

// A conversation's tasks: the Tasks dock panel and its view model, and the
// agent's `spawn_task` handoff into a new sidechat.
export default defineHostModule({
  id: "tasks",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["agent", "artifact", "chat", "context-workbench"],
  // The task rows and progress the plan views and the chat draw (the status
  // glyph itself is shared, `components/shared/task-status-icon.tsx`), the
  // task view model they read, the Tasks panel, and the
  // spawn_task handoff the result card, the bridge and the sheet dispatch.
  api: [
    "components/tasks/session-tasks-panel.tsx",
    "components/tasks/task-progress-bar.tsx",
    "components/tasks/task-progress-chip.tsx",
    "components/tasks/task-update-row.tsx",
    "lib/tasks/agent-tools.ts",
    "lib/tasks/spawn-task-core.ts",
    "lib/tasks/spawn-task-dispatch.ts",
    "lib/tasks/task-view.ts",
  ],
  // `spawn_task` never had a tier of its own, so it keeps the run's approval
  // (`"default"`). It writes a new sidechat row and its runner takes no
  // cancel signal.
  tools: {
    declare: {
      spawn_task: { consent: "default", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
