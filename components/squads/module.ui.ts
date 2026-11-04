import { defineUiModule } from "@/lib/modules/define"

// The Squads module's UI layer (ADR-0250 §14). Its host layer is
// `lib/squads/module.ts`.
export default defineUiModule({
  id: "squads",
  settingsSections: [
    {
      id: "squads",
      group: "agents",
      icon: "Users",
      label: "squads.settingsSection.label",
      description: "squads.settingsSection.description",
      after: "subagents",
      layout: "fill",
      keywords: [
        "squad",
        "squads",
        "小队",
        "team",
        "teams",
        "multi-agent",
        "supervisor",
        "round-robin",
        "agent team",
        "团队",
        "多代理",
      ],
      load: () => import("@/components/settings/squads/squads-section"),
    },
  ],
})
