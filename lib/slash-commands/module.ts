import { defineHostModule } from "@/lib/modules/define"

// Slash commands: the live registry, the built-in and custom commands, plugin
// and module commands merged into one list, their parsing and running in the
// composer, and the agent's `SlashCommand` tool over the same registry.
export default defineHostModule({
  id: "slash-commands",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // What the built-in command actions drive (G4 checks this equals what the
  // files import).
  dependsOn: [
    "artifact",
    "best-of-n",
    "context-workbench",
    "goal",
    "issues",
    "loop",
    "media",
    "memory",
    "skill-recorder",
    "squads",
    "workflow",
  ],
  // What other modules may import: the registry and the built-in list, the
  // composer's parsing, merging and running of command segments, custom
  // commands, the result blocks a command leaves in the transcript, and the
  // actions other surfaces run directly (the workflow editor's Copilot turns,
  // the side-chat shortcut, `/goal` from IM).
  api: [
    "lib/slash-commands/actions/goal.ts",
    "lib/slash-commands/actions/side-chat.ts",
    "lib/slash-commands/actions/workflow.ts",
    "lib/slash-commands/build-args.ts",
    "lib/slash-commands/builtin.ts",
    "lib/slash-commands/custom.ts",
    "lib/slash-commands/mention-boundary.ts",
    "lib/slash-commands/merge.ts",
    "lib/slash-commands/parse-segments.ts",
    "lib/slash-commands/plugin-commands.ts",
    "lib/slash-commands/registry.ts",
    "lib/slash-commands/run-segments.ts",
    "lib/slash-commands/system-blocks.ts",
  ],
  // The workflow Copilot turns `/run`, `/debug`, `/refactor` and the
  // subagent delegations send.
  prompts: () => import("./prompts"),
  // The agent's `SlashCommand` tool, opted in by `selfInvokeTools.slashCommand`.
  // It never had a tier, so the run's own approval decides (`"default"`). A
  // command can change anything a command can, so it counts as a write; the
  // runner takes no cancel signal.
  tools: {
    declare: {
      SlashCommand: { consent: "default", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
})
