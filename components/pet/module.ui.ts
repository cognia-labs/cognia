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
      // The pet runs only in the desktop shell (ADR-0058 D9). Off desktop
      // every control here would configure a pet that never mounts, so the
      // section is unreachable there and a deep link renders the desktop-only
      // notice. A paired phone cares for the desktop pet through the /pet
      // console instead (ADR-0219), whose appearance page is desktop-only for
      // the same reason (`lib/pet/console/action-capabilities.ts`).
      profiles: ["desktop"],
      keywords: ["pet", "mascot", "companion", "buddy", "宠物", "桌宠", "伙伴"],
      load: () => import("@/components/settings/pet/pet-section"),
    },
  ],
  // The pet's controller: settings gate, event bus, profile, and the desktop
  // window's lifecycle. Mounted in every window by `ModuleEffectsHost`; it
  // runs only in the main one (`getPetWindowRole`). It replaced the app
  // runtime's hand-mounted `<PetMount />`.
  effects: [{ name: "pet-mount", load: () => import("./pet-mount") }],
})
