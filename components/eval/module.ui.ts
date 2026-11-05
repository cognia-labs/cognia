import { defineUiModule } from "@/lib/modules/define"

// The eval module's UI layer (ADR-0250 §14). Its host layer is
// `lib/eval/module.ts`.
export default defineUiModule({
  id: "eval",
  settingsSections: [
    {
      id: "eval",
      group: "agents",
      icon: "ClipboardCheck",
      label: "eval.settingsSection.label",
      description: "eval.settingsSection.description",
      after: "fleet",
      keywords: [
        "eval",
        "evals",
        "evaluation",
        "agent eval",
        "judge",
        "judge model",
        "scorer",
        "scorers",
        "pass@1",
        "pass^k",
        "gate",
        "threshold",
        "calibration",
        "dataset",
        "benchmark",
        "deterministic",
        "评估",
        "评测",
        "评委",
        "评分器",
        "门限",
        "校准",
        "数据集",
        "基准",
      ],
      load: () => import("@/components/settings/eval/eval-settings-section"),
    },
  ],
})
