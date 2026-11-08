import { defineHostModule } from "@/lib/modules/define"

// The desktop pet (ADR-0058). The M2 pilot for slots and effects (ADR-0250
// §14): its controller mounts from `components/pet/module.ui.ts` (`effects`),
// its console's Extensions tab is a slot other modules fill (radar does), and
// the console itself is the Pet settings section that manifest declares
// (ADR-0058 D16): the pet has no page or rail destination of its own.
export default defineHostModule({
  id: "pet",
  kind: "module",
  stage: "stable",
  acceptance: { realSmoke: "pending" },
  // The two native windows' routes and the settings section are the pet's;
  // `pet-conversation.ts` has no other user, so it moves with the pet. The
  // other `lib/db/pet*` accessors stay in the data layer, which the tray and
  // the glance read the profile through.
  owns: [
    "app/pet-overlay/",
    "app/pet-popup/",
    "components/settings/pet/",
    "lib/db/pet-conversation.ts",
    // Single-user data files: only the pet reads them (ADR-0250 M2).
    "lib/db/pet-media-packs.ts",
    "lib/db/pet-sprite-packs.ts",
    // The pet windows' native commands; the shared show and reveal commands
    // are the platform's (`lib/tauri/overlay-windows.ts`).
    "lib/tauri/pet-window.ts",
  ],
  // The event sources the pet reacts to (attention, background tasks,
  // capture, git, terminal; inbound IM messages arrive on the
  // `connectors.inbound` topic), what it remembers with (memory, twin), the
  // console's plugin slots, and the share hash its paired-phone client signs
  // with. G4 checks this equals what it imports.
  dependsOn: [
    "attention",
    "background-tasks",
    "capture",
    "git",
    "memory",
    "plugin",
    "share",
    "squads",
    "terminal",
    "twin",
    "workflow",
  ],
  // It speaks through the `speech` port, and stays silent without one. Its
  // lifecycle events reach installed Bots through `bot-dispatch` when a bot
  // module provides it.
  requires: ["speech?", "bot-dispatch?"],
  // What other modules use: which window this is (account gates, appearance,
  // the tray), revealing the pet (island, tray panel), the pet's view and care
  // condition (tray, glance), its paired-phone client and request ids (glance,
  // files library), the event bus workflows trigger on, and the console's
  // href (glance, ⌘K, the phone's Me tab).
  api: [
    "lib/pet/access/limits.ts",
    "lib/pet/care/condition.ts",
    "lib/pet/console-tabs.ts",
    "lib/pet/events/pet-event-bus.ts",
    "lib/pet/remote/client.ts",
    "lib/pet/runtime/pet-view.ts",
    "lib/pet/settings.ts",
    "lib/pet/workflow-trigger.ts",
  ],
  // The pet's preferences; only `lib/pet/settings.ts` writes them, and the
  // Pet section resets and reviews them.
  settings: { keys: ["petSettings"] },
  // Every live `pet*` table. Another module that reads one directly is a
  // `tableAccess` entry in the module baseline (ADR-0250 §14, G4).
  tables: [
    "petAchievements",
    "petActivityLog",
    "petCharacterBindings",
    "petConversationV2",
    "petInventory",
    "petMediaPacks",
    "petModelFiles",
    "petModels",
    "petProfile",
    "petSpritePacks",
  ],
  // The five tables a paired phone mirrors read-only (ADR-0219): their pulls,
  // and the host-side readers that project each row.
  syncHandlers: {
    tables: [
      "petProfile",
      "petAchievements",
      "petInventory",
      "petCharacterBindings",
      "petActivityLog",
    ],
    load: () => import("./sync/sync-handlers"),
  },
  slashCommands: [
    {
      // Desktop-app only, like the pet itself (ADR-0058 D9). It stays listed
      // on every host and answers honestly where the pet cannot run: the
      // handler goes through the pet's access gate.
      name: "pet",
      description: "Check on or care for your desktop pet (feed, play, clean, …).",
      category: "system",
      argumentHint: "<status | feed | play | pet | sleep | clean | treat>",
      argumentOptions: ["status", "feed", "play", "pet", "sleep", "clean", "treat"],
      load: () => import("./slash-command"),
    },
  ],
  // The agent's pet tools (`./agent-tools.ts`), offered on the desktop once
  // the user turns them on. The tier mostly removes prompts: without a rule
  // every call would raise a dialog, and the enforcement that matters is
  // elsewhere (the opt-in switch, the access gate's cooldown and daily
  // budget, clamped rewards). Reading and nurturing are allowed; `pet_show`
  // asks, because it raises an always-on-top window and switches the pet on
  // (a summon enables, ADR-0058 D9). An explicit user rule overrides either
  // way. None of the runners honour a cancel signal.
  tools: {
    declare: {
      pet_status: { consent: "allow", effect: "read", cancellable: false },
      pet_care: { consent: "allow", effect: "write", cancellable: false },
      pet_say: { consent: "allow", effect: "write", cancellable: false },
      pet_reward: { consent: "allow", effect: "write", cancellable: false },
      pet_show: { consent: "ask", effect: "write", cancellable: false },
    },
    load: () => import("./agent-tools"),
  },
  // Its persona, soul and sprite-hatch prompts, for the Prompt Center.
  prompts: () => import("./prompts"),
  messages: "pet",
  // Its workflow nodes (ADR-0250 §14 `workflowNodes`): the pet interaction and the pet-event
  // trigger's pass-through. The workflow engine loads them before it looks an executor up.
  workflowNodes: { load: () => import("./workflow-nodes") },
})
