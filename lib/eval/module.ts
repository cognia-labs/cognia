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
  owns: ["lib/ai/eval/", "lib/plugin/eval/", "components/settings/eval/"],
  // Eval targets run chats, Squads, workflows and the twin; the routing lab
  // embeds router-fusion's panel; harness adoption applies recommendations.
  dependsOn: ["agent-team", "harness", "router-fusion", "twin", "workflow"],
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
  messages: "eval",
})
