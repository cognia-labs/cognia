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
  // capture, connectors, git, terminal), what it speaks and remembers with
  // (memory, tts, twin), the console's plugin slots, and the share hash its
  // paired-phone client signs with. G4 checks this equals what it imports.
  dependsOn: [
    "attention",
    "background-tasks",
    "capture",
    "connectors",
    "git",
    "memory",
    "plugin",
    "share",
    "terminal",
    "tts",
    "twin",
  ],
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
  ],
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
  messages: "pet",
})
