import { defineHostModule } from "@/lib/modules/define"

// A2UI (ADR-0139, ADR-0240): the agent-rendered surfaces, their store and
// renderer, the app builder and gallery, interactive pages built from an
// execution, and the custom component catalogs. The pure protocol core is the
// `@cognia/a2ui-core` package. The send resolver asks this module for the
// turn's A2UI system-prompt section through the `a2ui-system-prompt` port, and
// workflow opens a run's interactive page through `interactive-page`, so
// neither imports it.
export default defineHostModule({
  id: "a2ui",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The app, debugger event and surface data files only A2UI reads.
  owns: ["lib/db/a2ui-apps.ts", "lib/db/a2ui-event-history.ts", "lib/db/a2ui-surfaces.ts"],
  // What the surfaces and the app builder build on (G4 checks this equals what
  // they import): chat's renderers and bindings, the theme, artifacts and
  // share for saved pages, icons, and workflow's run helpers for execution
  // pages.
  dependsOn: ["appearance", "artifact", "chat", "icons", "share", "workflow"],
  // What other modules may import: the surface renderers chat, share and
  // plugins draw, the store, the chat action routing, the interactive page
  // dialog the export and harness screens open, and the app templates.
  api: [
    "components/a2ui/a2ui-agent-catalog.tsx",
    "components/a2ui/a2ui-message-renderer.tsx",
    "components/a2ui/a2ui-surface.tsx",
    "components/a2ui/a2ui-tool-output.tsx",
    "components/a2ui/from-execution/interactive-page-dialog.tsx",
    "lib/a2ui/chat-action-routing.ts",
    "lib/a2ui/from-execution/conversation.ts",
    "lib/a2ui/templates/index.ts",
    "stores/a2ui/a2ui-store.ts",
  ],
  provides: [
    // The protocol section (and the agent's catalog section) a turn with A2UI
    // enabled carries.
    { port: "a2ui-system-prompt", load: () => import("./ports/system-prompt") },
    // The dialog that turns a workflow run or a conversation into a page.
    { port: "interactive-page", load: () => import("./ports/interactive-page") },
  ],
  // The protocol prompt, the app create/edit prompts and the execution-page
  // enhancer.
  prompts: () => import("./prompts-contribution"),
})
