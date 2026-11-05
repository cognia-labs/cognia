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
  messages: "eval",
})
