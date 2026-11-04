import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"

import {
  isJsRuntimeProvider,
  type ExternalAgentDistribution,
  type ExternalAgentLifecycleErrorCode,
  type ExternalAgentRuntimeCatalog,
  type ExternalAgentRuntimeBinding,
  type ExternalAgentRuntimeCatalogEntry,
  type ExternalAgentRuntimeProvider,
} from "@cognia/agent-contracts/external-agent-lifecycle"

// ============================================================================
// Provider selection
// ============================================================================

export interface ProviderSelectionInput {
  /** Global preferred JavaScript provider, from settings. */
  preferred?: ExternalAgentRuntimeProvider
  /** Per-runtime override, which wins over the global preference. */
  override?: ExternalAgentRuntimeProvider
  /** Providers whose tool is actually present on this host. */
  available?: readonly ExternalAgentRuntimeProvider[]
}

export interface ProviderSelection {
  distribution?: ExternalAgentDistribution
  /**
   * Whether the chosen provider differs from what the caller asked for. A
   * provider switch is never silent — the caller must surface this.
   */
  switchedFromRequested: boolean
  /** The provider the caller asked for, when one was requested. */
  requested?: ExternalAgentRuntimeProvider
  /** Why no distribution could be selected. */
  blockingCode?: ExternalAgentLifecycleErrorCode
  /** Non-localized detail for logs; UI text is keyed on `blockingCode`. */
  detail?: string
}

// ============================================================================
// Launch resolution
// ============================================================================

export interface ResolvedLaunch {
  command: string
  args: string[]
}
export function createRuntimeCatalog(
  catalog: ExternalAgentRuntimeCatalog,
  identity: {
    presetId(config: Pick<ExternalAgentConfig, "metadata">): string | undefined
    baseCommandName(command: string): string
  }
) {
  const externalAgentPresetIdOf = identity.presetId
  const baseCommandName = identity.baseCommandName

  const EXTERNAL_AGENT_RUNTIME_CATALOG_VERSION = catalog.version

  /** Every runtime the catalog governs. */
  const EXTERNAL_AGENT_RUNTIMES: readonly ExternalAgentRuntimeCatalogEntry[] = catalog.runtimes

  /** Runtimes still launching through a resolving package runner, with reasons. */
  const UNPINNED_LAUNCH_WAIVERS: Readonly<Record<string, string>> =
    catalog.unpinnedLaunchWaivers.runtimes

  function findRuntimeById(runtimeId: string): ExternalAgentRuntimeCatalogEntry | undefined {
    return EXTERNAL_AGENT_RUNTIMES.find((entry) => entry.runtimeId === runtimeId)
  }

  function findRuntimeByPresetId(presetId: string): ExternalAgentRuntimeCatalogEntry | undefined {
    return EXTERNAL_AGENT_RUNTIMES.find((entry) => entry.presetIds.includes(presetId))
  }

  /** Every preset id the catalog claims to cover. */
  function catalogedPresetIds(): string[] {
    return EXTERNAL_AGENT_RUNTIMES.flatMap((entry) => entry.presetIds)
  }

  // ============================================================================
  // Binding a saved configuration to a runtime
  // ============================================================================

  /**
   * Which catalogued runtime a saved configuration actually launches.
   *
   * Two routes, in order. A config created from a preset carries the preset id on
   * `metadata.preset`, which is the exact answer. A hand-configured one does not,
   * so it is matched on what it would run: protocol plus the base launch command,
   * disambiguated by the package name when several runtimes share a package
   * runner (four of them launch through `npx`).
   *
   * Returns `undefined` rather than guessing when the match is ambiguous. An
   * incorrect binding is worse than none: it would attribute an agent's live
   * sessions to the wrong runtime and let an uninstall proceed while something
   * was still using it.
   */
  function findRuntimeForConfig(
    config: Pick<ExternalAgentConfig, "metadata" | "protocol" | "process">
  ): ExternalAgentRuntimeCatalogEntry | undefined {
    const presetId = externalAgentPresetIdOf(config)
    if (presetId) {
      const byPreset = findRuntimeByPresetId(presetId)
      if (byPreset) return byPreset
    }

    const command = config.process?.command
    if (!command) return undefined

    const base = baseCommandName(command.split(/[\\/]/).at(-1) ?? command)
    const legacy = EXTERNAL_AGENT_RUNTIMES.filter(
      (entry) =>
        entry.protocol === config.protocol &&
        entry.legacyLaunches?.some(
          (launch) =>
            baseCommandName(launch.command) === base &&
            JSON.stringify(launch.args) === JSON.stringify(config.process?.args ?? [])
        )
    )
    if (legacy.length === 1) return legacy[0]
    const candidates = EXTERNAL_AGENT_RUNTIMES.filter(
      (entry) =>
        entry.systemCommand &&
        baseCommandName(entry.systemCommand) === base &&
        entry.protocol === config.protocol
    )
    if (candidates.length === 1) return candidates[0]
    if (candidates.length === 0) return undefined

    // Several runtimes share this command — for `npx` that is the norm. The
    // package being run is what tells them apart.
    const target = (config.process?.args ?? []).find((arg) => !arg.startsWith("-"))
    if (!target) return undefined
    const matched = candidates.filter((entry) => (entry.launchArgs ?? []).includes(target))
    return matched.length === 1 ? matched[0] : undefined
  }

  /**
   * The runtime binding to persist for a configuration.
   *
   * Without this the binding-dependent machinery is inert: live sessions are
   * attributed to no runtime, so an uninstall's "still in use" and "still
   * referenced" guards can never fire, and the Windows consent path never
   * engages because there is no runtime to check eligibility against.
   */
  function deriveRuntimeBinding(
    config: Pick<ExternalAgentConfig, "metadata" | "protocol" | "process">
  ): ExternalAgentRuntimeBinding | undefined {
    const entry = findRuntimeForConfig(config)
    if (!entry) return undefined
    return { runtimeId: entry.runtimeId, ownership: entry.ownership }
  }

  // ============================================================================
  // Platform support
  // ============================================================================

  /** Tauri spells platforms differently from Node; accept both, as the policy does. */
  const PLATFORM_ALIASES: Record<string, string> = {
    macos: "darwin",
    windows: "win32",
    win: "win32",
  }

  function normalizePlatform(platform: string): string {
    return PLATFORM_ALIASES[platform] ?? platform
  }

  function runtimeSupportsPlatform(
    entry: ExternalAgentRuntimeCatalogEntry,
    platform: string
  ): boolean {
    return entry.platforms.includes(normalizePlatform(platform))
  }

  /**
   * Can this distribution be installed without resolving anything at install time?
   *
   * JavaScript and uvx distributions need an approved frozen lock; binary
   * distributions need an https source and a checksum on every artifact.
   */
  function isDistributionInstallable(distribution: ExternalAgentDistribution): boolean {
    if (distribution.provider === "binary") {
      return (
        distribution.artifacts.length > 0 &&
        distribution.artifacts.every(
          (artifact) =>
            artifact.url.startsWith("https://") && /^[0-9a-f]{64}$/.test(artifact.integrity.sha256)
        )
      )
    }
    const lock = distribution.lockAsset
    return Boolean(lock?.path) && /^[0-9a-f]{64}$/.test(lock?.sha256 ?? "")
  }

  /**
   * Pick the managed distribution to install.
   *
   * Only distributions that are actually installable are considered: a JS or uvx
   * distribution without an approved frozen lock is not offered at all, because
   * offering it would mean resolving a range at install time — the exact problem
   * the lock exists to prevent.
   */
  function selectDistribution(
    entry: ExternalAgentRuntimeCatalogEntry,
    input: ProviderSelectionInput = {}
  ): ProviderSelection {
    const requested = input.override ?? input.preferred
    const installable = entry.distributions.filter(isDistributionInstallable)

    if (installable.length === 0) {
      return {
        switchedFromRequested: false,
        requested,
        blockingCode: "runtime_missing",
        detail:
          entry.distributions.length === 0
            ? `no managed distribution is catalogued for ${entry.runtimeId}`
            : `every catalogued distribution for ${entry.runtimeId} lacks an approved lock or integrity record`,
      }
    }

    const available = input.available
    const usable = available
      ? installable.filter((distribution) => available.includes(distribution.provider))
      : installable

    if (usable.length === 0) {
      return {
        switchedFromRequested: false,
        requested,
        blockingCode: "runtime_missing",
        detail: `no provider tool for ${entry.runtimeId} is available on this host`,
      }
    }

    const exact = requested
      ? usable.find((distribution) => distribution.provider === requested)
      : undefined
    if (exact) {
      return { distribution: exact, switchedFromRequested: false, requested }
    }

    // Catalog order is the preference order, so falling back is deterministic.
    return {
      distribution: usable[0],
      switchedFromRequested: requested !== undefined,
      requested,
    }
  }

  /**
   * The command a `system` runtime launches, straight from the catalog.
   *
   * Managed runtimes launch their receipt's entrypoint instead, which only the
   * host that installed them can resolve; remote runtimes launch nothing.
   */
  function resolveSystemLaunch(
    entry: ExternalAgentRuntimeCatalogEntry
  ): ResolvedLaunch | undefined {
    if (!entry.systemCommand) return undefined
    return { command: entry.systemCommand, args: [...(entry.launchArgs ?? [])] }
  }

  /**
   * Does this runtime still launch through a network-resolving package runner?
   *
   * `npx -y <pkg>` re-resolves the package on every start, so the bytes that run
   * can change under the user without any consent. That is a governance hole, and
   * it has to be nameable to be counted.
   */
  function isUnpinnedLaunch(entry: ExternalAgentRuntimeCatalogEntry): boolean {
    const command = entry.systemCommand
    if (!command) return false
    const base = command.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "")
    return base === "npx" || base === "uvx" || base === "pnpx" || base === "bunx"
  }

  /** Is this runtime's unpinned launch recorded as a known, reasoned hole? */
  function hasUnpinnedLaunchWaiver(runtimeId: string): boolean {
    return Object.prototype.hasOwnProperty.call(UNPINNED_LAUNCH_WAIVERS, runtimeId)
  }

  /**
   * Canonical text of what would actually launch, for the consent digest.
   *
   * JSON-encoded rather than space-joined so two different argument lists can
   * never canonicalize to the same string: `["a b"]` and `["a", "b"]` launch
   * different things and must not share a consent record.
   */
  function canonicalLaunchCommandString(launch: ResolvedLaunch): string {
    return JSON.stringify([launch.command, ...launch.args])
  }

  // ============================================================================
  // Sandbox and consent eligibility
  // ============================================================================

  /**
   * May this runtime be offered a Windows unsandboxed-launch consent?
   *
   * Three conditions, all required: the host is Windows, the catalog marks the
   * runtime eligible, and the runtime supports Windows at all. macOS and Linux
   * never reach this — their sandbox is mandatory and this returns false there,
   * so a caller cannot accidentally route a Unix launch through the consent path.
   */
  function isWindowsExceptionEligible(
    entry: ExternalAgentRuntimeCatalogEntry,
    platform: string
  ): boolean {
    return (
      normalizePlatform(platform) === "win32" &&
      entry.sandbox.windowsExceptionEligible &&
      runtimeSupportsPlatform(entry, platform)
    )
  }

  /** Providers whose distributions this runtime actually offers. */
  function offeredProviders(
    entry: ExternalAgentRuntimeCatalogEntry
  ): ExternalAgentRuntimeProvider[] {
    const seen: ExternalAgentRuntimeProvider[] = []
    for (const distribution of entry.distributions) {
      if (!isDistributionInstallable(distribution)) continue
      if (!seen.includes(distribution.provider)) seen.push(distribution.provider)
    }
    return seen
  }

  /** Does this runtime offer a choice between JavaScript providers? */
  function hasJsProviderChoice(entry: ExternalAgentRuntimeCatalogEntry): boolean {
    return offeredProviders(entry).filter(isJsRuntimeProvider).length > 1
  }
  return {
    EXTERNAL_AGENT_RUNTIME_CATALOG_VERSION,
    EXTERNAL_AGENT_RUNTIMES,
    UNPINNED_LAUNCH_WAIVERS,
    findRuntimeById,
    findRuntimeByPresetId,
    catalogedPresetIds,
    findRuntimeForConfig,
    deriveRuntimeBinding,
    normalizePlatform,
    runtimeSupportsPlatform,
    isDistributionInstallable,
    selectDistribution,
    resolveSystemLaunch,
    isUnpinnedLaunch,
    hasUnpinnedLaunchWaiver,
    canonicalLaunchCommandString,
    isWindowsExceptionEligible,
    offeredProviders,
    hasJsProviderChoice,
  }
}
export type RuntimeCatalog = ReturnType<typeof createRuntimeCatalog>
