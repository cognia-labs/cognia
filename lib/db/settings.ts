import { isValidSubscriptionProviderId } from "@/types/subscription/credential"
import type {
  AppSettings,
  BuiltinToolsConfig,
  SubscriptionAccountProvider,
} from "@cognia/agent-config-types"
import {
  DEFAULT_BIOMETRIC_GUARD,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_LIVE_VOICE_SETTINGS,
  DEFAULT_UPDATE_SETTINGS,
  DEFAULT_USER_PROFILE,
  DEFAULT_VIDEO_GENERATION_SETTINGS,
} from "@cognia/agent-config-types"
import { DEFAULT_TTS_SETTINGS, normalizeTTSProvider } from "@cognia/tts/types"
import {
  DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  SEARCH_PROVIDERS,
  createDefaultSearchUsageStats,
  normalizeSearchProviderHealthSettings,
  type SearchProviderSettings,
  type SearchProviderType,
} from "@cognia/web-search/types"
import { normalizeCustomSearchSource, SEARCH_SOURCES } from "@cognia/web-search/search-constants"
import { DEFAULT_APPEARANCE_SLICE, DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import { DEFAULT_RUN_STATUS_BAR } from "@/lib/chat/run-bar-defaults"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"
import { DEFAULT_SIDEBAR_LAYOUT, DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
import { DEFAULT_EVAL_SETTINGS } from "@/types/eval/settings"
import { DEFAULT_AUTO_ROUTING, type AutoRoutingSettings } from "@cognia/provider-types/auto-router"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES } from "@cognia/provider-types"
import type { DifficultyRoutingSettings } from "@/types/routing/tool-route"
import { getDb, withDbReopenRetry } from "./schema"
import {
  isEmptySecretSet,
  joinSettingsSecrets,
  overlaySecretSets,
  secretSetsEqual,
  splitSettingsSecrets,
  type SettingsSecretSet,
} from "@/lib/settings/provider-secret-split"
import {
  PROVIDER_SECRETS_REF_FIELD,
  ProviderSecretStoreUnavailableError,
  deleteProviderSecrets,
  releaseAdoptedProviderSecrets,
  resolveProviderSecrets,
  writeProviderSecrets,
  type ProviderSecretResolution,
  type ProviderSecretsRef,
} from "@/lib/settings/provider-secret-store"
import { resolveLocalePreference } from "@/lib/i18n/locale-preference"
import {
  freshInstallWebReader,
  legacyCompatibilityWebReader,
  normalizeWebReaderSettings,
} from "@/lib/web/reader/reader-settings"

const SINGLETON_ID = "singleton" as const

/**
 * Canonical default settings. Exported so settings-profile reset/export can
 * diff against and restore them without re-deriving the shape.
 */
export const DEFAULTS: AppSettings = {
  id: SINGLETON_ID,
  settingsIconStyle: "anime",
  defaultModel: undefined,
  defaultSystemPrompt: undefined,
  defaultWorkingDir: undefined,
  activeProjectId: undefined,
  permissionMode: "default",
  alwaysAllowTools: [],
  // Canvas-executed code is confined by default (ADR-0028); independently
  // overridable from Settings → Sandbox (does not affect chat-tool sandboxing).
  canvasCodeSandboxEnabled: true,
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  routingFallbackEnabled: true,
  autoRouting: { ...DEFAULT_AUTO_ROUTING },
  // Cache-friendly prompt assembly is on by default: volatile per-turn sections
  // (twin RAG, style few-shot, memory recall) are routed to the appended tail so
  // the stable system prefix stays byte-identical across turns and provider
  // prompt caches (Anthropic cache_control, DeepSeek/OpenAI auto-cache) keep
  // hitting. Explicit `false` opts out (mirrors routingFallbackEnabled).
  cacheOptimizationEnabled: true,
  apiKey: undefined,
  apiBaseUrl: undefined,
  activeProviderId: undefined,
  ccswitchSync: {
    enabled: true,
    watchDb: true,
    defaultPropagation: [],
  },
  customLimitsSources: [],
  providerDiagnostics: { ...DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES },
  limitsQueryEnabledAccounts: [],
  lastUpdateCheckAt: undefined,
  updates: { ...DEFAULT_UPDATE_SETTINGS },
  // Multi-provider live voice — off until the user configures a deployment.
  liveVoice: { ...DEFAULT_LIVE_VOICE_SETTINGS },
  // Chat video generation (ADR-0205). The agent tool is offered only once a
  // video provider is configured, so "on" here costs nothing until then.
  videoGeneration: { ...DEFAULT_VIDEO_GENERATION_SETTINGS },
  browserCookieImportEnabled: false,
  // ADR-0062 live sync is opt-in: the watcher walks the user's agent history
  // trees, so it never starts without an explicit switch.
  sessionImportWatch: { enabled: false },
  remoteBrowserEnabled: false,
  browserDefaultBackend: "auto",
  cliBridge: { autoSync: false },
  webTools: { enabled: true },
  // An explicit reset uses fresh-install consent, never the upgrade profile.
  webReader: freshInstallWebReader(),
  // Legacy dismissal stamp — read once by `lib/onboarding/migrate-legacy.ts`,
  // never written. Fresh installs have no progress at all, which is what makes
  // `OnboardingGate` route them into the flow.
  onboardingDismissedAt: undefined,
  onboardingProgress: undefined,
  onboardingProfile: undefined,
  theme: "system",
  fontScale: "md",
  language: "en",
  languageMode: "system",
  reduceMotion: false,
  workflowEditorPerformanceTier: undefined,
  evalSettings: { ...DEFAULT_EVAL_SETTINGS },
  telemetryEnabled: false,
  behaviorTelemetry: {
    enabled: false,
    destinations: { local: true, remote: false },
    categories: {
      chat: true,
      workflow: true,
      connector: true,
      agentTeam: true,
      app: true,
      system: true,
    },
    sampleRate: 1,
    retentionDays: 30,
    maxStoredEvents: 10_000,
  },
  storageRetention: { traceRetentionDays: 30 },
  // Unset on purpose: dictation follows the app language until the user picks
  // one (`resolveSttLanguage` in @cognia/tts/speech). A fixed "en-US" here was
  // merged into every saved row and transcribed a zh-CN user's speech as English.
  sttLanguage: undefined,
  selectedMicId: undefined,
  pinnedWorkflowIds: [],
  pinnedMeRowIds: [],
  sidebarLayout: DEFAULT_SIDEBAR_LAYOUT,
  // A scalar, so `{ ...DEFAULTS, ...row }` in `getSettings` already seeds it
  // for rows saved before the rail could move — no entry needed alongside the
  // nested-object merges below.
  sidebarSide: DEFAULT_SIDEBAR_SIDE,
  lastInboxViewedAt: 0,
  // TTS defaults (mirror types/media/tts.ts → DEFAULT_TTS_SETTINGS).
  ttsProvider: DEFAULT_TTS_SETTINGS.ttsProvider,
  systemVoice: DEFAULT_TTS_SETTINGS.systemVoice,
  openaiVoice: DEFAULT_TTS_SETTINGS.openaiVoice,
  openaiModel: DEFAULT_TTS_SETTINGS.openaiModel,
  openaiSpeed: DEFAULT_TTS_SETTINGS.openaiSpeed,
  openaiInstructions: DEFAULT_TTS_SETTINGS.openaiInstructions,
  openaiResponseFormat: DEFAULT_TTS_SETTINGS.openaiResponseFormat,
  localOpenaiBaseUrl: DEFAULT_TTS_SETTINGS.localOpenaiBaseUrl,
  localOpenaiModel: DEFAULT_TTS_SETTINGS.localOpenaiModel,
  localOpenaiVoice: DEFAULT_TTS_SETTINGS.localOpenaiVoice,
  localOpenaiSpeed: DEFAULT_TTS_SETTINGS.localOpenaiSpeed,
  localOpenaiResponseFormat: DEFAULT_TTS_SETTINGS.localOpenaiResponseFormat,
  localOpenaiTimeoutMs: DEFAULT_TTS_SETTINGS.localOpenaiTimeoutMs,
  geminiVoice: DEFAULT_TTS_SETTINGS.geminiVoice,
  geminiModel: DEFAULT_TTS_SETTINGS.geminiModel,
  edgeVoice: DEFAULT_TTS_SETTINGS.edgeVoice,
  edgeRate: DEFAULT_TTS_SETTINGS.edgeRate,
  edgePitch: DEFAULT_TTS_SETTINGS.edgePitch,
  elevenlabsVoice: DEFAULT_TTS_SETTINGS.elevenlabsVoice,
  elevenlabsModel: DEFAULT_TTS_SETTINGS.elevenlabsModel,
  elevenlabsStability: DEFAULT_TTS_SETTINGS.elevenlabsStability,
  elevenlabsSimilarityBoost: DEFAULT_TTS_SETTINGS.elevenlabsSimilarityBoost,
  lmntVoice: DEFAULT_TTS_SETTINGS.lmntVoice,
  lmntSpeed: DEFAULT_TTS_SETTINGS.lmntSpeed,
  humeVoice: DEFAULT_TTS_SETTINGS.humeVoice,
  cartesiaVoice: DEFAULT_TTS_SETTINGS.cartesiaVoice,
  cartesiaModel: DEFAULT_TTS_SETTINGS.cartesiaModel,
  cartesiaLanguage: DEFAULT_TTS_SETTINGS.cartesiaLanguage,
  cartesiaSpeed: DEFAULT_TTS_SETTINGS.cartesiaSpeed,
  cartesiaEmotion: DEFAULT_TTS_SETTINGS.cartesiaEmotion,
  deepgramVoice: DEFAULT_TTS_SETTINGS.deepgramVoice,
  xiaomiVoice: DEFAULT_TTS_SETTINGS.xiaomiVoice,
  xiaomiModel: DEFAULT_TTS_SETTINGS.xiaomiModel,
  xiaomiStyle: DEFAULT_TTS_SETTINGS.xiaomiStyle,
  xiaomiDialect: DEFAULT_TTS_SETTINGS.xiaomiDialect,
  mistralVoiceId: DEFAULT_TTS_SETTINGS.mistralVoiceId,
  mistralModel: DEFAULT_TTS_SETTINGS.mistralModel,
  mistralResponseFormat: DEFAULT_TTS_SETTINGS.mistralResponseFormat,
  realtimeVoice: DEFAULT_TTS_SETTINGS.realtimeVoice,
  realtimeModel: DEFAULT_TTS_SETTINGS.realtimeModel,
  realtimeInstructions: DEFAULT_TTS_SETTINGS.realtimeInstructions,
  ttsEnabled: DEFAULT_TTS_SETTINGS.ttsEnabled,
  ttsRate: DEFAULT_TTS_SETTINGS.ttsRate,
  ttsPitch: DEFAULT_TTS_SETTINGS.ttsPitch,
  ttsVolume: DEFAULT_TTS_SETTINGS.ttsVolume,
  ttsAutoPlay: DEFAULT_TTS_SETTINGS.ttsAutoPlay,
  ttsCacheEnabled: DEFAULT_TTS_SETTINGS.ttsCacheEnabled,
  ttsStreamingEnabled: DEFAULT_TTS_SETTINGS.ttsStreamingEnabled,
  ttsFallbackEnabled: DEFAULT_TTS_SETTINGS.ttsFallbackEnabled,

  // Web search defaults — providers are all installed-but-disabled until the
  // user enters an API key.
  searchEnabled: false,
  searchMaxResults: 5,
  searchFallbackEnabled: true,
  searchMaxRetries: 2,
  defaultSearchProvider: "tavily",
  searchProviders: { ...DEFAULT_SEARCH_PROVIDER_SETTINGS },
  defaultSearchType: "general",
  defaultSearchDepth: "basic",
  defaultSearchRecency: "any",
  defaultSearchCountry: "",
  defaultSearchLanguage: "en",
  defaultIncludeDomains: [],
  defaultExcludeDomains: [],
  defaultIncludeAnswer: true,
  defaultIncludeRawContent: false,
  searchCacheEnabled: true,
  searchCacheTTL: 10 * 60 * 1000,
  searchCacheMaxEntries: 500,
  searchProviderHealth: { ...DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS },
  searchSafeSearchEnabled: true,
  searchSafeSearchLevel: "moderate",
  sourceVerificationSettings: { ...DEFAULT_SOURCE_VERIFICATION_SETTINGS },
  searchUsageStats: createDefaultSearchUsageStats(),
  customSearchSources: [],
  defaultSearchSources: [],

  // Appearance defaults come from `DEFAULT_APPEARANCE_SLICE`, spread below.
  // `background` / `wallpapers` / `customCss` / `customCssEnabled` /
  // `importedVscodeThemes` were also listed here, ahead of that spread, so the
  // slice overwrote all five — identical values, but two places to keep in step
  // and only one of them load-bearing.

  // Network proxy defaults — disabled until the user configures one.
  networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS },

  // Biometric guard policy — Wave 1.5. Sign-out is on by default
  // (matches the existing pair-onboarding behavior); export and reveal
  // are off until the user opts in via Settings → 应用安全.
  biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },

  // Idle auto-lock is opt-in (Never). It only ever applies to a profile that
  // asks for its password at launch, and an unasked-for lock in the middle of
  // work is the friction ADR-0054's device unlock exists to remove. Rows that
  // already persisted a value keep it: `save()` writes the whole merged row,
  // so a stored 30 cannot be told apart from a deliberate choice. Active local
  // turns pause the timer when it is on.
  accountAutoLockMinutes: 0,

  // OCR subsystem preferences. Driven by the settings page at
  // `components/settings/ocr/*`. Mirrors `lib/ocr/types.ts:DEFAULT_OCR_SETTINGS`.
  ocrSettings: { ...DEFAULT_OCR_SETTINGS },

  // Source Control preferences (AI commit message generation, …).
  gitSettings: { ...DEFAULT_GIT_SETTINGS },

  // Local user profile — empty by default; identity falls back to the
  // credential-derived name/avatar (see `lib/profile/use-user-profile.ts`).
  profile: { ...DEFAULT_USER_PROFILE },

  // Conversation title auto-generation — on by default (the instant
  // first-message truncation always runs; this gates the LLM upgrade).
  conversationTitle: { enabled: true },
  // Right-edge timeline minimap — feature on, collapsed by default, label
  // summaries off (they cost one model call per turn).
  conversationTimeline: { enabled: true, expanded: false, labelSummary: { enabled: false } },
  // Conversation sidebar (ChannelList) — comfortable density, no preview line,
  // workspace grouping (the axis conversations are already stamped with), date
  // headings inside the expanded sidebar's team groups, unread badges on,
  // title-only search (content search is opt-in).
  // Every field the sidebar reads is named here, including the five that used
  // to rely on a `??` fallback in the component. `changed-settings` and
  // `profile-transfer` diff against DEFAULTS, so an omitted key read as
  // "changed by the user" the moment the sidebar merged its own fallback in.
  conversationSidebar: {
    density: "comfortable",
    showPreview: false,
    showCustomIcons: true,
    showTimestamps: true,
    groupBy: "workspace",
    teamDateHeadings: true,
    sortBy: "recent",
    showUnreadBadges: true,
    searchScope: "title",
    metadata: ["agent", "model"],
    titleMotion: "hover",
    filterPresets: [],
  },
  // Auto-archive is off until the user picks a period (ADR-0213). Named here
  // so `changed-settings` and the section reset see the key, not an absence.
  conversationArchive: { autoArchiveAfterDays: null },
  // Token-level streaming for interactive chat — on by default.
  streamPartialMessages: true,
  // Appearance slice (ADR-0029 / ADR-0114 / ADR-0127). `DEFAULT_APPEARANCE_SLICE`
  // is the single default source for the appearance-owned keys; spreading it
  // here is what makes them canonical `DEFAULTS` keys, so per-section reset,
  // the changed-settings review, and profile transfer all see them.
  //
  // `agentFlowMode` is deliberately NOT defaulted: it is the legacy read-only
  // fallback for `messageDisplay` (`resolveMessageDisplayOptions`), and a
  // non-undefined default would override every preset's own agent-flow value.
  ...omitAgentFlowMode(DEFAULT_APPEARANCE_SLICE),
  // Run status bar metrics + composer behavior/assistance (Conversation section)
  // — defaulted here so they are claimable by `SECTION_OWNED_KEYS`.
  runStatusBar: { ...DEFAULT_RUN_STATUS_BAR },
  composerBehavior: {},
  composerAssistance: {},
  decisions: {},
}

function omitAgentFlowMode(
  slice: typeof DEFAULT_APPEARANCE_SLICE
): Omit<typeof DEFAULT_APPEARANCE_SLICE, "agentFlowMode"> {
  const { agentFlowMode: _legacy, ...rest } = slice
  return rest
}

type SettingsScope = { db: ReturnType<typeof getDb>; assertActive(): void }

/** The persisted row: `AppSettings` without credentials, plus the blob pointer. */
type PersistedSettingsRow = AppSettings & { [PROVIDER_SECRETS_REF_FIELD]?: ProviderSecretsRef }

/** How the credentials of the row just read were found (ADR-0256). */
interface ProviderSecretState {
  dbName: string
  ref: ProviderSecretsRef | undefined
  /** Credentials still in plaintext in the persisted row. */
  legacy: SettingsSecretSet
  resolution: ProviderSecretResolution
}

function hasPendingProviderSecretWork(state: ProviderSecretState): boolean {
  return (
    state.resolution.status === "ok" &&
    (!isEmptySecretSet(state.legacy) || state.resolution.adoptFrom !== undefined)
  )
}

/**
 * Join the credentials kept in the secret store back into the persisted row.
 * Plaintext still in the row (written by an older build or a raw writer) wins
 * for the fields it carries and is queued for migration.
 */
async function hydrateProviderSecrets(
  dbName: string,
  persisted: PersistedSettingsRow,
  scope: SettingsScope | undefined
): Promise<{ row: AppSettings; state: ProviderSecretState }> {
  const { [PROVIDER_SECRETS_REF_FIELD]: ref, ...withoutRef } = persisted
  const { publicRow, secrets: legacy } = splitSettingsSecrets(withoutRef as AppSettings)
  const resolution = await resolveProviderSecrets(dbName, ref)
  const stored = resolution.status === "ok" ? resolution.blob?.secrets : undefined
  const row = joinSettingsSecrets(publicRow, overlaySecretSets(stored, legacy))
  const state: ProviderSecretState = { dbName, ref, legacy, resolution }
  if (hasPendingProviderSecretWork(state)) scheduleProviderSecretMigration(dbName, scope)
  return { row, state }
}

/** Databases with a migration queued in this process. */
const scheduledSecretMigrations = new Set<string>()

function scheduleProviderSecretMigration(dbName: string, scope: SettingsScope | undefined): void {
  if (scheduledSecretMigrations.has(dbName)) return
  scheduledSecretMigrations.add(dbName)
  void migrateProviderSecretsOutOfSettingsRow(scope)
    .catch(() => {
      // Retried by the next read that still finds plaintext in the row.
    })
    .finally(() => scheduledSecretMigrations.delete(dbName))
}

/**
 * Move plaintext provider credentials out of the persisted settings row, and
 * adopt a blob a database migration copied the row away from. A no-op (no
 * write, no `updatedAt` bump) when there is nothing to move. Resolves `true`
 * when it wrote.
 */
export async function migrateProviderSecretsOutOfSettingsRow(
  scope?: SettingsScope
): Promise<boolean> {
  let wrote = false
  await saveSettings(() => ({}), {
    mirrorToHost: false,
    scope,
    onlyForPendingProviderSecrets: () => {
      wrote = true
    },
  })
  return wrote
}

/**
 * Restore (ADR-0256 §6): merge a backup's provider credentials into this
 * database's secret blob, the backup winning per credential, and return the
 * pointer the restored row must carry. Runs on the settings save queue so it
 * cannot interleave with a save's read-modify-write of the same blob. Throws
 * {@link ProviderSecretStoreUnavailableError} when the store refuses it.
 */
export async function mergeRestoredProviderSecrets(
  incoming: SettingsSecretSet,
  scope?: SettingsScope
): Promise<ProviderSecretsRef> {
  const next = saveQueue.then(async () => {
    const db = scope?.db ?? getDb()
    const persisted = (await db.settings.get(SINGLETON_ID)) as PersistedSettingsRow | undefined
    scope?.assertActive()
    const resolution = await resolveProviderSecrets(
      db.name,
      persisted?.[PROVIDER_SECRETS_REF_FIELD]
    )
    if (resolution.status === "unavailable") {
      throw new ProviderSecretStoreUnavailableError(resolution.error)
    }
    const legacy = persisted ? splitSettingsSecrets(persisted).secrets : undefined
    const current = overlaySecretSets(resolution.blob?.secrets, legacy)
    return writeProviderSecrets(db.name, overlaySecretSets(current, incoming))
  })
  saveQueue = next.catch(() => undefined)
  return next
}

export async function getSettings(scope?: SettingsScope): Promise<AppSettings> {
  return (await readSettingsWithSecrets(scope)).settings
}

async function readSettingsWithSecrets(
  scope?: SettingsScope
): Promise<{ settings: AppSettings; secrets: ProviderSecretState | null }> {
  scope?.assertActive()
  // Retried across a connection close: this read is what every window makes at
  // boot, right when the plugin table bridge closes and reopens the shared
  // connection to register plugin stores. Losing it used to strand the whole
  // window on DEFAULTS for the rest of the session (see `withDbReopenRetry`).
  const db = scope?.db ?? getDb()
  const persisted = (await withDbReopenRetry(() => {
    scope?.assertActive()
    return (scope?.db ?? getDb()).settings.get(SINGLETON_ID)
  })) as PersistedSettingsRow | undefined
  scope?.assertActive()
  // Forward-compat: merge defaults under the persisted row so older installs
  // pick up new fields (e.g., searchProviders) without a schema migration.
  if (!persisted) {
    return {
      settings: { ...DEFAULTS, webReader: freshInstallWebReader(), ...resolveLocalePreference() },
      secrets: null,
    }
  }
  const hydrated = await hydrateProviderSecrets(db.name, persisted, scope)
  scope?.assertActive()
  const row = hydrated.row
  return { settings: normalizeSettingsRow(row), secrets: hydrated.state }
}

function normalizeSettingsRow(row: AppSettings): AppSettings {
  const reader = normalizeWebReaderSettings(row.webReader, {
    rowExists: true,
    webTools: row.webTools,
  })
  const webReader = !Object.prototype.hasOwnProperty.call(row, "webReader")
    ? legacyCompatibilityWebReader(row.webTools)
    : reader.source === "unsupported-version"
      ? (reader.preserved ?? reader.effective)
      : reader.effective
  const autoRouting = mergeAutoRouting(row.autoRouting, row.difficultyRouting)
  const routingConfig = {
    ...DEFAULT_ROUTING_CONFIG,
    ...(row.routingConfig ?? {}),
    strategy: row.routingConfig?.strategy ?? autoRouting.strategy,
  }
  const customSearchSources = (row.customSearchSources ?? []).map(
    (source) => normalizeCustomSearchSource(source) ?? source
  )
  // A research source is either a real search provider (the "Preferred
  // providers" pills, which are `SEARCH_PROVIDERS` keys — NOT the small
  // provider subset in `SEARCH_SOURCES`), a built-in domain source, or a
  // custom domain source. Omitting the provider ids here silently discarded
  // every provider preference on the next read.
  const validSearchSourceIds = new Set<string>([
    ...Object.keys(SEARCH_PROVIDERS),
    ...SEARCH_SOURCES.map((source) => source.id),
    ...customSearchSources.map((source) => source.id),
  ])
  return {
    ...DEFAULTS,
    ...row,
    webReader,
    searchProviders: mergeSearchProviders(row.searchProviders),
    ...resolveLocalePreference(row),
    customSearchSources: customSearchSources as AppSettings["customSearchSources"],
    defaultSearchSources: (row.defaultSearchSources ?? []).filter((id) =>
      validSearchSourceIds.has(id)
    ),
    ttsProvider: normalizeTTSProvider(row.ttsProvider),
    // Nested objects need their own forward-compat merge — a v1 row that
    // shipped without `builtinTools.shellAdvanced` would otherwise drop the
    // default when we eventually add it.
    builtinTools: mergeBuiltinTools(row.builtinTools),
    background: { ...DEFAULT_BACKGROUND_SETTINGS, ...(row.background ?? {}) },
    wallpapers: row.wallpapers ?? [],
    customCss: row.customCss ?? "",
    customCssEnabled: row.customCssEnabled ?? false,
    importedVscodeThemes: row.importedVscodeThemes ?? [],
    networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, ...(row.networkProxy ?? {}) },
    // Normalize so rows written before the breaker settings existed (or with
    // out-of-range values) read back as a complete, clamped config.
    searchProviderHealth: normalizeSearchProviderHealthSettings(row.searchProviderHealth),
    webTools: { ...(row.webTools ?? {}), enabled: row.webTools?.enabled ?? true },
    cliBridge: { autoSync: row.cliBridge?.autoSync ?? false },
    updates: { ...DEFAULT_UPDATE_SETTINGS, ...(row.updates ?? {}) },
    liveVoice: {
      ...DEFAULT_LIVE_VOICE_SETTINGS,
      ...(row.liveVoice ?? {}),
      // Deployments are a replace-not-merge list: spreading defaults under a
      // user's array would resurrect entries they deleted.
      deployments: (row.liveVoice?.deployments ?? DEFAULT_LIVE_VOICE_SETTINGS.deployments).map(
        (deployment) => {
          // Legacy `resourceId` / `appKey` were never used by a production
          // transport. Drop them at the persistence boundary so ambiguous
          // values cannot reach the native policy command.
          const {
            resourceId: _resourceId,
            appKey: _appKey,
            ...active
          } = deployment as typeof deployment & {
            resourceId?: unknown
            appKey?: unknown
          }
          return active
        }
      ),
    },
    videoGeneration: { ...DEFAULT_VIDEO_GENERATION_SETTINGS, ...(row.videoGeneration ?? {}) },
    biometricRequiredFor: {
      ...DEFAULT_BIOMETRIC_GUARD,
      ...(row.biometricRequiredFor ?? {}),
    },
    behaviorTelemetry: {
      ...DEFAULTS.behaviorTelemetry!,
      ...(row.behaviorTelemetry ?? {}),
      enabled:
        row.behaviorTelemetry?.enabled ??
        row.telemetryEnabled ??
        DEFAULTS.behaviorTelemetry!.enabled,
      destinations: {
        ...DEFAULTS.behaviorTelemetry!.destinations,
        ...(row.behaviorTelemetry?.destinations ?? {}),
      },
      categories: {
        ...DEFAULTS.behaviorTelemetry!.categories,
        ...(row.behaviorTelemetry?.categories ?? {}),
      },
    },
    ocrSettings: mergeOcrSettings(row.ocrSettings),
    storageRetention: {
      traceRetentionDays:
        row.storageRetention?.traceRetentionDays ??
        DEFAULTS.storageRetention?.traceRetentionDays ??
        30,
    },
    gitSettings: {
      ...DEFAULT_GIT_SETTINGS,
      ...(row.gitSettings ?? {}),
      commitMessageAI: {
        ...DEFAULT_GIT_SETTINGS.commitMessageAI,
        ...(row.gitSettings?.commitMessageAI ?? {}),
      },
      reviewAI: {
        enabled: false,
        ...DEFAULT_GIT_SETTINGS.reviewAI,
        ...(row.gitSettings?.reviewAI ?? {}),
      },
      explainAI: {
        enabled: false,
        ...DEFAULT_GIT_SETTINGS.explainAI,
        ...(row.gitSettings?.explainAI ?? {}),
      },
    },
    // Forward-compat: a row saved before sidebar customization existed has no
    // `sidebarLayout` — fall back to the default so the rail renders pinned
    // features + "More". Arrays replace wholesale (an explicit empty `pinned`
    // is a deliberate user choice, not a missing field).
    sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT, ...(row.sidebarLayout ?? {}) },
    // `titleBarLayout` / `statusBarLayout` are deliberately NOT seeded here.
    // "Absent" is load-bearing for them: `components/shell/use-bar-layout.ts`
    // reads it as "this install has never customized the bar" and folds the
    // legacy `barItems` visibility map (persisted by the UI store before the
    // bars became orderable) into the first resolved layout. Defaulting them
    // here would make every existing install look already-customized and throw
    // that choice away.
    profile: { ...DEFAULT_USER_PROFILE, ...(row.profile ?? {}) },
    conversationTitle: { ...DEFAULTS.conversationTitle, ...(row.conversationTitle ?? {}) },
    conversationTimeline: {
      ...DEFAULTS.conversationTimeline,
      ...(row.conversationTimeline ?? {}),
      labelSummary: {
        ...DEFAULTS.conversationTimeline?.labelSummary,
        ...(row.conversationTimeline?.labelSummary ?? {}),
      },
    },
    conversationSidebar: {
      ...DEFAULTS.conversationSidebar,
      ...(row.conversationSidebar ?? {}),
    },
    routingConfig,
    autoRouting: { ...autoRouting, strategy: routingConfig.strategy },
    id: SINGLETON_ID,
  }
}

function mergeAutoRouting(
  stored: Partial<AutoRoutingSettings> | undefined,
  legacyDifficulty: DifficultyRoutingSettings | undefined
): AutoRoutingSettings {
  const strategy =
    stored?.strategy ??
    (legacyDifficulty?.enabled ? ("difficulty" as const) : DEFAULT_AUTO_ROUTING.strategy)
  return {
    ...DEFAULT_AUTO_ROUTING,
    ...(stored ?? {}),
    strategy,
    enabled: stored?.enabled ?? legacyDifficulty?.enabled ?? DEFAULT_AUTO_ROUTING.enabled,
    defaultSelection:
      stored?.defaultSelection ??
      (stored?.enabled === true || legacyDifficulty?.enabled === true
        ? "auto"
        : DEFAULT_AUTO_ROUTING.defaultSelection),
    preferredProviders: stored?.preferredProviders ?? [],
    excludedProviders: stored?.excludedProviders ?? [],
    dataPolicy: {
      ...DEFAULT_AUTO_ROUTING.dataPolicy,
      ...(stored?.dataPolicy ?? {}),
    },
    thresholds: {
      ...DEFAULT_AUTO_ROUTING.thresholds,
      ...(legacyDifficulty?.enabled ? { powerful: legacyDifficulty.threshold } : {}),
      ...(stored?.thresholds ?? {}),
    },
    candidateAliases: stored?.candidateAliases?.length
      ? [...stored.candidateAliases]
      : [...DEFAULT_AUTO_ROUTING.candidateAliases],
  }
}

/**
 * Forward-compat merge for OCR settings. Nested `platformOverrides` is shallow-
 * merged so adding a new OS bucket in DEFAULT_OCR_SETTINGS surfaces on existing
 * installs without losing the user's manual reorderings.
 */
function mergeOcrSettings(stored: UserOcrSettings | undefined): UserOcrSettings {
  const merged: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, ...(stored ?? {}) }
  merged.platformOverrides = {
    ...(DEFAULT_OCR_SETTINGS.platformOverrides ?? {}),
    ...(stored?.platformOverrides ?? {}),
  }
  merged.providerConfig = { ...(stored?.providerConfig ?? {}) }
  merged.providerEnabled = { ...(stored?.providerEnabled ?? {}) }
  return merged
}

function mergeSearchProviders(
  patch: AppSettings["searchProviders"],
  current?: AppSettings["searchProviders"]
): Record<SearchProviderType, SearchProviderSettings> {
  const merged = { ...DEFAULT_SEARCH_PROVIDER_SETTINGS, ...current }
  for (const id of Object.keys(merged) as SearchProviderType[]) {
    merged[id] = { ...DEFAULT_SEARCH_PROVIDER_SETTINGS[id], ...current?.[id], ...patch?.[id] }
  }
  return merged
}

function mergeBuiltinTools(stored: BuiltinToolsConfig | undefined): BuiltinToolsConfig {
  return { ...DEFAULT_BUILTIN_TOOLS, ...(stored ?? {}) }
}

// Serialize concurrent saveSettings calls. The function is read-modify-write
// at the DB layer (getSettings → merge → put), so two concurrent invocations
// would each `getSettings()` against the same persisted row and the second
// `put` would clobber the first's patch. That race wiped customThemes in
// production when createCustomTheme + setActiveCustomTheme fired together —
// the fire-and-forget setActiveCustomTheme save read stale state and
// overwrote the new theme row. Chaining onto a single tail Promise gives
// us a strict per-process write order without needing a mutex library.
let saveQueue: Promise<unknown> = Promise.resolve()

export interface SaveSettingsOptions {
  /**
   * Whether a paired client should also enqueue this patch for its host.
   *
   * Defaults to `true`: every call site is a user edit, and mirroring is what
   * makes a setting changed on the phone actually reach the desktop. Pass
   * `false` for writes the user did not make — boot-time repairs and seeds —
   * so a local cleanup is not replayed onto the host as an intentional edit.
   */
  mirrorToHost?: boolean
  /**
   * Internal (migration): write only when the row still holds plaintext
   * provider credentials or a copied blob to adopt, and call this when it did.
   */
  onlyForPendingProviderSecrets?: () => void
}

export async function saveSettings(
  input:
    Partial<Omit<AppSettings, "id">> | ((current: AppSettings) => Partial<Omit<AppSettings, "id">>),
  options: SaveSettingsOptions & {
    scope?: { db: ReturnType<typeof getDb>; assertActive(): void }
  } = {}
): Promise<AppSettings> {
  // Same connection-close exposure as the read, with a worse failure: a patch
  // dropped mid-boot is a setting the user watched themselves change and then
  // lose. The whole read-modify-write retries as a unit — re-reading `current`
  // is what keeps the merge correct on the second pass.
  const next = saveQueue.then(() =>
    withDbReopenRetry(async () => {
      options.scope?.assertActive()
      const { settings: current, secrets: secretState } = await readSettingsWithSecrets(
        options.scope
      )
      options.scope?.assertActive()
      if (
        options.onlyForPendingProviderSecrets &&
        !(secretState && hasPendingProviderSecretWork(secretState))
      ) {
        return current
      }
      const patch = typeof input === "function" ? input(current) : input
      // Normalized reads must not turn an unrelated preference import/save
      // into an explicit Reader choice on an existing legacy installation.
      const rawReaderRow = !Object.prototype.hasOwnProperty.call(patch, "webReader")
        ? await (options.scope?.db ?? getDb()).settings.get(SINGLETON_ID)
        : undefined
      options.scope?.assertActive()
      const migratedCurrent: AppSettings = {
        ...current,
        defaultAccountIds: current.defaultAccountIds ? { ...current.defaultAccountIds } : undefined,
      }
      migrateLegacyDefaultAccount(migratedCurrent)
      // Bump `updatedAt` on every write so the companion sync source can tell
      // when the singleton changed and re-emit it to paired phones (see
      // `lib/sync/desktop-sync-source.ts:readSettingsDelta`).
      const merged: AppSettings = {
        ...migratedCurrent,
        ...patch,
        // Portable profile imports contain preferences only. Merge each
        // provider so omitted local credentials/endpoints remain on this host;
        // explicit local writes (including clearing a key) still take effect.
        ...(patch.searchProviders !== undefined
          ? {
              searchProviders: mergeSearchProviders(patch.searchProviders, current.searchProviders),
            }
          : {}),
        ...resolveLocalePreference({
          ...migratedCurrent,
          ...patch,
          // All existing language-only setters express a manual selection.
          ...(patch.language !== undefined && patch.languageMode === undefined
            ? { languageMode: "manual" }
            : {}),
        }),
        id: SINGLETON_ID,
        updatedAt: Date.now(),
      }
      if (rawReaderRow && !Object.prototype.hasOwnProperty.call(rawReaderRow, "webReader")) {
        delete merged.webReader
      }
      migrateLegacyDefaultAccount(merged)
      delete (merged as PersistedSettingsRow)[PROVIDER_SECRETS_REF_FIELD]
      const targetDb = options.scope?.db ?? getDb()
      const persisted = await persistableSettingsRow(targetDb.name, merged, secretState)
      options.scope?.assertActive()
      await (options.scope?.db ?? getDb()).settings.put(persisted.row)
      options.scope?.assertActive()
      options.onlyForPendingProviderSecrets?.()
      if (persisted.adoptedFrom) {
        // The copied entry belongs to a database that may since have been
        // deleted; its own row (if it still exists) keeps its own blob.
        await releaseAdoptedProviderSecrets(persisted.adoptedFrom).catch(() => undefined)
      }
      // ADR-0090 Phase 1: keep the derived Provider Profile Store fresh.
      // Runs inside the serialized queue so derivations observe writes in
      // order; awaited so a caller that immediately reads profiles sees the
      // updated set, but failures never poison the settings save itself.
      if ("providerSettings" in patch || "customProviders" in patch) {
        try {
          const { syncProviderProfilesFromSettings } =
            await import("@/lib/settings/provider-profile-sync")
          options.scope?.assertActive()
          await syncProviderProfilesFromSettings(merged)
        } catch {
          // The profile store is a re-derivable projection; a failed sync is
          // recovered by the next provider-touching save.
        }
      }
      // Mirror the host-writable subset up to the paired host. Outside the
      // retry's critical section in spirit but inside it in code, because the
      // enqueue must not happen if the local write never landed. Failures are
      // swallowed: the local save is the user-visible outcome, and a queue that
      // could not be written is reported by the offline banner, not by making
      // the settings save look like it failed.
      if (options.mirrorToHost !== false) {
        try {
          const { mirrorSettingsPatchToHost } = await import("@/lib/settings/mirror-to-host")
          options.scope?.assertActive()
          await mirrorSettingsPatchToHost(patch)
        } catch {
          // Non-fatal — see above.
        }
      }
      options.scope?.assertActive()
      return merged
    })
  )
  // Swallow rejection on the queue tail so a single failure doesn't poison
  // every subsequent caller — each awaiter still gets their own rejected
  // Promise via the `next` reference returned below.
  saveQueue = next.catch(() => undefined)
  return next
}

/**
 * Split credentials off the merged row (ADR-0256 §4). The secret blob is
 * written before the row, and only when the credentials changed. When the
 * secret store is unavailable, a save that does not change credentials keeps
 * what the row already had; one that does is refused before anything is
 * written.
 */
async function persistableSettingsRow(
  dbName: string,
  merged: AppSettings,
  state: ProviderSecretState | null
): Promise<{ row: PersistedSettingsRow; adoptedFrom?: string }> {
  const { publicRow, secrets } = splitSettingsSecrets(merged)
  const resolution: ProviderSecretResolution = state?.resolution ?? { status: "ok", blob: null }
  const stored = resolution.status === "ok" ? resolution.blob : null

  // What the row held when it was read: plaintext still in it, plus its blob.
  // A save whose credentials equal that changed no credential, so when the
  // store cannot take the move it may keep the row exactly as it was.
  const keepAsItWas = (cause: unknown): { row: PersistedSettingsRow } => {
    const unchanged = overlaySecretSets(stored?.secrets, state?.legacy)
    if (!secretSetsEqual(secrets, unchanged)) {
      throw cause instanceof ProviderSecretStoreUnavailableError
        ? cause
        : new ProviderSecretStoreUnavailableError(cause)
    }
    const row: PersistedSettingsRow = joinSettingsSecrets(publicRow, state?.legacy)
    if (state?.ref) row[PROVIDER_SECRETS_REF_FIELD] = state.ref
    return { row }
  }

  if (resolution.status === "unavailable") return keepAsItWas(resolution.error)

  const adoptedFrom = resolution.adoptFrom
  const ownsStored = stored !== null && stored.db === dbName && adoptedFrom === undefined

  try {
    if (isEmptySecretSet(secrets)) {
      if (ownsStored) await deleteProviderSecrets(dbName)
      return { row: publicRow, adoptedFrom }
    }

    if (
      ownsStored &&
      state?.ref?.db === dbName &&
      state.ref.rev === stored.rev &&
      secretSetsEqual(stored.secrets, secrets)
    ) {
      return { row: { ...publicRow, [PROVIDER_SECRETS_REF_FIELD]: state.ref } }
    }

    const ref = await writeProviderSecrets(dbName, secrets)
    return { row: { ...publicRow, [PROVIDER_SECRETS_REF_FIELD]: ref }, adoptedFrom }
  } catch (error) {
    if (!(error instanceof ProviderSecretStoreUnavailableError)) throw error
    return keepAsItWas(error)
  }
}

function normalizeLegacySubscriptionProvider(
  provider: AppSettings["defaultProvider"]
): SubscriptionAccountProvider | null {
  if (provider === "opencode-go") return "opencode"
  return provider && isValidSubscriptionProviderId(provider)
    ? (provider as SubscriptionAccountProvider)
    : null
}

function migrateLegacyDefaultAccount(settings: AppSettings): void {
  const provider = normalizeLegacySubscriptionProvider(settings.defaultProvider)
  const legacyAccountId = settings.defaultAccountId
  if (!legacyAccountId || !provider) return
  settings.defaultAccountIds = {
    ...settings.defaultAccountIds,
    [provider]: settings.defaultAccountIds?.[provider] ?? legacyAccountId,
  }
  settings.defaultAccountId = undefined
}

export async function addAlwaysAllow(toolName: string): Promise<void> {
  const cur = await getSettings()
  if (cur.alwaysAllowTools.includes(toolName)) return
  await saveSettings({ alwaysAllowTools: [...cur.alwaysAllowTools, toolName] })
}

export async function removeAlwaysAllow(toolName: string): Promise<void> {
  const cur = await getSettings()
  await saveSettings({
    alwaysAllowTools: cur.alwaysAllowTools.filter((t) => t !== toolName),
  })
}
