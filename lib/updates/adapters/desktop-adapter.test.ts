/** @jest-environment jsdom */
import {
  createDesktopAdapter,
  desktopInstallsInPlace,
  desktopTarget,
  macReleaseUrl,
} from "./desktop-adapter"
import type { CatalogEntry } from "../catalog-types"

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: null as readonly CatalogEntry[] | null,
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    version: "2.0.0",
    channel: "stable",
    criticality: "routine",
    releasedAt: "2026-01-01T00:00:00Z",
    target: "windows",
    ...overrides,
  }
}

describe("desktopTarget", () => {
  it("shares the in-place platform policy with About (U13)", () => {
    expect(desktopInstallsInPlace("macos")).toBe(false)
    expect(desktopInstallsInPlace("windows")).toBe(true)
    expect(desktopInstallsInPlace("linux")).toBe(true)
    expect(macReleaseUrl("v2.0.0")).toBe(macReleaseUrl("2.0.0"))
  })
  it("maps OS families onto catalog targets", () => {
    expect(desktopTarget("macos")).toBe("darwin")
    expect(desktopTarget("windows")).toBe("windows")
    expect(desktopTarget("linux")).toBe("linux")
    expect(desktopTarget("ios")).toBe("unknown")
  })
})

describe("check", () => {
  it("is unsupported off the desktop shell", () => {
    const adapter = createDesktopAdapter({ isTauri: () => false })
    expect(adapter.isSupported()).toBe(false)
  })

  it("prefers the catalog, which carries criticality", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => {
        throw new Error("should not be reached")
      },
    })
    const [candidate] = await adapter.check({
      ...CONTEXT,
      catalog: [entry({ criticality: "critical" })],
    })
    expect(candidate).toMatchObject({
      targetVersion: "2.0.0",
      criticality: "critical",
      source: "catalog",
    })
  })

  it("falls back to the Tauri endpoint when the catalog has nothing", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "1.5.0", body: "notes" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate).toMatchObject({ targetVersion: "1.5.0", source: "tauri-endpoint" })
  })

  it("reports nothing when both sources are empty", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      checkForUpdate: async () => null,
    })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it.each([
    { revoked: true },
    { version: "*", revoked: true },
    { channel: "beta" as const },
    { compatibility: { minAppVersion: "3.0.0" } },
    { compatibility: { maxAppVersion: "0.5.0" } },
  ])("refuses verified catalog exclusions in the native fallback: %j (U03)", async (excluded) => {
    const adapter = createDesktopAdapter({
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "2.0.0" }),
    })
    expect(
      await adapter.check({ ...CONTEXT, catalogStatus: "ok", catalog: [entry(excluded)] })
    ).toEqual([])
  })

  it.each(["ok", "unconfigured", "unavailable"] as const)(
    "keeps native fallback for an unknown release with catalog %s (U03)",
    async (catalogStatus) => {
      const adapter = createDesktopAdapter({
        osFamily: () => "windows",
        appVersion: "1.0.0",
        checkForUpdate: async () => ({ version: "2.0.0" }),
      })
      expect(
        await adapter.check({
          ...CONTEXT,
          catalogStatus,
          catalog: catalogStatus === "ok" ? [entry({ target: "darwin", channel: "beta" })] : null,
        })
      ).toEqual([expect.objectContaining({ targetVersion: "2.0.0" })])
    }
  )

  it("hands macOS off to a signed download instead of installing in place", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "macos",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "1.5.0" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.action).toBe("open-store")
    expect(candidate.externalUrl).toBe(macReleaseUrl("1.5.0"))
  })

  it("leaves Windows on the in-app path", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "1.5.0" }),
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.action).toBeUndefined()
  })
})

describe("apply", () => {
  const candidate = {
    assetId: "app",
    kind: "desktop" as const,
    executor: "tauri" as const,
    currentVersion: "1.0.0",
    targetVersion: "1.5.0",
    channel: "stable" as const,
    criticality: "routine" as const,
    source: "catalog" as const,
    provenance: "verified" as const,
  }

  it("delegates a desktop restart to the platform updater (U06)", async () => {
    const relaunchApp = jest.fn(async () => {})
    const adapter = createDesktopAdapter({ relaunchApp })
    await adapter.restart!()
    expect(relaunchApp).toHaveBeenCalledTimes(1)
  })

  it("opens the release page for a macOS handoff", async () => {
    const opened: string[] = []
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "macos",
      openExternal: async (url) => {
        opened.push(url)
      },
    })
    const result = await adapter.apply(
      { ...candidate, action: "open-store", externalUrl: "https://example.test/dmg" },
      { consented: true }
    )
    expect(result.state).toBe("awaiting-store")
    expect(opened).toEqual(["https://example.test/dmg"])
  })

  it("refuses a handoff with no download URL instead of opening nothing", async () => {
    const adapter = createDesktopAdapter({ isTauri: () => true, osFamily: () => "macos" })
    const result = await adapter.apply({ ...candidate, action: "open-store" }, { consented: true })
    expect(result.state).toBe("failed")
    expect(result.failure?.code).toBe("no_download_url")
  })

  it("downloads only with the explicit flag even when consent has been given (U01)", async () => {
    let installed = false
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      downloadUpdate: async () => "downloaded",
      downloadAndInstallUpdate: async () => {
        installed = true
        return "relaunching"
      },
      installUpdate: async () => "installed",
    })
    const result = await adapter.apply(candidate, { consented: true, downloadOnly: true })
    expect(result.state).toBe("awaiting-consent")
    expect(installed).toBe(false)
  })

  it("does not infer a background download from missing consent", async () => {
    const download = jest.fn()
    const install = jest.fn()
    const adapter = createDesktopAdapter({
      osFamily: () => "windows",
      downloadUpdate: download,
      downloadAndInstallUpdate: install,
    })
    expect(await adapter.apply(candidate, { consented: false })).toEqual({
      state: "awaiting-consent",
    })
    expect(download).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it("never opens a handoff page for a download-only request (U01)", async () => {
    const openExternal = jest.fn()
    const adapter = createDesktopAdapter({ osFamily: () => "macos", openExternal })
    await adapter.apply(
      { ...candidate, action: "open-store", externalUrl: macReleaseUrl("1.5.0") },
      {
        consented: true,
        downloadOnly: true,
      }
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "binds apply to the candidate version (downloadOnly=%s, U02)",
    async (downloadOnly) => {
      const download = jest.fn(async () => "versionMismatch" as const)
      const install = jest.fn(async () => "versionMismatch" as const)
      const adapter = createDesktopAdapter({
        osFamily: () => "windows",
        downloadUpdate: download,
        downloadAndInstallUpdate: install,
      })
      expect(await adapter.apply(candidate, { consented: true, downloadOnly })).toMatchObject({
        state: "failed",
        failure: { code: "candidate_changed", recoveryActionKey: "retry" },
      })
      expect(downloadOnly ? download : install).toHaveBeenCalledWith(expect.any(Function), {
        expectedVersion: "1.5.0",
      })
    }
  )

  it("lands in awaiting-restart after a consented install", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      downloadAndInstallUpdate: async () => "relaunching",
      downloadUpdate: async () => "downloaded",
      installUpdate: async () => "installed",
    })
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("awaiting-restart")
  })

  it("returns to current when the release vanished mid-flight", async () => {
    const adapter = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "windows",
      downloadAndInstallUpdate: async () => "noLongerAvailable",
      downloadUpdate: async () => "noLongerAvailable",
      installUpdate: async () => "noLongerAvailable",
    })
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("current")
  })

  it("keeps an installed update restartable when automatic relaunch fails (U06)", async () => {
    const { AppUpdateError } = await import("@/lib/tauri/updater")
    const adapter = createDesktopAdapter({
      downloadAndInstallUpdate: async () => {
        throw new AppUpdateError("relaunch", "relaunch", "restart denied", null)
      },
    })
    expect(await adapter.apply(candidate, { consented: true })).toMatchObject({
      state: "awaiting-restart",
      failure: { code: "relaunch" },
    })
  })
})
