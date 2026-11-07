import { defineHostModule } from "@/lib/modules/define"

// Project coordination (ADR-0204): a workspace's coordinator conversation,
// the worker threads it starts, their reports, pauses and pull requests.
export default defineHostModule({
  id: "project-coordinator",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: [
    "chat",
    "data",
    "fleet",
    "git",
    "github",
    "issues",
    "memory",
    "settings-store",
    "squads",
    "stack",
    "tasks",
    "usage",
  ],
  // The paused banner the chat view shows, the thread row and threads hook
  // the thread card reads, the suggested-threads card's start action, the
  // workspace overview's coordinator entry, board, usage panel and config,
  // the project access the chat controller reads, and the tool names the
  // result card reads.
  api: [
    "components/project-coordinator/project-coordinator-entry.tsx",
    "components/project-coordinator/project-paused-banner.tsx",
    "components/project-coordinator/project-threads-board.tsx",
    "components/project-coordinator/project-usage-panel.tsx",
    "components/project-coordinator/thread-row.tsx",
    "hooks/project-coordinator/use-project-threads.ts",
    "lib/project-coordinator/agent-tools.ts",
    "lib/project-coordinator/config.ts",
    "lib/project-coordinator/project-access.ts",
    "lib/project-coordinator/user-actions.ts",
  ],
  // The coordinator's and a thread's agent tools. Coordination is something
  // the user switched on for the workspace, and every effect is bounded
  // elsewhere: a thread's own tool calls go through that thread's
  // permissions, creation is capped per day and pausable, and a thread is an
  // ordinary conversation the user can open, stop or delete. So the
  // coordinator's job is allowed; only `set_project_preference`, which
  // changes those limits, asks. An explicit user rule overrides either way.
  // None of the runners honour a cancel signal.
  tools: {
    declare: {
      spawn_thread: { consent: "allow", effect: "write", cancellable: false },
      propose_threads: { consent: "allow", effect: "write", cancellable: false },
      start_thread: { consent: "allow", effect: "write", cancellable: false },
      message_thread: { consent: "allow", effect: "write", cancellable: false },
      list_threads: { consent: "allow", effect: "read", cancellable: false },
      read_thread_report: { consent: "allow", effect: "read", cancellable: false },
      stop_thread: { consent: "allow", effect: "write", cancellable: false },
      resolve_thread: { consent: "allow", effect: "write", cancellable: false },
      remember_project_note: { consent: "allow", effect: "write", cancellable: false },
      set_project_preference: { consent: "ask", effect: "write", cancellable: false },
      report_to_coordinator: { consent: "allow", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // The project goal (stable, after the workspace instructions) and the
  // coordinator's live project status (per turn, in the dynamic tail).
  context: { load: () => import("./context") },
})
