"use client"

/**
 * Production wiring for the Update Center.
 *
 * Everything above this file is injectable and testable. This is the one place
 * that binds the coordinator to the real settings store, the real catalog
 * endpoint, and the real installers, so a test never has to touch any of them.
 */

import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  type UpdateCenterSettings,
} from "@cognia/agent-config-types"

import { APP_VERSION } from "@/lib/app-version"
import { loggers } from "@cognia/logging"
import { isNativeMobile } from "@/lib/platform/detect"
import { detectOsFamily } from "@/lib/platform/os"
import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { saveSettings } from "@/lib/db/settings"
import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { registerRuntimeTargetCleanup } from "@/lib/runtime/runtime-target-lifecycle"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

import type { UpdateAdapter } from "./adapter"
import { createBrowserExtensionAdapter } from "./adapters/browser-extension-adapter"
import { createCharacterPackAdapter } from "./adapters/character-pack-adapter"
import { createCliAdapter } from "./adapters/cli-adapter"
import { createHostAdapter } from "./adapters/host-adapter"
import { createDesktopAdapter } from "./adapters/desktop-adapter"
import { createMobileAdapter } from "./adapters/mobile-adapter"
import { createPluginAdapter } from "./adapters/plugin-adapter"
import { createSkillAdapter } from "./adapters/skill-adapter"
import { fetchVerifiedCatalog } from "./catalog-client"
import { UpdateCoordinator, type UpdatePersistence } from "./coordinator"
import { openUpdateCenter } from "./open-update-center"

/** Read the current Update Center settings out of the hydrated settings store. */
export function readUpdateCenterSettings(): UpdateCenterSettings {
  const raw = useSettingsStore.getState().settings?.updateCenter
  return { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...(raw ?? {}) }
}

let settingsSaveQueue: Promise<void> = Promise.resolve()

function settingsPersistence(
  db: ReturnType<typeof getDb>,
  assertActive: () => void
): UpdatePersistence {
  const scope = { db, assertActive }
  const write: UpdatePersistence["write"] = (patch) => {
    const task = settingsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        assertActive()
        const next = await saveSettings(
          (current) => {
            assertActive()
            return {
              updateCenter: {
                ...DEFAULT_UPDATE_CENTER_SETTINGS,
                ...current.updateCenter,
                ...patch,
                ...(patch.snapshots
                  ? {
                      snapshots: { ...current.updateCenter?.snapshots, ...patch.snapshots },
                    }
                  : {}),
              },
            }
          },
          { scope, mirrorToHost: false }
        )
        assertActive()
        useSettingsStore.setState({ settings: next })
      })
    settingsSaveQueue = task
    return task
  }
  return {
    read: () => {
      assertActive()
      return readUpdateCenterSettings()
    },
    write,
    writeSnapshots: (snapshots) => write({ snapshots }),
  }
}

/** Adapters that exist on this host, already bound to their real backends. */
export function productionAdapters(): UpdateAdapter[] {
  return [
    createDesktopAdapter(),
    createMobileAdapter("mobile-ios", { playCore: undefined }),
    createMobileAdapter("mobile-android", {
      playAvailable: async () => {
        const { getGooglePlayServicesStatus } = await import("@/lib/capacitor/google-play-services")
        return (await getGooglePlayServicesStatus()).available
      },
      playCore: {
        getAppUpdateInfo: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.getAppUpdateInfo(...args)),
        startFlexibleUpdate: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.startFlexibleUpdate(...args)),
        completeFlexibleUpdate: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.completeFlexibleUpdate(...args)),
        performImmediateUpdate: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.performImmediateUpdate(...args)),
        openAppStore: (...args) =>
          import("@/lib/capacitor/app-update").then((m) => m.openAppStore(...args)),
      },
    }),
    createBrowserExtensionAdapter("browser-chrome", { isSupported: () => isTauri() }),
    createBrowserExtensionAdapter("browser-edge", { isSupported: () => isTauri() }),
    createCliAdapter({
      isSupported: () => isTauri(),
      installedVersion: async () => {
        const { detectInstalledCli } = await import("./cli-presence")
        return (await detectInstalledCli()).version
      },
      packageManager: async () => {
        const { detectInstalledCli } = await import("./cli-presence")
        return (await detectInstalledCli()).manager
      },
    }),
    createPluginAdapter({
      isSupported: () => !isNativeMobile(),
      permissionsExpanded: async (pluginId, version) => {
        const [{ usePluginStore }, { getPluginMarketplace }, { hasNetworkAccessWidened }] =
          await Promise.all([
            import("@/stores/plugin-runtime"),
            import("@/lib/plugin/package/marketplace"),
            import("@/lib/plugin/security/network-allowlist"),
          ])
        const current = usePluginStore.getState().plugins[pluginId]?.manifest
        const next = (await getPluginMarketplace().getPlugin(pluginId))?.manifest
        if (!current || next?.version !== version) return undefined
        const granted = new Set(current.permissions ?? [])
        return (
          (next.permissions ?? []).some((permission) => !granted.has(permission)) ||
          hasNetworkAccessWidened(current.networkAccess, next.networkAccess)
        )
      },
    }),
    // ADR-0224 A10: each paired always-on host reports and installs its own.
    createHostAdapter({
      listHosts: () =>
        useRemoteHostStore
          .getState()
          .hosts.filter((host) => host.alwaysOn === true && host.connectionState !== "revoked")
          .map((host) => ({ id: host.id, label: host.label })),
      readStatus: (hostId) =>
        import("@/lib/remote-host/host-update").then((m) => m.readHostUpdateStatus(hostId)),
      install: (hostId) =>
        import("@/lib/remote-host/host-update").then((m) => m.installHostUpdate(hostId)),
    }),
    createSkillAdapter({
      isSupported: () => true,
      checkAll: async () => {
        const [{ listSkills }, { checkSkillsShUpdates }] = await Promise.all([
          import("@/lib/db/skills"),
          import("@/lib/skills/skillssh-updates"),
        ])
        const skills = await listSkills()
        const statuses = await checkSkillsShUpdates(skills)
        const byId = new Map(skills.map((s) => [s.id, s]))
        return statuses.map((status) => ({
          skillId: status.skillId,
          canonicalId: status.canonicalId,
          name: byId.get(status.skillId)?.name ?? status.skillId,
          hasUpdate: status.hasUpdate,
          currentHash: status.currentHash,
          remoteHash: status.remoteHash,
          error: status.error,
        }))
      },
      updateOne: async (skillId, options) => {
        const [{ listSkills }, { marketplaceItemFromSkill }, { installMarketplaceItem }] =
          await Promise.all([
            import("@/lib/db/skills"),
            import("@/lib/skills/skillssh-updates"),
            import("@/lib/skills/marketplace-install"),
          ])
        const skill = (await listSkills()).find((s) => s.id === skillId)
        const item = skill ? marketplaceItemFromSkill(skill) : null
        if (!item) throw new Error("skill was not installed from a remote source")
        await installMarketplaceItem(item, options)
      },
    }),
    createCharacterPackAdapter({
      isSupported: () => true,
      listPacks: async () => {
        const { listCharacters, previewPackUpdate } = await import("@/lib/db/characters")
        const rows = await listCharacters()
        const packs = []
        for (const row of rows) {
          if (!row.sourcePluginId || !row.sourcePackId) continue
          const preview = await previewPackUpdate(row.id)
          if (!preview) continue
          packs.push({
            characterId: row.id,
            displayName: row.name,
            pluginId: row.sourcePluginId,
            appliedVersion: row.packVersionAtClone ?? "unknown",
            availableVersion: preview.packVersion,
            userEditedFields: preview.diff.preserved.length,
          })
        }
        return packs
      },
      openDiff: async (characterId) => {
        openUpdateCenter({ packDiffCharacterId: characterId })
      },
    }),
  ]
}

let singleton: UpdateCoordinator | null = null
let singletonScope: string | null = null
let singletonDb: ReturnType<typeof getDb> | null = null
let unregisterCleanup: (() => void) | undefined
let unsubscribeScope: (() => void) | undefined

/** The app-wide coordinator. Created once, on first use. */
export function getUpdateCoordinator(): UpdateCoordinator {
  const scope = getRuntimeTargetScopeKey()
  const db = getDb()
  if (singleton && (singletonScope !== scope || singletonDb !== db)) resetUpdateCoordinator()
  if (singleton) return singleton
  const assertActive = (): void => {
    if (singleton !== coordinator || getRuntimeTargetScopeKey() !== scope || getDb() !== db) {
      // Database activation precedes the runtime scope event on account switch.
      if (singleton === coordinator) resetUpdateCoordinator()
      throw new Error("Update coordinator account scope changed")
    }
  }
  const coordinator = new UpdateCoordinator({
    adapters: productionAdapters(),
    persistence: settingsPersistence(db, assertActive),
    appVersion: APP_VERSION,
    fetchCatalog: async ({ channel, signal }) => {
      assertActive()
      const settings = readUpdateCenterSettings()
      const result = await fetchVerifiedCatalog(
        { channel, rolloutBucket: settings.rolloutBucket ?? 0, signal },
        {
          catalogUrl: settings.catalogUrl,
          platform: detectOsFamily(),
          onError: (error) =>
            loggers.app.debug("updates.catalogUnavailable", { error: String(error) }),
        }
      )
      assertActive()
      return result
    },
    checkIntervalMs: () => {
      assertActive()
      const minutes = useSettingsStore.getState().settings?.updates?.checkIntervalMinutes
      return (typeof minutes === "number" ? minutes : 6 * 60) * 60 * 1000
    },
    telemetry: (event) => loggers.app.info("updates.attempt", { ...event }),
    onError: (scope, error) => loggers.app.warn("updates.error", { scope, error: String(error) }),
  })
  singleton = coordinator
  singletonScope = scope
  singletonDb = db
  unregisterCleanup = registerRuntimeTargetCleanup(resetUpdateCoordinator)
  unsubscribeScope = subscribeRuntimeTargetContext(resetUpdateCoordinator)
  return coordinator
}

/** Retire account-local state before its database or runtime is replaced. */
export function resetUpdateCoordinator(): void {
  const previous = singleton
  singleton = null
  singletonScope = null
  singletonDb = null
  unregisterCleanup?.()
  unsubscribeScope?.()
  unregisterCleanup = undefined
  unsubscribeScope = undefined
  previous?.dispose()
}

/** Test-only: use the same lifetime fence as an account switch. */
export function __resetUpdateCoordinator(): void {
  resetUpdateCoordinator()
}
