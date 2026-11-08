import { defineHostModule } from "@/lib/modules/define"

// /goal (ADR-0019, ADR-0013): a session's standing objective, driven turn by
// turn until a judge accepts it.
export default defineHostModule({
  id: "goal",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  dependsOn: ["artifact", "chat", "data", "plugin", "twin", "usage", "workflow"],
  // The goal runtime and its turn driver, judge and pacing (chat, connectors,
  // loops, compaction, workflow nodes), the templates and analytics the
  // workflow goal nodes use, and the composer's status pill.
  api: [
    "components/goal/goal-status-pill.tsx",
    "components/goal/use-active-goal.ts",
    "lib/goal/analytics.ts",
    "lib/goal/judge-client.ts",
    "lib/goal/pacing.ts",
    "lib/goal/prompts.ts",
    "lib/goal/redact-objective.ts",
    "lib/goal/runtime.ts",
    "lib/goal/seed-templates.ts",
    "lib/goal/templates.ts",
    "lib/goal/turn-driver.ts",
  ],
  // An active goal's objective section and per-turn budget ceiling, on every
  // run of its session (ADR-0198 amendment).
  capabilityContributions: { load: () => import("./context-injector") },
  // The goal's system section, judge, subgoal and continuation prompts, for
  // the Prompt Center.
  prompts: () => import("./prompts"),
  // Its workflow nodes (ADR-0250 §14 `workflowNodes`): the goal and goal-template actions. The
  // workflow engine loads them before it looks an executor up.
  workflowNodes: { load: () => import("./workflow-nodes") },
})
