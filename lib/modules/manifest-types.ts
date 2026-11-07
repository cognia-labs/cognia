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
 * - `settings.keys` declare which flat `AppSettings` keys the module owns;
 *   the wire stays `packages/agent-config-types/src/settings-sync.ts`. The
 *   module reads and writes them through `defineSettingsView(keys)`
 *   (`stores/settings/view.ts`), and the settings page's per-section reset
 *   and changed-settings review take them from here.
 * - `capabilityContributions` produce `AgentCapabilityGrantV1` only
 *   (ADR-0198), applied stage by stage by the resolver chain. There is no
 *   ordering number and no `SendOptions` patching.
 * - `tools` declare each tool's consent, effect and dispatch order as data,
 *   and load the family that offers and runs them; the kernel derives the
 *   ruleset and every name list from the declaration (ADR-0250 §14 amendment).
 * - `context` produces system-prompt sections only; the kernel places,
 *   PII-gates and reports them (ADR-0250 §14 `context` amendment).
 * - `tables` only declare ownership; the schema stays in `CURRENT_SCHEMA`.
 *
 * The registries generated from these fields arrive registry by registry
 * (§13). `searchProviders`, `slashCommands` and `settingsSections` (M1), and
 * `nav`, `runtimes`, `slots` and `effects` (M2) are generated
 * (`scripts/build/gen-module-registry.mjs`) and read by their shells and hosts;
 * `provides` and `requires` (M3) are read by `lib/modules/ports.ts` from the
 * host registry, and `prompts`, `capabilityContributions`, `tools` and
 * `context` (M3) by the prompt catalog, the send resolver and the tool
 * dispatcher, each from its own generated registry. Every other field is shape-checked by the gate and
 * read by nothing yet.
 */

import type { ComponentType } from "react"
import type { AppSettings, Character, ChatSession, Skill } from "@cognia/agent-config-types"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"

import type { SlashContext } from "@cognia/plugin-contract/lib/slash-commands/builtin"
import type { BootCapability } from "@/lib/boot/capabilities"
import type { HeadlessHost, HeadlessRuntime } from "@/lib/headless/types"
import type { GlobalSearchProvider } from "@/lib/global-search/types"
import type { PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import type { PromptDefinitionV1, PromptResolutionContext } from "@/lib/prompts/types"
import type { Goal } from "@/types/goal"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import type { Project } from "@/types"
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

/**
 * What a module's `prompts` entry resolves to: the module's code-owned prompt
 * definitions (ADR-0236), which the prompt catalog lists beside the kernel's.
 * Each definition still lives with its consumer; this file only lists them.
 */
export interface ModulePromptsModule {
  prompts: readonly PromptDefinitionV1[]
}

/** One module's prompts as `lib/modules/generated/prompts.ts` lists them. */
export interface ModulePromptsEntry {
  /** The contributing module, and its stage: an `experimental` one contributes nothing. */
  module: string
  stage: ModuleStage
  load: LazyModule<ModulePromptsModule>
}

/**
 * What a module may put in a contributed grant (ADR-0198 amendment): every
 * grant field except the caller's own choices for its run (`model`,
 * `provider`, `effort`, `maxTurns`, `permissionProfile`). The kernel stamps
 * the schema version and the source, `{ kind: "module", id: "<module>/<id>" }`.
 */
export type ContributedCapabilityGrant = Omit<
  AgentCapabilityGrantV1,
  "schemaVersion" | "source" | "model" | "provider" | "effort" | "maxTurns" | "permissionProfile"
>

/**
 * What a contribution reads about the run. Read-only, and nothing a caller
 * injected (no `SendOptions`, no retrieval dependencies).
 */
export interface CapabilityContributionContext {
  /** The run's session; `null` for a run without one. */
  session: Readonly<ChatSession> | null
  /** The agent the run resolved, before any routing fallback. */
  agent: Readonly<Character> | null
  /** The person's settings as the run reads them. */
  settings: Readonly<AppSettings> | null
  /** The session's active goal, as the caller passed it. */
  activeGoal: Readonly<Goal> | null
  /** The run's frozen Prompt Center view (ADR-0236): resolve contributed wording against it. */
  prompts: { snapshot: PromptOverrideSnapshot | null; context: PromptResolutionContext }
}

/**
 * One grant a module contributes to every run it applies to (ADR-0198
 * amendment, ADR-0250 §14). `produce` returns `null` when it does not apply.
 *
 * `failure` says what a failure means (a throw, the deadline, a refused
 * grant). `"skip"` leaves the contribution out and reports it; such a
 * contribution may only add (instructions, tools, skills, servers, knowledge
 * bases), so losing it never widens a run. `"refuse-turn"` fails the
 * resolution instead, and is required for anything that narrows: a deny
 * list, an allow-list restriction, a removal, a subagent subset, a
 * permission cap or a budget.
 */
export interface CapabilityContribution {
  /** Unique within the module; the grant's source id is `<module>/<id>`. */
  id: string
  failure: "skip" | "refuse-turn"
  produce(
    ctx: CapabilityContributionContext
  ): ContributedCapabilityGrant | null | Promise<ContributedCapabilityGrant | null>
}

/** What a module's `capabilityContributions.load` resolves to. */
export interface ModuleCapabilityContributionsModule {
  contributions: readonly CapabilityContribution[]
}

/** One module's contributions as `lib/modules/generated/capabilities.ts` lists them. */
export interface ModuleCapabilityContributionsEntry {
  /** The contributing module, and its stage: an `experimental` one contributes nothing. */
  module: string
  stage: ModuleStage
  load: LazyModule<ModuleCapabilityContributionsModule>
}

/**
 * How a contributed tool is consented to (ADR-0250 §14 amendment). The kernel
 * turns it into the lowest ruleset layer: `"allow"` and `"ask"` as named,
 * `"per-call"` as `"ask"` plus `requiresApproval` on the manifest entry, which
 * with the sidecar's `PER_CALL_PLUGIN_TOOL_NAMES` means no remembered grant,
 * mode or auto-answer skips the question. `"default"` adds no rule: the run's
 * own approval decides, as for any tool nobody wrote a rule for (it asks
 * unless a remembered grant, the mode or a person's rule allows it).
 */
export type ModuleToolConsent = "allow" | "ask" | "per-call" | "default"

/**
 * What a call does. `"read"` reads; `"write"` changes the app's or the
 * person's own state; `"outbound"` gives or sends something to someone else
 * (the `outbound` permission class, the risk classifier's `external-send`, the
 * outbound policy engine's review). A harness probe is denied every tool that
 * is not `"read"`.
 */
export type ModuleToolEffect = "read" | "write" | "outbound"

/** One tool as its manifest declares it: data, read without loading the module. */
export interface ModuleToolDeclaration {
  consent: ModuleToolConsent
  effect: ModuleToolEffect
  /** The call reads or writes stored credentials: the `secrets` permission class. */
  secrets?: true
  /**
   * The runner does not honour `ToolCallContext.signal`, so a cancelled call
   * may keep going. Live voice does not advertise such a tool.
   */
  cancellable?: false
  /**
   * Dispatched after the plugin registry rather than before it: the tool is a
   * stand-in for one a plugin normally registers under the same name.
   */
  precedence?: "fallback"
}

/** Where a run is being resolved, for a family that offers different tools per host. */
export type ToolSurfaceHost = "desktop" | "web" | "mobile" | "cli" | "brain"

/** What a tool family reads to decide what to offer a run. Read-only, no `SendOptions`. */
export interface ToolSurfaceContext extends CapabilityContributionContext {
  host: ToolSurfaceHost
  /** The run's workspace (`resolveSessionWorkspace`), not whichever one is on screen. */
  activeProject: Readonly<Project> | null
  /**
   * The skills the run resolved (the agent's and the conversation's, after
   * disables and a grant's removals), by id and kind; absent when the caller
   * resolved none.
   */
  skills?: readonly Pick<Skill, "id" | "kind">[]
  /**
   * The session state one of this module's context contributions left for
   * the run's conversation at this resolution (`ContextSection.sessionState`),
   * by contribution id; `undefined` when it left none or the run has no
   * session. Set by the kernel, scoped to the asking module.
   */
  sessionState?(contributionId: string): unknown
}

/** One tool a family offers a run, as the model sees it. */
export interface ModuleToolEntry {
  /** A name the module's `tools.declare` lists. */
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  /** Relay round-trip ceiling (ms); omitted means the sidecar's default. */
  timeoutMs?: number
  /** Parameters whose values are filesystem paths, for workspace confinement. */
  pathParams?: readonly string[]
  /** Filesystem access class, for workspace confinement. */
  access?: "read" | "write"
}

/** What a family offers one run. */
export interface ToolSurface {
  tools: readonly ModuleToolEntry[]
  /**
   * Session-stable guidance for these tools, appended to the system prompt
   * inside the cached prefix. Text that changes from turn to turn does not
   * belong here.
   */
  instructions?: string
}

/** The call a family's `run` executes. */
export interface ToolCallContext {
  /** The calling conversation; never whatever happens to be open. */
  sessionId: string
  toolUseId: string
  turnId?: string
  executionRunId: string
  signal?: AbortSignal
  sandboxRuntimeRef?: string
  /** What an outbound delivery made during the call names as its authority (ADR-0239). */
  outboundAuthorization: { kind: "tool-call"; sessionId: string; toolUseId: string }
  /**
   * The session state one of this module's context contributions left for
   * the calling conversation at its last resolution (`ContextSection.sessionState`),
   * by contribution id; `undefined` when it left none. Set by the kernel.
   */
  sessionState?(contributionId: string): unknown
}

/**
 * A module's in-process tools (ADR-0250 §14 amendment). `surface` decides
 * which declared tools a run is offered, or `null` for none; the kernel
 * derives their consent tier from the declaration of exactly those, so a tier
 * is never offered apart from its tools. `run` executes one call and reports
 * a failure in its result rather than throwing.
 */
export interface ModuleToolFamily {
  surface(ctx: ToolSurfaceContext): ToolSurface | null | Promise<ToolSurface | null>
  run(name: string, args: Record<string, unknown>, call: ToolCallContext): Promise<unknown>
}

/**
 * Where a context section sits in `systemPrompt`, in prompt order: after the
 * workspace instructions, among the kernel's own retrieval sections. A closed
 * list, so a migrated section lands where its kernel branch put it.
 *
 * `identity` is not a position but a replacement: the section stands in for
 * the agent's base system prompt and the persona section is left out (the
 * twin, which speaks as a person). One module at most declares it, and its
 * contribution runs before every other one, which read what it retrieved as
 * `ctx.kernelRetrieval.identityTexts`.
 */
export type ContextSlot =
  "identity" | "project-goal" | "memory" | "continuity" | "project-knowledge" | "agent-knowledge"

/**
 * Host-built dependencies a caller injects into a resolution (a vector
 * backend, an embedder, a workflow's knowledge access), by name. Empty here:
 * the module that reads one declares it by merging into this map from
 * `types/<id>/**`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by the modules that read one
export interface ContextHostDepsMap {}

/**
 * What a context contribution reports for the UI (sources, budgets), keyed by
 * `<module>.<id>`. Empty here: each contributing module declares its entry by
 * merging into this map from `types/<id>/**`; readers use `contextSourcesOf`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by contributing modules
export interface ContextSourcesMap {}

/** What a context contribution reads about the run. Read-only, no `SendOptions`. */
export interface ContextTurnContext extends Omit<ToolSurfaceContext, "sessionState"> {
  /** The turn's retrieval query: its text and, when the caller computed one, its embedding. */
  query: { text: string | null; embedding: readonly number[] | null }
  /** Dependencies the caller injected, by name; an absent one means the host has none. */
  hostDeps: Readonly<Partial<ContextHostDepsMap>>
  /** The run's folded capability grant (knowledge bases and the rest), or `null`. */
  grant: Readonly<AgentCapabilityGrantV1> | null
  /**
   * What was already retrieved for this turn's prompt before the other
   * contributions ran, so a contribution can leave out what the prompt holds
   * anyway: the redacted texts the `identity` section handed over (memory
   * recall deduplicates against them). Empty when no identity section ran.
   */
  kernelRetrieval: { identityTexts: readonly string[] }
  /**
   * For a contribution that names `after`: the `handoff` the contribution it
   * waits for returned. `undefined` when that one failed, missed its deadline,
   * answered `null` or handed nothing over, and for every other contribution.
   */
  prior?: unknown
}

/** What a contribution adds to one run. */
export interface ContextSection {
  /** The section as the model reads it. Blank text adds nothing. */
  text: string
  /** For the UI, under `contextSources["<module>.<id>"]`; typed by `ContextSourcesMap`. */
  sources?: unknown
  /**
   * What this module's tools read at call time for the same conversation
   * (`ToolCallContext.sessionState`). Replaced on every resolution.
   */
  sessionState?: unknown
  /**
   * What a later contribution of the same module that names this one in
   * `after` reads as `ctx.prior` (a budget it may borrow, say). Kept for this
   * resolution only: never in the prompt, the sources or the session state.
   * An `identity` section hands over the redacted texts it retrieved instead
   * (a list of strings), which every other contribution reads as
   * `ctx.kernelRetrieval.identityTexts`.
   */
  handoff?: unknown
  /**
   * For an `identity` section: `text` split into the part stable within a
   * session and the part retrieved for this turn. With cache optimization on
   * the stable part replaces the base system prompt and the dynamic part goes
   * to the dynamic tail; without a split (or with it off) `text` replaces it
   * whole. Ignored for every other slot.
   */
  cacheSplit?: { stable: string; dynamic: string }
}

/**
 * A system-prompt section a module adds to the runs it applies to
 * (ADR-0250 §14 `context` amendment). `produce` returns `null` when it does
 * not apply.
 *
 * - `cache: "turn"` text changes from turn to turn: it goes to the dynamic
 *   tail, outside the cacheable prefix, when cache optimization is on, and to
 *   its `slot` when it is off. Without a `slot` it always goes to the tail.
 * - `cache: "session"` text is stable within a session: it always goes to its
 *   `slot`, which it must name.
 * - `pii: "redacted-at-source"` says the text comes from a store that is
 *   already redacted; every other section passes the kernel's PII gate and is
 *   dropped when it leaks.
 *
 * - `after` names another contribution of the same module that this one
 *   waits for, reading what it handed over as `ctx.prior`. One level only:
 *   the one waited for names no `after` itself. Everything else runs
 *   concurrently.
 *
 * Context only adds, so a failure (a throw, the deadline, malformed text)
 * leaves the section out and is reported; it never refuses the turn.
 */
export interface ContextContribution {
  /** Unique within the module; its key elsewhere is `<module>.<id>`. */
  id: string
  cache: "turn" | "session"
  slot?: ContextSlot
  pii?: "gate" | "redacted-at-source"
  /**
   * How long this contribution may take, in ms, when it retrieves over the
   * network; the kernel's default otherwise. Capped by the kernel.
   */
  deadlineMs?: number
  /**
   * The id of the contribution of the same module this one runs after; its
   * own deadline starts when that one settles.
   */
  after?: string
  produce(ctx: ContextTurnContext): ContextSection | null | Promise<ContextSection | null>
}

/** What a module's `context.load` resolves to. */
export interface ModuleContextModule {
  contributions: readonly ContextContribution[]
}

/**
 * What a module's `workflowNodes.load` resolves to. Importing the file
 * registers the module's node executors (`registerNodeExecutor`), as every
 * node family does; `workflowNodeKinds` names the kinds it registers, which
 * the loader checks once the import has run.
 */
export interface ModuleWorkflowNodesModule {
  workflowNodeKinds: readonly WorkflowNodeKind[]
}

/** One module's node executors as `lib/modules/generated/workflow-nodes.ts` lists them. */
export interface ModuleWorkflowNodesEntry {
  /** The contributing module, and its stage: an `experimental` one contributes nothing. */
  module: string
  stage: ModuleStage
  load: LazyModule<ModuleWorkflowNodesModule>
}

/** One module's context contributions as `lib/modules/generated/context.ts` lists them. */
export interface ModuleContextEntry {
  /** The contributing module, and its stage: an `experimental` one contributes nothing. */
  module: string
  stage: ModuleStage
  load: LazyModule<ModuleContextModule>
}

/** What a module's `tools.load` resolves to. */
export interface ModuleToolsModule {
  toolFamily: ModuleToolFamily
}

/** One module's tools as `lib/modules/generated/tools.ts` lists them. */
export interface ModuleToolsEntry {
  /** The contributing module, and its stage: an `experimental` one offers nothing. */
  module: string
  stage: ModuleStage
  declare: Readonly<Record<string, ModuleToolDeclaration>>
  load: LazyModule<ModuleToolsModule>
}

/** What a port provision's `load` resolves to: the implementation, as `port`. */
export interface ModulePortModule {
  port: unknown
}

/**
 * An implementation of a kernel capability port (`ocr`, `speech`, `forge`, …):
 * `port` is the id a contract in `types/modules/ports/<id>.ts` declares, and
 * `load` brings the file that exports the implementation as `port`. Users ask
 * `lib/modules/ports.ts` for it by id; one active module provides each port,
 * except a collection port (`PortCollectionMap`, such as `docs-provider`),
 * where every providing module adds one member.
 */
export interface ModulePortProvision {
  port: string
  load: LazyModule<ModulePortModule>
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
  /**
   * Ports this module's files ask `lib/modules/ports.ts` for; a trailing `?`
   * marks one it copes without (`"ocr?"`). Exactly the ports its files ask
   * for (G4); a required one must have an active provider (G5).
   */
  requires?: readonly string[]

  runtimes?: readonly ModuleRuntime[]
  /**
   * Flat `AppSettings` keys this module owns: its files read each, no other
   * module claims one, and only its settings view writes them (G4). They
   * belong to its settings section `section` (the module id when omitted),
   * which resets and reviews them.
   */
  settings?: {
    keys: readonly Exclude<keyof AppSettings, "id">[]
    section?: string
    load?: LazyModule
  }
  /** `CORE_TABLE_NAMES` tables this module owns; its files access each, and no other module claims one (G4). */
  tables?: readonly string[]
  /**
   * In-process tools: each one's consent and effect as data, and the family
   * that offers and runs them (ADR-0250 §14 amendment).
   */
  tools?: {
    declare: Readonly<Record<string, ModuleToolDeclaration>>
    load: LazyModule<ModuleToolsModule>
  }
  /** Grants applied to every run the module customises (ADR-0198 amendment). */
  capabilityContributions?: { load: LazyModule<ModuleCapabilityContributionsModule> }
  /** System-prompt sections the module adds to the runs it applies to (ADR-0250 §14 `context` amendment). */
  context?: { load: LazyModule<ModuleContextModule> }
  /** Scheduler executors declared together with their task sources. */
  taskExecutors?: ModuleContribution
  builtinSkills?: ModuleContribution
  /** Plugin host API namespaces this module owns (ADR-0250 §9). */
  pluginApi?: { namespaces: readonly string[]; load: LazyModule }
  /**
   * The workflow node executors this module registers (ADR-0250 §14
   * `workflowNodes`), loaded by the workflow engine before it looks one up.
   */
  workflowNodes?: { load: LazyModule<ModuleWorkflowNodesModule> }
  /** Global-search providers (ADR-0129), registered beside the built-ins. */
  searchProviders?: LazyModule<ModuleSearchProvidersModule>
  slashCommands?: readonly ModuleSlashCommand[]
  /** Navigation catalog destinations, placed among the built-ins by `after`. */
  nav?: readonly ModuleNavEntry[]
  /** Code-owned prompt definitions the Prompt Center lists (ADR-0236). */
  prompts?: LazyModule<ModulePromptsModule>
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
