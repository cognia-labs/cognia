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
 *   data. The brain adapter keeps `HeadlessRuntime.start`'s signature.
 * - `settings.keys` only declare which flat `AppSettings` keys the module
 *   owns; the wire stays `packages/agent-config-types/src/settings-sync.ts`.
 * - `capabilityContributions` produce `AgentCapabilityGrantV1` only
 *   (ADR-0198), applied stage by stage by the resolver chain. There is no
 *   ordering number and no `SendOptions` patching.
 * - `tables` only declare ownership; the schema stays in `CURRENT_SCHEMA`.
 *
 * The registries generated from these fields arrive registry by registry
 * (§13). Since M1, `searchProviders`, `slashCommands` and `settingsSections` are
 * generated (`scripts/build/gen-module-registry.mjs`) and read by their shells;
 * every other field is shape-checked by the gate and read by nothing yet.
 */

import type { ComponentType } from "react"

import type { SlashContext } from "@cognia/plugin-contract/lib/slash-commands/builtin"
import type { GlobalSearchProvider } from "@/lib/global-search/types"
import type { CapabilityId, HostProfile } from "@/lib/platform/capabilities"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"

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

/** A runtime behaviour with one assembly per host (ADR-0250 §2 adapter matrix). */
export interface ModuleRuntime {
  name: string
  criticality: "required" | "optional"
  adapters: Partial<Record<ModuleHost, LazyModule>>
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
  /** Modules this one may import through their `api` files. Acyclic. */
  dependsOn?: readonly string[]
  /** Concrete public files other modules may import. Never a barrel. */
  api?: readonly string[]
  provides?: readonly ModulePortProvision[]
  /** Ports this module needs; a trailing `?` marks an optional one (`"ocr?"`). */
  requires?: readonly string[]

  runtimes?: readonly ModuleRuntime[]
  settings?: { keys: readonly string[]; load?: LazyModule }
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
  /** `"fill"`: the section owns its scroll (a rail plus a detail pane). */
  layout?: "fill"
  /** Extra words the settings finder matches, in both languages. */
  keywords?: readonly string[]
  load: LazyModule<ModuleSettingsSectionModule>
}

export interface ModuleNavEntry {
  route: string
  icon: string
}

/** A side effect that needs React context, the router, i18n or toasts. Not a runtime. */
export interface ModuleEffect {
  name: string
  load: LazyModule
}

export interface UiModuleManifest {
  /** Equals the directory name: `components/<id>/module.ui.ts`. */
  id: string
  slots?: Partial<Record<CanonicalExtensionPoint, LazyModule>>
  settingsSections?: readonly ModuleSettingsSection[]
  nav?: readonly ModuleNavEntry[]
  effects?: readonly ModuleEffect[]
}
