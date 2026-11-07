import { defineUiModule } from "@/lib/modules/define"

// The tasks module's UI layer (ADR-0250 §14). Its host layer is
// `lib/tasks/module.ts`.
export default defineUiModule({
  id: "tasks",
  effects: [
    // The conversation's Tasks panel, registered with the chat dock's panel
    // registry in every window (ADR-0214).
    { name: "tasks-dock-panel", load: () => import("./tasks-dock-panel") },
  ],
})
