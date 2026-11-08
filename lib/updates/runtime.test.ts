/** @jest-environment jsdom */
import {
  ASSET_KIND_GROUP,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_UPDATE_CENTER_SETTINGS,
  UPDATE_ASSET_KINDS,
  type AppSettings,
  type UpdateCenterSettings,
} from "@cognia/agent-config-types"

const settingsState: { settings: AppSettings | undefined; saved: unknown[] } = {
  settings: undefined,
  saved: [],
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: settingsState.settings,
    }),
    setState: jest.fn((patch: { settings: AppSettings }) => {
      settingsState.settings = patch.settings
    }),
  },
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/settings", () => ({ saveSettings: jest.fn() }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))
jest.mock("./catalog-client", () => ({
  fetchVerifiedCatalog: jest.fn(async () => ({ status: "ok", entries: [] })),
}))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn() }))
jest.mock("@/lib/skills/skillssh-updates", () => ({
  checkSkillsShUpdates: jest.fn(),
  marketplaceItemFromSkill: jest.fn(),
}))
jest.mock("@/lib/skills/marketplace-install", () => ({ installMarketplaceItem: jest.fn() }))
jest.mock("@/stores/plugin-runtime", () => ({ usePluginStore: { getState: jest.fn() } }))
jest.mock("@/lib/plugin/package/marketplace", () => ({
  getPluginMarketplace: () => ({
    getPlugin: jest.fn(async () => ({
      manifest: {
        version: "2.0.0",
        permissions: ["network:fetch"],
        networkAccess: { allowedDomains: ["*"] },
      },
    })),
  }),
}))
jest.mock("@/lib/plugin/lifecycle/updater", () => ({
  getPluginUpdater: () => ({
    checkForUpdates: jest.fn(async () => [
      {
        pluginId: "p1",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
      },
    ]),
  }),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isNativeMobile: () => false,
  isTauri: () => true,
}))
jest.mock("@cognia/logging", () => ({
  loggers: {
    app: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  },
}))

import {
  __resetUpdateCoordinator,
  getUpdateCoordinator,
  productionAdapters,
  readUpdateCenterSettings,
} from "./runtime"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { stopRuntimeTargetSubscriptions } from "@/lib/runtime/runtime-target-lifecycle"
import { openExternal } from "@/lib/tauri/opener"
import { fetchVerifiedCatalog } from "./catalog-client"
import { listSkills } from "@/lib/db/skills"
import { checkSkillsShUpdates, marketplaceItemFromSkill } from "@/lib/skills/skillssh-updates"
import { installMarketplaceItem } from "@/lib/skills/marketplace-install"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { UpdateCandidate } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings/settings-store"

function settingsWithCenter(updateCenter: Partial<UpdateCenterSettings> = {}): AppSettings {
  return {
    id: "singleton",
    alwaysAllowTools: [],
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    updateCenter: { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...updateCenter },
  }
}

beforeEach(() => {
  settingsState.settings = settingsWithCenter()
  settingsState.saved = []
  __resetUpdateCoordinator()
  clearActiveRuntimeTargetContext()
  jest.mocked(getDb).mockReturnValue({ name: "account-a" } as ReturnType<typeof getDb>)
  jest
    .mocked(saveSettings)
    .mockReset()
    .mockImplementation(async (input, options) => {
      options?.scope?.assertActive()
      const current = settingsState.settings!
      const patch = typeof input === "function" ? input(current) : input
      settingsState.saved.push(patch.updateCenter)
      await Promise.resolve()
      return { ...current, ...patch }
    })
  jest.mocked(useSettingsStore.setState).mockClear()
  jest.mocked(fetchVerifiedCatalog).mockClear()
})

afterEach(async () => {
  __resetUpdateCoordinator()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

async function offeredPluginRows() {
  settingsState.settings = settingsWithCenter({ rolloutBucket: 0 })
  const coordinator = getUpdateCoordinator()
  const adapter = coordinator.supportedAdapters().find((a) => a.kind === "plugin")!
  jest.spyOn(adapter, "check").mockResolvedValue(
    ["one", "two"].map((assetId): UpdateCandidate => ({
      assetId,
      kind: "plugin",
      executor: "plugin-runtime",
      currentVersion: "1.0.0",
      targetVersion: "2.0.0",
      channel: "stable",
      criticality: "routine",
      source: "registry",
      provenance: "verified",
    }))
  )
  await coordinator.check({ kind: "plugin", manual: true })
  return coordinator
}

describe("readUpdateCenterSettings", () => {
  it("merges the defaults forward for an install that never saw this feature", () => {
    expect(readUpdateCenterSettings()).toEqual(DEFAULT_UPDATE_CENTER_SETTINGS)
  })

  it("keeps a stored channel", () => {
    settingsState.settings = settingsWithCenter({ channel: "beta" })
    expect(readUpdateCenterSettings().channel).toBe("beta")
    expect(readUpdateCenterSettings().notifyCritical).toBe(true)
  })
})

describe("productionAdapters", () => {
  const adapters = productionAdapters()

  it("flags network widening using the offered version's manifest (U15)", async () => {
    ;(usePluginStore.getState as jest.Mock).mockReturnValue({
      plugins: {
        p1: {
          manifest: {
            version: "1.0.0",
            permissions: ["network:fetch"],
            networkAccess: { allowedDomains: ["api.example.com"] },
          },
        },
      },
    })
    const adapter = productionAdapters().find((a) => a.kind === "plugin")!
    const [candidate] = await adapter.check({
      channel: "stable",
      rolloutBucket: 0,
      manual: true,
      catalog: null,
    })
    expect(candidate.permissionsExpanded).toBe(true)
  })

  it("passes the full reviewed skill hash to the production installer (U20)", async () => {
    const item = { source: "skillssh", sourceId: "o/r/s" }
    const remoteHash = `sha256:${"a".repeat(64)}`
    ;(listSkills as jest.Mock).mockResolvedValue([{ id: "s1", name: "Skill" }])
    ;(checkSkillsShUpdates as jest.Mock).mockResolvedValue([
      {
        skillId: "s1",
        canonicalId: "skillssh:o/r/s",
        hasUpdate: true,
        currentHash: "old",
        remoteHash,
      },
    ])
    ;(marketplaceItemFromSkill as jest.Mock).mockReturnValue(item)
    const adapter = productionAdapters().find((a) => a.kind === "skill")!
    const [candidate] = await adapter.check({
      channel: "stable",
      rolloutBucket: 0,
      manual: true,
      catalog: null,
    })
    expect(await adapter.apply(candidate, { consented: true })).toMatchObject({ state: "verified" })
    expect(installMarketplaceItem).toHaveBeenCalledWith(item, { expectedHash: remoteHash })
  })

  it("covers every asset kind the vocabulary declares", () => {
    const kinds = new Set(adapters.map((a) => a.kind))
    for (const kind of UPDATE_ASSET_KINDS) expect([...kinds]).toContain(kind)
  })

  it("never claims an in-app install for a store-backed asset", () => {
    for (const adapter of adapters) {
      if (adapter.kind.startsWith("mobile-")) expect(adapter.executor).not.toBe("tauri")
      if (adapter.kind.startsWith("browser-")) expect(adapter.executor).toBe("browser-store")
    }
  })

  it("places every adapter in a display group", () => {
    for (const adapter of adapters) expect(ASSET_KIND_GROUP[adapter.kind]).toBeDefined()
  })

  it.each(["browser-chrome", "browser-edge"] as const)(
    "production %s offers only the store handoff (U23)",
    async (kind) => {
      const adapter = adapters.find((a) => a.kind === kind)!
      const [candidate] = await adapter.check({
        channel: "stable",
        rolloutBucket: 0,
        manual: true,
        catalogStatus: "ok",
        catalog: [
          {
            assetId: "companion-extension",
            kind,
            executor: "browser-store",
            version: "2.0.0",
            channel: "stable",
            criticality: "routine",
            releasedAt: "2026-01-01T00:00:00Z",
          },
        ],
      })
      expect(candidate).toMatchObject({ action: "open-store", currentVersion: null })
      expect((await adapter.apply(candidate, { consented: true })).state).toBe("awaiting-store")
      expect(openExternal).toHaveBeenCalledWith(candidate.externalUrl)
    }
  )
})

describe("getUpdateCoordinator", () => {
  it("refuses an old coordinator's write after the database changes before the runtime scope (U10)", async () => {
    const first = await offeredPluginRows()
    const settingsB = settingsWithCenter({ channel: "beta", rolloutBucket: 1 })
    jest.mocked(getDb).mockReturnValue({ name: "account-b" } as ReturnType<typeof getDb>)
    settingsState.settings = settingsB
    settingsState.saved = []
    jest.mocked(saveSettings).mockClear()
    jest.mocked(useSettingsStore.setState).mockClear()

    await first.skip("plugin:one")

    expect(settingsState.saved).toEqual([])
    expect(saveSettings).not.toHaveBeenCalled()
    expect(useSettingsStore.setState).not.toHaveBeenCalled()
    expect(settingsState.settings).toBe(settingsB)
    expect(first.isSweepDue()).toBe(false)
    const second = getUpdateCoordinator()
    expect(second).not.toBe(first)
    expect(second.rolloutBucket()).toBe(1)
  })

  it("rebuilds for a new database instance even with the same name and runtime scope (U10)", () => {
    const first = getUpdateCoordinator()
    jest.mocked(getDb).mockReturnValue({ name: "account-a" } as ReturnType<typeof getDb>)
    expect(getUpdateCoordinator()).not.toBe(first)
    expect(first.isSweepDue()).toBe(false)
  })

  it("refuses decision reads after the database switches without a runtime scope change (U10)", async () => {
    const first = getUpdateCoordinator()
    jest.mocked(getDb).mockReturnValue({ name: "account-b" } as ReturnType<typeof getDb>)
    settingsState.settings = settingsWithCenter({ channel: "beta", rolloutBucket: 1 })
    expect(await first.check({ kind: "browser-chrome", manual: true })).toEqual([])
    expect(fetchVerifiedCatalog).not.toHaveBeenCalled()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it("persists two concurrent skips through the module-local write queue (U09)", async () => {
    const coordinator = await offeredPluginRows()
    const db = getDb()
    let persisted = settingsState.settings!
    jest.mocked(saveSettings).mockImplementation(async (input, options) => {
      options?.scope?.assertActive()
      const patch = typeof input === "function" ? input(persisted) : input
      await Promise.resolve()
      persisted = { ...persisted, ...patch }
      return persisted
    })
    await Promise.all([coordinator.skip("plugin:one"), coordinator.skip("plugin:two")])
    expect(persisted.updateCenter?.snapshots).toMatchObject({
      "plugin:one": { skippedVersion: "2.0.0" },
      "plugin:two": { skippedVersion: "2.0.0" },
    })
    expect(useSettingsStore.getState().settings).toBe(persisted)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.any(Function), {
      scope: { db, assertActive: expect.any(Function) },
      mirrorToHost: false,
    })
  })

  it("merges snapshot patches into the latest database settings rather than an older store view (U09)", async () => {
    const coordinator = await offeredPluginRows()
    const latest: AppSettings = {
      ...settingsState.settings!,
      updateCenter: {
        ...DEFAULT_UPDATE_CENTER_SETTINGS,
        channel: "beta",
        notifyCritical: false,
        snapshots: { "skill:existing": { kind: "skill", assetId: "existing", state: "current" } },
      },
    }
    jest.mocked(saveSettings).mockImplementationOnce(async (input) => {
      const patch = typeof input === "function" ? input(latest) : input
      return { ...latest, ...patch }
    })
    await coordinator.skip("plugin:one")
    expect(readUpdateCenterSettings()).toMatchObject({
      channel: "beta",
      notifyCritical: false,
      snapshots: {
        "skill:existing": { kind: "skill", state: "current" },
        "plugin:one": { skippedVersion: "2.0.0" },
      },
    })
  })

  it("rejects queued A writes and an old completion before publishing B's settings (U10)", async () => {
    const first = await offeredPluginRows()
    const db = getDb()
    const settingsA = settingsState.settings!
    let release!: (settings: AppSettings) => void
    jest
      .mocked(saveSettings)
      .mockClear()
      .mockImplementationOnce((_input, options) => {
        expect(options?.scope?.db).toBe(db)
        return new Promise((resolve) => {
          release = resolve
        })
      })
    const pending = first.skip("plugin:one")
    const queued = first.skip("plugin:two")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(saveSettings).toHaveBeenCalledTimes(1)
    const settingsB = settingsWithCenter({ channel: "beta", rolloutBucket: 1 })
    jest.mocked(getDb).mockReturnValue({ name: "account-b" } as ReturnType<typeof getDb>)
    settingsState.settings = settingsB
    jest.mocked(useSettingsStore.setState).mockClear()
    release(settingsA)
    await Promise.all([pending, queued])
    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.setState).not.toHaveBeenCalled()
    expect(settingsState.settings).toBe(settingsB)
    const second = getUpdateCoordinator()
    await second.check({ kind: "browser-chrome", manual: true })
    expect(saveSettings).toHaveBeenCalledTimes(2)
  })

  it("guards the functional database merge if scope expires after the queued step starts (U10)", async () => {
    const first = await offeredPluginRows()
    const db = getDb()
    const settingsA = settingsState.settings!
    const settingsB = settingsWithCenter({ channel: "beta", rolloutBucket: 1 })
    jest.mocked(saveSettings).mockImplementationOnce(async (input, options) => {
      expect(options?.scope?.db).toBe(db)
      jest.mocked(getDb).mockReturnValue({ name: "account-b" } as ReturnType<typeof getDb>)
      settingsState.settings = settingsB
      expect(typeof input).toBe("function")
      if (typeof input === "function") {
        expect(() => input(settingsA)).toThrow("account scope changed")
      }
      return settingsA
    })
    jest.mocked(useSettingsStore.setState).mockClear()
    await first.skip("plugin:one")
    expect(useSettingsStore.setState).not.toHaveBeenCalled()
    expect(settingsState.settings).toBe(settingsB)
  })
  it("replaces the singleton on account/target cleanup and ignores a late check (U10)", async () => {
    setActiveRuntimeTargetContext("acct_alpha", "local-host")
    settingsState.settings = settingsWithCenter({ rolloutBucket: 0 })
    const first = getUpdateCoordinator()
    let finish!: (value: UpdateCandidate[]) => void
    let signal: AbortSignal | undefined
    const adapter = first.supportedAdapters().find((a) => a.kind === "plugin")!
    jest.spyOn(adapter, "check").mockImplementation((context) => {
      signal = context.signal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = first.check({ kind: "plugin" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await stopRuntimeTargetSubscriptions()
    setActiveRuntimeTargetContext("acct_beta", "local-host")
    settingsState.settings = settingsWithCenter({ channel: "beta", rolloutBucket: 1 })
    settingsState.saved = []
    const second = getUpdateCoordinator()
    expect(second).not.toBe(first)
    const listener = jest.fn()
    second.subscribe(listener)
    finish([
      {
        assetId: "private-plugin-a",
        kind: "plugin",
        executor: "plugin-runtime",
        currentVersion: "1.0.0",
        targetVersion: "2.0.0",
        channel: "stable",
        criticality: "routine",
        source: "registry",
        provenance: "verified",
      },
    ])
    await pending
    expect(signal?.aborted).toBe(true)
    expect(settingsState.saved).toEqual([])
    expect(second.getItems()).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    await second.check({ kind: "browser-chrome", manual: true })
    expect(fetchVerifiedCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ channel: "beta", rolloutBucket: 1 }),
      expect.any(Object)
    )
  })

  it("drops the old instance on a direct context change (U10)", () => {
    setActiveRuntimeTargetContext("acct_alpha", "local-host")
    const first = getUpdateCoordinator()
    setActiveRuntimeTargetContext("acct_beta", "local-host")
    expect(getUpdateCoordinator()).not.toBe(first)
    expect(first.isSweepDue()).toBe(false)
  })
  it("is a singleton so two surfaces cannot run competing sweeps", () => {
    expect(getUpdateCoordinator()).toBe(getUpdateCoordinator())
  })

  it("persists through the settings store", async () => {
    const coordinator = getUpdateCoordinator()
    coordinator.rolloutBucket()
    await new Promise((r) => setTimeout(r, 0))
    expect(settingsState.saved.length).toBeGreaterThan(0)
    expect(readUpdateCenterSettings().rolloutBucket).toBeGreaterThanOrEqual(0)
  })

  it("keeps one stable rollout bucket across calls", () => {
    const coordinator = getUpdateCoordinator()
    const first = coordinator.rolloutBucket()
    expect(coordinator.rolloutBucket()).toBe(first)
  })
})
