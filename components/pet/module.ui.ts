import { defineUiModule } from "@/lib/modules/define"

// The pet's UI layer (ADR-0250 §14). Its host layer is `lib/pet/module.ts`.
export default defineUiModule({
  id: "pet",
  settingsSections: [
    {
      id: "pet",
      group: "appearance",
      icon: "PawPrint",
      label: "pet.settingsSection.label",
      description: "pet.settingsSection.description",
      after: "discover",
      // The section is the pet's whole console (ADR-0058 D16): there is no
      // `/pet` page. It owns its scroll, a header band over a scrolling pane.
      layout: "fill",
      // The pet runs only in the desktop shell (ADR-0058 D9). A paired phone
      // or browser cares for the desktop's pet from this same section
      // (ADR-0219), so off the desktop it is offered only while the paired
      // host advertises `pet_get`; the desktop-only parts (appearance,
      // insights, extensions) say so inside the console
      // (`lib/pet/console/action-capabilities.ts`).
      hostOperation: "pet_get",
      keywords: [
        "pet",
        "mascot",
        "companion",
        "buddy",
        "feed",
        "nurture",
        "shop",
        "dex",
        "achievements",
        "journal",
        "宠物",
        "桌宠",
        "伙伴",
        "喂养",
        "商店",
        "图鉴",
        "成就",
        "日记",
      ],
      load: () => import("@/components/settings/pet/pet-section"),
    },
  ],
  // The pet's controller: settings gate, event bus, profile, and the desktop
  // window's lifecycle. Mounted in every window by `ModuleEffectsHost`; it
  // runs only in the main one (`getPetWindowRole`). It replaced the app
  // runtime's hand-mounted `<PetMount />`.
  effects: [{ name: "pet-mount", load: () => import("./pet-mount") }],
})
