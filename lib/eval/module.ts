import { defineHostModule } from "@/lib/modules/define"

// Agent evaluation (datasets, runs, scorers, gates, calibration). The second
// M1 pilot (ADR-0250 §14): it checks the transitional ownership table, whose
// `eval` row and two path overrides become the claims below.
//
// Its engine stays where it grew, under `lib/ai/eval/` (split out of `ai`,
// analysis §11.1) with the plugin eval runner in `lib/plugin/eval/`; the
// settings section stays beside `/me/eval`, which embeds it on a paired phone.
//
// Stage: the analysis (§11.2) files eval under "experimental", but the module
// ships live today (`NEXT_PUBLIC_EVAL_LAB` only picks which workspace `/eval`
// renders), and an experimental module contributes nothing. It stays stable
// until turning it off is decided on its own.
export default defineHostModule({
  id: "eval",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // `eval-dataset-versions.ts` has no other user, so it moves with eval; the
  // other `lib/db/eval-*` accessors stay in the data layer, which logging,
  // harness and workflow reach them through.
  owns: [
    "lib/ai/eval/",
    "lib/plugin/eval/",
    "components/settings/eval/",
    "lib/db/eval-dataset-versions.ts",
  ],
  // Eval targets run chats, Squads, workflows and the twin; the routing lab
  // embeds router-fusion's panel; harness adoption applies recommendations.
  dependsOn: ["harness", "router-fusion", "squads", "twin", "workflow"],
  // What other modules use: artifact encryption (workflow blobs, knowledge,
  // quality, human input, perf captures), the online policy cache (logging),
  // tabular import (issues), recommendation application (harness), the
  // routing experiment (router-fusion), the twin benchmark and the eval node.
  api: [
    "lib/ai/eval/artifact-crypto.ts",
    "lib/ai/eval/import/parse-tabular.ts",
    "lib/ai/eval/online/policy-cache.ts",
    "lib/ai/eval/recommendation-application.ts",
    "lib/ai/eval/routing-experiment.ts",
    "lib/ai/eval/service.ts",
    "lib/ai/eval/twin-benchmark.ts",
  ],
  // Eval's preferences; only `lib/eval/settings.ts` writes them, and the
  // Eval section resets and reviews them.
  settings: { keys: ["evalSettings"] },
  // Every `eval*` table. Another module that reads one directly is a
  // `tableAccess` entry in the module baseline (ADR-0250 §14, G4).
  tables: [
    "evalAdjudications",
    "evalAssets",
    "evalCases",
    "evalConfigurationApplies",
    "evalDatasetVersions",
    "evalDatasets",
    "evalExperiments",
    "evalObservations",
    "evalOnlineBudget",
    "evalOnlinePolicies",
    "evalOnlineQueue",
    "evalProjects",
    "evalRecommendations",
    "evalReviewBatches",
    "evalReviewVotes",
    "evalRunCaseResults",
    "evalRuns",
    "evalSamples",
    "evalScores",
    "evalTasks",
  ],
  // The online-evaluation drain (`lib/ai/eval/online/scheduler.ts`). It
  // replaced the renderer's `OnlineEvalInitializer`.
  runtimes: [
    {
      name: "online-eval",
      criticality: "optional",
      adapters: {
        desktop: "./runtime/online-eval",
        mobile: "./runtime/online-eval",
      },
      absent: {
        brain:
          "The queue's producer and span store exist only in the renderer: the eval-online log transport bootstrapLogger configures, and the Dexie agentTraces table the renderer-side trace transport fills. A consumer alone would start a worker with nothing to consume, so the brain gets one together with a headless span feed, never before.",
      },
    },
  ],
  nav: [
    {
      id: "eval",
      route: "/eval",
      label: "eval.nav.label",
      icon: "ClipboardCheck",
      spotIcon: "eval",
      group: "auxiliary",
      category: "insights",
      after: "bots",
    },
  ],
  messages: "eval",
})
