// What the /pet console can do in each of its two modes (ADR-0219).
//
// The pet lives on the desktop. The console runs `local` in the desktop app's
// main window, where it drives the pet controller directly, and `remote` on a
// paired phone or browser, where it reads a mirror of the pet tables and sends
// every action to the desktop over `pet_*` RPCs.
//
// Remote care covers the care loop: home, shop, inventory, hatch, rename, chat
// and the records (journal, dex, achievements). Some of the console works with
// things that exist only on the desktop and stays there on purpose:
//
//   - Appearance & settings: skins, Live2D models and sprite packs are
//     device-local blobs, and the size sliders shape a desktop window. The
//     sub-page still opens remotely, for the read-only character binding.
//   - Insights (Activity's second segment): the radar reads the desktop's
//     capture sources and activity.
//   - Plugins: `pet.console.tab` extensions are the desktop's plugins.
//   - Character binding edits, the customization reset, the "on the desktop"
//     toggle and the skin retry/configure actions: each one writes desktop
//     settings or desktop-only assets that no `pet_*` arm carries.
//
// That is intentional dormancy, labelled on all three axes (CLAUDE.md rule 7):
//
//  1. **Type**: this table is the one place a capability is classified, and
//     `petConsoleCapability` is how every caller asks.
//  2. **UI**: in remote mode the desktop-only places stay reachable with a
//     "Desktop" badge (the plugins tab, the insights segment, the header's
//     appearance entry) and render
//     `components/pet/console/desktop-only-notice.tsx`, the binding section is
//     read-only, and the desktop toggle becomes a status chip
//     (`components/pet/console/pet-console.tsx`).
//  3. **Test**: pinned by `lib/pet/console/action-capabilities.test.ts` and
//     `components/pet/console/pet-console.remote.test.tsx`.
//
// A desktop running the console locally has every capability; only `remote`
// consults the table.

import type { PetConsoleDestination } from "@/lib/pet/console-tabs"

export type PetConsoleMode = "local" | "remote"

/** Whether a console capability runs in this mode, or only on the desktop. */
export type PetConsoleCapability = "available" | "desktop-only"

export const PET_CONSOLE_CAPABILITY_IDS = [
  // Places (one per console destination).
  "tab.home",
  "tab.chat",
  "tab.shop",
  "tab.collection",
  "tab.dex",
  "tab.achievements",
  "tab.activity",
  "tab.journal",
  "tab.insights",
  "tab.appearance",
  "tab.plugins",
  /** The appearance sub-page's customization workspace (not its binding). */
  "appearance.customize",
  // Actions.
  "care",
  "shop.purchase",
  "item.use",
  "item.applyDecor",
  "rename",
  "hatch",
  "chat.send",
  "chat.clear",
  /** Turning pet chat (LLM speak) on: a desktop setting. */
  "chat.enable",
  "binding.edit",
  "reset",
  "desktop.toggle",
  "skin.retry",
  "skin.configure",
] as const

export type PetConsoleCapabilityId = (typeof PET_CONSOLE_CAPABILITY_IDS)[number]

/** How each capability behaves in remote mode. Local mode has every one. */
export const PET_CONSOLE_CAPABILITIES: Readonly<
  Record<PetConsoleCapabilityId, PetConsoleCapability>
> = Object.freeze({
  "tab.home": "available",
  "tab.chat": "available",
  "tab.shop": "available",
  "tab.collection": "available",
  "tab.dex": "available",
  "tab.achievements": "available",
  // Activity opens; its insights segment is the desktop's.
  "tab.activity": "available",
  "tab.journal": "available",
  "tab.insights": "desktop-only",
  // The sub-page opens for the read-only binding; its customization workspace
  // is `appearance.customize` and its binding edits are `binding.edit`.
  "tab.appearance": "available",
  "appearance.customize": "desktop-only",
  "tab.plugins": "desktop-only",
  care: "available",
  "shop.purchase": "available",
  "item.use": "available",
  "item.applyDecor": "available",
  rename: "available",
  hatch: "available",
  "chat.send": "available",
  "chat.clear": "available",
  "chat.enable": "desktop-only",
  "binding.edit": "desktop-only",
  reset: "desktop-only",
  "desktop.toggle": "desktop-only",
  "skin.retry": "desktop-only",
  "skin.configure": "desktop-only",
})

export function petConsoleCapability(
  mode: PetConsoleMode,
  id: PetConsoleCapabilityId
): PetConsoleCapability {
  if (mode === "local") return "available"
  return PET_CONSOLE_CAPABILITIES[id]
}

/** The capability that opens a console destination. */
export function petConsoleTabCapability(tab: PetConsoleDestination): PetConsoleCapabilityId {
  return `tab.${tab}`
}

/** Destinations that render the desktop-only notice instead of their panel in `mode`. */
export function petConsoleDesktopOnlyTabs<T extends PetConsoleDestination>(
  mode: PetConsoleMode,
  tabs: readonly T[]
): ReadonlySet<T> {
  return new Set(
    tabs.filter(
      (tab) => petConsoleCapability(mode, petConsoleTabCapability(tab)) === "desktop-only"
    )
  )
}
