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
 * Phase M0 ships the schema and the ownership gate. The registries generated
 * from these fields arrive registry by registry from M1 on (§13), so until a
 * field's registry is generated the gate checks its shape and nothing reads it.
 */

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
  searchProviders?: LazyModule
  slashCommands?: LazyModule
  prompts?: LazyModule
  flags?: Readonly<Record<string, ModuleFlag>>
  /** i18n namespace under `i18n/messages/<locale>/`. */
  messages?: string
}

export interface ModuleSettingsSection {
  id: string
  group: string
  icon: string
  /** Hosts the section appears on; absent means every host. */
  requires?: readonly ModuleHost[]
  load: LazyModule
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
