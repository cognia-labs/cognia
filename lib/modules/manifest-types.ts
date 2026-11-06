/**
 * Feature module manifests (ADR-0250 §14).
 *
 * Every feature outside the kernel declares itself in two data-only files:
 *
 * - `lib/<id>/module.ts` — the host layer, through `defineHostModule`;
 * - `components/<id>/module.ui.ts` — the UI layer, through `defineUiModule`.
 *
 * They are the same two layers as the plugin contract (ADR-0250 §9), which
 * extends this schema rather than defining a second one.
 *
 * "Data only" is enforced by `scripts/gates/check-modules.mjs`: a manifest
 * imports nothing but its `define*` helper, and its top level holds literals
 * and lazy entries `() => import("…")`, never a schema, defaults or a side
 * effect. Every host imports the generated registries statically, so anything
 * eager here would land in every host's startup graph.
 *
 * Fields that an existing rule already owns follow that rule:
 * - `runtimes` carry one adapter per host — ADR-0250 §2's adapter matrix as
 *   data. The brain adapter keeps `HeadlessRuntime.start`'s signature and
 *   names the brain profiles (`HeadlessHost`) it starts on.
 * - `settings.keys` only declare which flat `AppSettings` keys the module
 *   owns; the wire stays `packages/agent-config-types/src/settings-sync.ts`.
 * - `capabilityContributions` produce `AgentCapabilityGrantV1` only
 *   (ADR-0198), applied stage by stage by the resolver chain. There is no
 *   ordering number and no `SendOptions` patching.
 * - `tables` only declare ownership; the schema stays in `CURRENT_SCHEMA`.
 *
 * The registries generated from these fields arrive registry by registry
 * (§13). `searchProviders`, `slashCommands` and `settingsSections` (M1), and
 * `nav`, `runtimes`, `slots` and `effects` (M2) are generated
 * (`scripts/build/gen-module-registry.mjs`) and read by their shells and hosts;
 * every other field is shape-checked by the gate and read by nothing yet.
 */

import type { ComponentType } from "react"

import type { SlashContext } from "@cognia/plugin-contract/lib/slash-commands/builtin"
import type { BootCapability } from "@/lib/boot/capabilities"
import type { HeadlessHost, HeadlessRuntime } from "@/lib/headless/types"
import type { GlobalSearchProvider } from "@/lib/global-search/types"
import type { CapabilityId, HostProfile } from "@/lib/platform/capabilities"
import type {
  CanonicalExtensionPoint,
  PluginPointFormFactor,
} from "@/lib/plugin/contracts/plugin-points"
import type { SidebarNavCategory, SidebarNavMeta } from "@/types/shell/sidebar"

/** A lazy entry. The only kind of code a manifest may hold. */
export type LazyModule<T = unknown> = () => Promise<T>

/** Hosts a generated registry exists for (`lib/modules/generated/<host>.ts`). */
export type ModuleHost = "brain" | "desktop" | "mobile"

/** `kernel` members are a closed list (ADR-0250 §14); everything else is a `module`. */
export type ModuleKind = "kernel" | "module"

/**
 * Lifecycle stage. An `experimental` module stays off the navigation and
 * starts no runtime; a disabled module also keeps its tables and shows
 * "disabled" on its routes.
 */
export type ModuleStage = "kernel" | "stable" | "beta" | "experimental" | "deprecated"

/** Real-world acceptance: a `stable` module still on `pending` makes the gate warn. */
export interface ModuleAcceptance {
  /** Evidence ledger under `docs/evidence/`. */
  evidence?: string
  realSmoke: "pending" | `passed:${string}`
}

/**
 * The renderer boot groups a runtime may wait for (`lib/boot/capabilities.ts`):
 * each deferred initializer group mounts a `ModuleRuntimeHost` for its own.
 */
export type ModuleRuntimeBoot = Extract<
  BootCapability,
  "core-chat" | "workflow-automation" | "integrations" | "knowledge-agents"
>

/** A started runtime's teardown. */
export type ModuleRuntimeTeardown = () => void | Promise<void>

/** What a renderer runtime (`desktop`, `mobile`) is started with. */
export interface RendererRuntimeContext {
  host: Exclude<ModuleHost, "brain">
  /** The unlocked local account; the runtime restarts when it changes. */
  accountId: string
  log: (level: "info" | "warn" | "error", message: string) => void
}

/** What a brain adapter's module exports: `HeadlessRuntime.start`, unchanged. */
export interface BrainRuntimeAdapter {
  start: HeadlessRuntime["start"]
}

/** What a desktop or mobile adapter's module exports. */
export interface RendererRuntimeAdapter {
  start(
    ctx: RendererRuntimeContext
  ): ModuleRuntimeTeardown | void | Promise<ModuleRuntimeTeardown | void>
}

/**
 * A runtime behaviour with one assembly per host (ADR-0250 §2 adapter matrix).
 *
 * An adapter is a module specifier, not a lazy entry: `./runtime/brain`
 * (beside the manifest) or `@/lib/…`. The generator writes each host's lazy
 * import into that host's registry only (`lib/modules/generated/<host>.ts`),
 * so a brain never reaches a desktop adapter through a manifest, and the
 * headless-registry gate never mistakes a desktop-only effect for one the
 * brain calls.
 *
 * Dormancy (Rule 7): an `experimental` module's runtimes start on no host
 * (`isActiveModule`), and `lib/modules/runtimes.test.ts` pins it.
 */
export interface ModuleRuntime {
  /** Kebab-case, unique across the brain roster and every module. */
  name: string
  criticality: "required" | "optional"
  /** The renderer group it waits for; absent means the main boot cluster. */
  boot?: ModuleRuntimeBoot
  adapters: {
    /**
     * The brain assembly and the brain profiles it starts on. Naming
     * `person-brain` widens what one member's partition process does, so the
     * runtime must also join `PERSON_BRAIN_RUNTIMES`.
     */
    brain?: { module: string; hosts: readonly HeadlessHost[] }
    desktop?: string
    mobile?: string
  }
  /** Why each host without an adapter has none. Every missing host needs one. */
  absent?: Partial<Record<ModuleHost, string>>
}

/** One runtime as a host's generated registry lists it. */
interface ModuleRuntimeEntryBase {
  /** The contributing module, and its stage: an `experimental` one starts nothing. */
  module: string
  stage: ModuleStage
  name: string
  criticality: ModuleRuntime["criticality"]
}

/** A brain runtime in `lib/modules/generated/brain.ts`. */
export interface BrainRuntimeEntry extends ModuleRuntimeEntryBase {
  hosts: readonly HeadlessHost[]
  load: LazyModule<BrainRuntimeAdapter>
}

/** A renderer runtime in `lib/modules/generated/{desktop,mobile}.ts`. */
export interface RendererRuntimeEntry extends ModuleRuntimeEntryBase {
  boot?: ModuleRuntimeBoot
  load: LazyModule<RendererRuntimeAdapter>
}

/** An implementation of a kernel capability port (`ocr`, `speech`, `forge`, …). */
export interface ModulePortProvision {
  port: string
  load: LazyModule
}

/** A contribution the shell or kernel collects lazily. */
export interface ModuleContribution {
  load: LazyModule
}

export interface ModuleFlag {
  default: boolean
}

/** What a module's `searchProviders` entry resolves to. */
export interface ModuleSearchProvidersModule {
  searchProviders: readonly GlobalSearchProvider[]
}

/** What a slash command's `load` resolves to: the handler, nothing else. */
export interface ModuleSlashCommandModule {
  run: (ctx: SlashContext) => void | Promise<void>
}

/**
 * An action command for the chat composer. The descriptor is data, so the
 * picker lists it without loading the module; `load` brings the handler when
 * the command runs. It joins `BUILTIN_SLASH_COMMANDS` (scope `builtin`).
 */
export interface ModuleSlashCommand {
  /** Without the leading slash; lower-case kebab. */
  name: string
  description: string
  /** Grouping bucket, as `SlashCommand.category` (defaults to `chat`). */
  category?: string
  argumentHint?: string
  argumentOptions?: readonly string[]
  load: LazyModule<ModuleSlashCommandModule>
}

export interface HostModuleManifest {
  /** Equals the directory name: `lib/<id>/module.ts`. */
  id: string
  kind: ModuleKind
  stage: ModuleStage
  /** A handle listed in `.github/CODEOWNERS`. Absent means the default owners. */
  owner?: string
  acceptance?: ModuleAcceptance

  /** Path prefixes owned beyond `{lib,components,hooks,stores,types,app}/<id>/`. */
  owns?: readonly string[]
  /**
   * The modules this one imports, through their `api` files: exactly those its
   * files import (G4). A kernel member is named for its UI module. Acyclic.
   */
  dependsOn?: readonly string[]
  /** Concrete public files other modules may import (G3). Never a barrel. */
  api?: readonly string[]
  provides?: readonly ModulePortProvision[]
  /** Ports this module needs; a trailing `?` marks an optional one (`"ocr?"`). */
  requires?: readonly string[]

  runtimes?: readonly ModuleRuntime[]
  /** `SettingsState` keys this module owns; its files read each, and no other module claims one (G4). */
  settings?: { keys: readonly string[]; load?: LazyModule }
  /** `CORE_TABLE_NAMES` tables this module owns; its files access each, and no other module claims one (G4). */
  tables?: readonly string[]
  /** Built-in tools together with their permission rules. */
  tools?: ModuleContribution
  /** Producers of `AgentCapabilityGrantV1` (ADR-0198). */
  capabilityContributions?: ModuleContribution
  /** Scheduler executors declared together with their task sources. */
  taskExecutors?: ModuleContribution
  builtinSkills?: ModuleContribution
  /** Plugin host API namespaces this module owns (ADR-0250 §9). */
  pluginApi?: { namespaces: readonly string[]; load: LazyModule }
  workflowNodes?: ModuleContribution
  /** Global-search providers (ADR-0129), registered beside the built-ins. */
  searchProviders?: LazyModule<ModuleSearchProvidersModule>
  slashCommands?: readonly ModuleSlashCommand[]
  /** Navigation catalog destinations, placed among the built-ins by `after`. */
  nav?: readonly ModuleNavEntry[]
  prompts?: LazyModule
  flags?: Readonly<Record<string, ModuleFlag>>
  /** i18n namespace under `i18n/messages/<locale>/`. */
  messages?: string
}

/** What a settings section's `load` resolves to. */
export interface ModuleSettingsSectionModule {
  default: ComponentType
}

/**
 * A section of the Settings page, as `NavItem` in
 * `components/settings/settings-nav-config.ts` describes the built-in ones.
 */
export interface ModuleSettingsSection {
  /** The `?section=` value. */
  id: string
  /** A `SettingsGroup` of the settings nav. */
  group: string
  /** A Lucide icon name from the catalog (`lib/icons/lucide-catalog.tsx`), e.g. `"Users"`. */
  icon: string
  /** Full i18n keys, in the module's own namespace: `"squads.settingsSection.label"`. */
  label: string
  description: string
  /** The section this one follows inside its group; absent means the end of the group. */
  after?: string
  /** As `NavItem.requires`: capabilities that must all be available. */
  requires?: readonly CapabilityId[]
  /** As `NavItem.profiles`: host profiles the section is bound to. */
  profiles?: readonly HostProfile[]
  /**
   * As `NavItem.hostOperation`: off the desktop, reachable only while the
   * paired host advertises this operation (a remote control of something
   * only the desktop runs, such as the pet's console).
   */
  hostOperation?: string
  /** `"fill"`: the section owns its scroll (a rail plus a detail pane). */
  layout?: "fill"
  /** Extra words the settings finder matches, in both languages. */
  keywords?: readonly string[]
  load: LazyModule<ModuleSettingsSectionModule>
}

/**
 * A destination on the navigation catalog: the desktop rail and its More
 * menu, the Go menu, ⌘K, the bar title and the surface boundary
 * (`lib/shell/sidebar-nav.ts:sidebarNavCatalog`), as `SidebarNavMeta`
 * describes the built-in ones.
 *
 * A host-layer field, although the rail is UI: every reader of the catalog is
 * under `lib/`, and the UI registry lives under `components/`, which `lib`
 * does not import (ADR-0250 phase 2). It is plain data, and the icon is a
 * name, so the brain carries only strings.
 */
export interface ModuleNavEntry {
  /** Stable key, persisted in `SidebarLayout`. Never reused or renamed. */
  id: string
  /** Top-level route under `app/`. */
  route: string
  /** Full i18n key in the module's own namespace: `"squads.nav.label"`. */
  label: string
  /** Full i18n key of a comma-separated list of extra ⌘K search terms. */
  aliases?: string
  /** A Lucide icon name from the catalog (`lib/icons/lucide-catalog.tsx`), e.g. `"Users"`. */
  icon: string
  /**
   * A `MobileSpotIconName`: the illustration the rail and the phone grid draw
   * in the illustrated icon style (`components/shell/navigation-icon.tsx`).
   */
  spotIcon: string
  /** As `SidebarNavMeta.group`. */
  group: SidebarNavMeta["group"]
  /** As `SidebarNavMeta.category`: the More-menu section. */
  category: SidebarNavCategory
  /**
   * The catalog id this entry follows, in the catalog and in the Go menu
   * alike; absent means the end of the catalog.
   */
  after?: string
  /** Where the Go menu places it, when that differs from `after`. */
  goMenuAfter?: string
  /** As `SidebarNavMeta.desktopOnly`. */
  desktopOnly?: boolean
  /** The route owns the viewport (`lib/shell/full-viewport-routes.ts`). */
  fullViewport?: boolean
  /**
   * A shortcut in the phone's quick-action grid (`lib/shell/mobile-home-nav.ts`),
   * under the same id, route, label and icons.
   */
  mobileShortcut?: {
    /** The shortcut id this one follows in the catalog; absent means the end. */
    after?: string
  }
}

/** What a lazily loaded module component resolves to: its default export. */
export interface ModuleComponentModule<P = Record<string, never>> {
  default: ComponentType<P>
}

/**
 * The props a module's slot component receives: the slot's form factor and
 * the context bag its host passes, the same two a plugin contribution gets.
 */
export interface ModuleSlotProps {
  formFactor: PluginPointFormFactor
  context?: Readonly<Record<string, unknown>>
}

/**
 * A side effect that needs React context, the router, i18n or toasts. Not a
 * runtime. `ModuleEffectsHost` (`components/providers/initializers/
 * module-effects-host.tsx`) renders every active module's effects in every
 * window, inside the app's providers; an effect decides for itself which
 * window it acts in. Its component renders the effect, usually `null`.
 */
export interface ModuleEffect {
  /** Lower-case kebab, unique within the module. */
  name: string
  load: LazyModule<ModuleComponentModule>
}

export interface UiModuleManifest {
  /** Equals the directory name: `components/<id>/module.ui.ts`. */
  id: string
  /**
   * Components filling canonical extension points (ADR-0250 §14). The point's
   * host renders them through `PluginExtensionSlot`, ahead of plugin
   * contributions and in module id order (`components/modules/slots.tsx`).
   */
  slots?: Partial<
    Record<CanonicalExtensionPoint, LazyModule<ModuleComponentModule<ModuleSlotProps>>>
  >
  settingsSections?: readonly ModuleSettingsSection[]
  effects?: readonly ModuleEffect[]
}
