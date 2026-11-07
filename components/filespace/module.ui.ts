import { defineUiModule } from "@/lib/modules/define"

// The FileSpace's UI layer (ADR-0250 §14). Its host layer is
// `lib/filespace/module.ts`.
export default defineUiModule({
  id: "filespace",
  effects: [
    // The conversation's Files panel, registered with the chat dock's panel
    // registry in every window (ADR-0222, ADR-0214).
    { name: "files-dock-panel", load: () => import("./files-dock-panel") },
  ],
})
