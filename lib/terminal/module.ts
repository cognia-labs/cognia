import { defineHostModule } from "@/lib/modules/define"

// The integrated terminal (ADR-0031, ADR-0033): local, SSH, serial and
// paired-host sessions, the dock, shell intelligence and the AI shell. A
// manifest module so the agent's dock tools are its own contribution rather
// than a branch in the kernel's plugin-tool dispatcher (ADR-0250 §14
// amendment).
export default defineHostModule({
  id: "terminal",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // What the terminal builds on (G4 checks this equals what it imports).
  dependsOn: [
    "agent-ecosystem",
    "chat",
    "companion",
    "device",
    "file-viewer",
    "memory",
    "plugin",
    "twin",
    "vscode-compat",
    "workflow",
    "workspace",
  ],
  // What other modules may import: sessions and their registries, the dock
  // runners, SSH profiles and connections, shell detection and completion,
  // and the hooks a pane mounts a transport or an SSH connection with.
  api: [
    "hooks/terminal/use-ssh-connect.tsx",
    "hooks/terminal/use-terminal-transport.ts",
    "lib/terminal/agent-session.ts",
    "lib/terminal/base-session.ts",
    "lib/terminal/completion/path-provider.ts",
    "lib/terminal/completion/shell-builtins.ts",
    "lib/terminal/completion/spec/index.ts",
    "lib/terminal/completion/spec/resolve.ts",
    "lib/terminal/completion/tokenize.ts",
    "lib/terminal/dock-tool-handler.ts",
    "lib/terminal/headless-exec.ts",
    "lib/terminal/headless-session-registry.ts",
    "lib/terminal/host-capabilities.ts",
    "lib/terminal/host-settings.ts",
    "lib/terminal/pick-transport.ts",
    "lib/terminal/remote-api.ts",
    "lib/terminal/run-cognia.ts",
    "lib/terminal/run-in-dock.ts",
    "lib/terminal/saved-ssh-hosts.ts",
    "lib/terminal/script-runner.ts",
    "lib/terminal/session-registry.ts",
    "lib/terminal/session.ts",
    "lib/terminal/shell-detect.ts",
    "lib/terminal/spawn-orchestrator.ts",
    "lib/terminal/ssh-connect.ts",
    "lib/terminal/ssh-forwarding.ts",
    "lib/terminal/ssh-host-key.ts",
    "lib/terminal/ssh-probe.ts",
    "lib/terminal/ssh-profiles.ts",
    "lib/terminal/tab-appearance.ts",
    "lib/terminal/terminal-links.ts",
    "lib/terminal/terminal-settings-link.ts",
    "lib/terminal/types.ts",
    "stores/terminal/terminal-store.ts",
  ],
  prompts: () => import("./prompts"),
  // The agent's dock tools (`./agent-tools.ts`), offered only when the person
  // lets agents use the dock. They never had a tier, so the run's own
  // approval decides (`"default"`). Opening a tab and typing into one change
  // the person's shell (`write`); reading a tab's recent commands and
  // waiting for its command to end only read. None of the runners takes a
  // cancel signal: a write waits for the command it typed.
  tools: {
    declare: {
      terminal_dock_spawn: { consent: "default", effect: "write", cancellable: false },
      terminal_dock_write: { consent: "default", effect: "write", cancellable: false },
      terminal_dock_read_recent: { consent: "default", effect: "read", cancellable: false },
      terminal_dock_wait_for_exit: { consent: "default", effect: "read", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // Its workflow nodes (ADR-0250 §14 `workflowNodes`): the dock command, the persistent sessions
  // (which register their run-end release) and the script-file node. The workflow engine loads
  // them before it looks an executor up.
  workflowNodes: { load: () => import("./workflow-nodes") },
})
