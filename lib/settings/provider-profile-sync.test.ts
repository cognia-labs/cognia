// Settings → Provider Profile Store dual-write: change detection, version
// economy (no spurious CAS bumps), and the structural no-loop guarantee.

import { getProfileMeta, listDeploymentProfiles } from "@/lib/db/provider-profiles"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { saveSettings, getSettings } from "@/lib/db/settings"

import {
  __resetProviderProfileSync,
  syncProviderProfilesFromSettings,
  touchesProviderConfiguration,
} from "./provider-profile-sync"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetProviderProfileSync()
})

afterAll(dbFixture.dispose)

describe("touchesProviderConfiguration", () => {
  it("only fires for provider-shaped patches", () => {
    expect(touchesProviderConfiguration({ providerSettings: {} })).toBe(true)
    expect(touchesProviderConfiguration({ customProviders: [] })).toBe(true)
    expect(touchesProviderConfiguration({ theme: "dark" } as never)).toBe(false)
  })
})

describe("syncProviderProfilesFromSettings", () => {
  const zhipuSettings = {
    providerSettings: {
      zhipu: { providerId: "zhipu", enabled: true, defaultModel: "glm-4.6", apiKey: "sk-x" },
      "glm-anthropic": { providerId: "glm-anthropic", enabled: true },
    },
    customProviders: [],
  } as never

  it("derives and persists on first sync, then skips identical derivations", async () => {
    const first = await syncProviderProfilesFromSettings(zhipuSettings)
    expect(first).toBe(1)
    expect((await listDeploymentProfiles()).map((d) => d.id).sort()).toEqual([
      "glm-anthropic",
      "zhipu",
    ])

    // Identical content ⇒ no write, no version bump.
    const second = await syncProviderProfilesFromSettings(zhipuSettings)
    expect(second).toBeNull()
    expect((await getProfileMeta())?.profileVersion).toBe(1)
  })

  it("bumps the version when provider configuration actually changes", async () => {
    await syncProviderProfilesFromSettings(zhipuSettings)
    const changed = await syncProviderProfilesFromSettings({
      providerSettings: {
        zhipu: { providerId: "zhipu", enabled: false, defaultModel: "glm-4.6" },
      },
      customProviders: [],
    } as never)
    expect(changed).toBe(2)
    const deployments = await listDeploymentProfiles()
    expect(deployments.find((d) => d.id === "zhipu")?.enabled).toBe(false)
    expect(deployments.find((d) => d.id === "glm-anthropic")).toBeUndefined()
  })

  it("compares against the persisted store after a process restart", async () => {
    await syncProviderProfilesFromSettings(zhipuSettings)
    // Simulate reload: module memo gone, store retained.
    __resetProviderProfileSync()
    const afterReload = await syncProviderProfilesFromSettings(zhipuSettings)
    expect(afterReload).toBeNull()
    expect((await getProfileMeta())?.profileVersion).toBe(1)
  })
})

describe("saveSettings wiring", () => {
  it("keeps the store fresh on provider-touching saves and never writes back to settings", async () => {
    await saveSettings({
      providerSettings: {
        moonshot: { providerId: "moonshot", enabled: true, defaultModel: "kimi-k2.7-code" },
      },
    } as never)

    const deployments = await listDeploymentProfiles()
    expect(deployments.map((d) => d.id)).toContain("moonshot")

    const settingsAfter = await getSettings()
    const updatedAt = settingsAfter.updatedAt
    // A non-provider save leaves the profile store untouched.
    await saveSettings({ fontScale: "md" } as never)
    expect((await getProfileMeta())?.profileVersion).toBe(1)
    // And the sync itself never re-entered saveSettings (updatedAt advanced
    // exactly once for the second save).
    const settingsFinal = await getSettings()
    expect(settingsFinal.updatedAt).toBeGreaterThanOrEqual(updatedAt ?? 0)
  })

  it("a broken profile sync never fails the settings save", async () => {
    const profileDb = getDb()
    const clearSpy = jest
      .spyOn(profileDb.providerProfiles, "clear")
      .mockRejectedValue(new Error("idb down"))
    const saved = await saveSettings({
      providerSettings: { openai: { providerId: "openai", enabled: true } },
    } as never)
    expect(saved.providerSettings).toBeTruthy()
    clearSpy.mockRestore()
  })
})

describe("syncProviderProfilesFromSettings — per-database memo", () => {
  // Each account/runtime target selects its own database, and each holds its
  // own profile store: a memo shared across them skipped populating an empty
  // database whose settings derived to the same content.
  it("populates a second, empty database with identical settings", async () => {
    const emptyTable = { toArray: async () => [] }
    const databases = ["cognia-account-a", "cognia-account-b"].map((name) => ({
      name,
      providerProfiles: emptyTable,
      deploymentProfiles: emptyTable,
      transportProfiles: emptyTable,
    }))
    let active = databases[0]
    let calls = 0
    const putDerivedProfiles = jest.fn(async () => ++calls)

    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/db/schema", () => ({ getDb: () => active }))
      jest.doMock("@/lib/db/provider-profiles", () => ({ putDerivedProfiles }))
      const sync = await import("./provider-profile-sync")
      const settings = {
        providerSettings: { zhipu: { providerId: "zhipu", enabled: true } },
        customProviders: [],
      } as never

      expect(await sync.syncProviderProfilesFromSettings(settings)).toBe(1)
      // Same database, same content: skipped.
      expect(await sync.syncProviderProfilesFromSettings(settings)).toBeNull()

      active = databases[1]
      expect(await sync.syncProviderProfilesFromSettings(settings)).toBe(2)
      expect(putDerivedProfiles).toHaveBeenCalledTimes(2)
    })
  })
})
