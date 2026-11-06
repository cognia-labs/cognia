import { defineUiModule } from "@/lib/modules/define"

// The radar module's UI layer (ADR-0250 §14). Its host layer is
// `lib/radar/module.ts`. The radar report fills the pet console's Extensions
// tab, the first module slot contribution (M2).
export default defineUiModule({
  id: "radar",
  slots: {
    "pet.console.tab": () => import("./pet-console-tab"),
  },
})
