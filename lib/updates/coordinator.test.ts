import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  type UpdateCandidate,
  type UpdateCenterSettings,
} from "@cognia/agent-config-types"

import type { UpdateAdapter, UpdateApplyResult } from "./adapter"
import { createMobileAdapter } from "./adapters/mobile-adapter"
import { createCharacterPackAdapter } from "./adapters/character-pack-adapter"
import { createDesktopAdapter } from "./adapters/desktop-adapter"
import { createPluginAdapter } from "./adapters/plugin-adapter"
import {
  CRITICAL_DEFER_MS,
  DEFAULT_DEFER_MS,
  UpdateCoordinator,
  type CoordinatorDeps,
} from "./coordinator"

function candidate(overrides: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    channel: "stable",
    criticality: "routine",
    source: "catalog",
    provenance: "verified",
    ...overrides,
  }
}

function stubAdapter(
  overrides: Partial<UpdateAdapter> & {
    candidates?: UpdateCandidate[]
    result?: UpdateApplyResult
  } = {}
): UpdateAdapter & { applyCalls: UpdateCandidate[] } {
  const applyCalls: UpdateCandidate[] = []
  return {
    kind: overrides.kind ?? "desktop",
    executor: overrides.executor ?? "tauri",
    isSupported: overrides.isSupported ?? (() => true),
    check: overrides.check ?? (async () => overrides.candidates ?? []),
    restart: overrides.restart,
    apply:
      overrides.apply ??
      (async (c) => {
        applyCalls.push(c)
        return overrides.result ?? { state: "verified" }
      }),
    applyCalls,
  }
}

function makeCoordinator(
  adapters: UpdateAdapter[],
  overrides: Partial<CoordinatorDeps> = {}
): { coordinator: UpdateCoordinator; settings: UpdateCenterSettings } {
  const settings: UpdateCenterSettings = {
    ...DEFAULT_UPDATE_CENTER_SETTINGS,
    rolloutBucket: 0,
    snapshots: {},
  }
  const coordinator = new UpdateCoordinator({
    adapters,
    persistence: {
      read: () => settings,
      write: async (patch) => {
        Object.assign(settings, patch)
      },
      writeSnapshots: async (patches) => {
        settings.snapshots = { ...settings.snapshots, ...patches }
      },
    },
    fetchCatalog: async () => ({ status: "ok", entries: [] }),
    random: () => 0,
    appVersion: "1.0.0",
    ...overrides,
  })
  return { coordinator, settings }
}

describe("check", () => {
  it("projects an adapter candidate into an actionable row", async () => {
    const { coordinator } = makeCoordinator([stubAdapter({ candidates: [candidate()] })])
    const items = await coordinator.check({ manual: true })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: "desktop:app",
      state: "available",
      action: "install-in-app",
      externallyInstalled: false,
    })
  })

  it("labels a store-installed row as externally installed", async () => {
    const adapter = stubAdapter({
      kind: "mobile-ios",
      executor: "app-store",
      candidates: [candidate({ kind: "mobile-ios", executor: "app-store" })],
    })
    const { coordinator } = makeCoordinator([adapter])
    const [item] = await coordinator.check({ manual: true })
    expect(item.externallyInstalled).toBe(true)
    expect(item.action).toBe("open-store")
  })

  it("honors a per-candidate action override", async () => {
    const { coordinator } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ action: "open-store" })] }),
    ])
    const [item] = await coordinator.check({ manual: true })
    expect(item.action).toBe("open-store")
  })

  it("shares one sweep between concurrent callers", async () => {
    let checks = 0
    const adapter = stubAdapter({
      check: async () => {
        checks += 1
        await new Promise((r) => setTimeout(r, 5))
        return [candidate()]
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await Promise.all([coordinator.check(), coordinator.check(), coordinator.check()])
    expect(checks).toBe(1)
  })

  it("skips an adapter the host does not support", async () => {
    const adapter = stubAdapter({ isSupported: () => false, candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    expect(await coordinator.check({ manual: true })).toHaveLength(0)
  })

  it("holds a candidate outside the rollout window", async () => {
    const { coordinator, settings } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ rollout: { percentage: 1 } })] }),
    ])
    settings.rolloutBucket = 5000
    const [item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("current")
  })

  it("lets a manual check bypass the rollout percentage", async () => {
    const { coordinator, settings } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ rollout: { percentage: 1 } })] }),
    ])
    settings.rolloutBucket = 5000
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("available")
  })

  it("fails a catalog candidate whose provenance is not verified", async () => {
    const { coordinator } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ provenance: "revoked" })] }),
    ])
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("failed")
    expect(item.failure?.kind).toBe("revoked")
    expect(item.candidate).toBeNull()
  })

  it("records a classified failure and backs the asset off", async () => {
    const adapter = stubAdapter({
      check: async () => {
        throw new Error("network unreachable")
      },
    })
    const { coordinator, settings } = makeCoordinator([adapter])
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("failed")
    expect(item.failure?.kind).toBe("network")
    expect(settings.snapshots?.["desktop:desktop"]?.nextCheckAt).toBeGreaterThan(0)
  })

  it("returns a row to current when the adapter stops reporting it", async () => {
    let offer = true
    const adapter = stubAdapter({ check: async () => (offer ? [candidate()] : []) })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    offer = false
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("current")
    expect(item.candidate).toBeNull()
  })
})

describe("consent", () => {
  it("installs a routine desktop package without a separate confirmation", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("desktop:app", { consented: true })
    expect(item.state).toBe("verified")
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it("stops at awaiting-consent when permissions widen", async () => {
    const adapter = stubAdapter({
      kind: "plugin",
      executor: "plugin-runtime",
      candidates: [
        candidate({ kind: "plugin", executor: "plugin-runtime", permissionsExpanded: true }),
      ],
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("plugin:app", { consented: false })
    expect(item.state).toBe("awaiting-consent")
    expect(item.action).toBe("review-permissions")
    expect(adapter.applyCalls).toHaveLength(0)
  })

  it("always asks before a skill content change", async () => {
    const adapter = stubAdapter({
      kind: "skill",
      executor: "skill-runtime",
      candidates: [candidate({ kind: "skill", executor: "skill-runtime" })],
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    expect((await coordinator.apply("skill:app", { consented: false })).state).toBe(
      "awaiting-consent"
    )
  })

  it("always asks before a CLI update", async () => {
    const adapter = stubAdapter({
      kind: "cli",
      executor: "package-manager",
      candidates: [candidate({ kind: "cli", executor: "package-manager" })],
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    expect((await coordinator.apply("cli:app", { consented: false })).state).toBe(
      "awaiting-consent"
    )
  })

  it("names a host's row for the host, asks first, and rests while the host installs", async () => {
    const host = (assetId: string, displayName: string) =>
      candidate({ assetId, displayName, kind: "host-server", executor: "cognia-host" })
    const adapter = stubAdapter({
      kind: "host-server",
      executor: "cognia-host",
      candidates: [host("mini", "Mac mini"), host("nas", "NAS")],
      result: { state: "awaiting-host" },
    })
    const { coordinator } = makeCoordinator([adapter])
    const items = await coordinator.check({ manual: true })
    expect(items.map((item) => [item.key, item.displayName, item.action])).toEqual([
      ["host-server:mini", "Mac mini", "update-host"],
      ["host-server:nas", "NAS", "update-host"],
    ])
    // Another device cannot install a host; it asks the host, after a confirm.
    expect((await coordinator.apply("host-server:mini", { consented: false })).state).toBe(
      "awaiting-consent"
    )
    expect((await coordinator.apply("host-server:mini", { consented: true })).state).toBe(
      "awaiting-host"
    )
    expect(adapter.applyCalls.map((c) => c.assetId)).toEqual(["mini"])
  })

  it("background-downloads only the first-party desktop package", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator, settings } = makeCoordinator([adapter])
    settings.backgroundDownloadDesktop = true
    await coordinator.check({ manual: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(adapter.applyCalls).toHaveLength(1)
  })

  it("does not background-download a version that widens permissions", async () => {
    const adapter = stubAdapter({ candidates: [candidate({ permissionsExpanded: true })] })
    const { coordinator, settings } = makeCoordinator([adapter])
    settings.backgroundDownloadDesktop = true
    await coordinator.check({ manual: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(adapter.applyCalls).toHaveLength(0)
  })
})

describe("skip and defer", () => {
  it("hides a skipped version on the next check", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    expect(await coordinator.skip("desktop:app")).toBe(true)
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("current")
  })

  it("refuses to skip a critical update", async () => {
    const { coordinator } = makeCoordinator([
      stubAdapter({ candidates: [candidate({ criticality: "critical" })] }),
    ])
    await coordinator.check({ manual: true })
    expect(await coordinator.skip("desktop:app")).toBe(false)
    expect(coordinator.getItem("desktop:app")?.state).toBe("available")
  })

  it("still offers a critical update that was previously skipped at another level", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await coordinator.skip("desktop:app")
    adapter.check = async () => [candidate({ criticality: "critical" })]
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("available")
  })

  it("brings a critical update back sooner than a routine one", async () => {
    let now = 1_000_000
    const adapter = stubAdapter({ candidates: [candidate({ criticality: "critical" })] })
    const { coordinator, settings } = makeCoordinator([adapter], { now: () => now })
    await coordinator.check({ manual: true })
    await coordinator.defer("desktop:app")
    expect(settings.snapshots?.["desktop:app"]?.deferredUntil).toBe(now + CRITICAL_DEFER_MS)

    const routine = stubAdapter({ candidates: [candidate()] })
    const second = makeCoordinator([routine], { now: () => now })
    await second.coordinator.check({ manual: true })
    await second.coordinator.defer("desktop:app")
    expect(second.settings.snapshots?.["desktop:app"]?.deferredUntil).toBe(now + DEFAULT_DEFER_MS)
    now += 1
  })

  it("keeps a deferred row hidden until its window passes", async () => {
    let now = 1_000_000
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter], { now: () => now })
    await coordinator.check({ manual: true })
    await coordinator.defer("desktop:app")
    let [item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("deferred")
    now += DEFAULT_DEFER_MS + 1
    ;[item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("available")
  })

  it("shows a deferred row again on a manual check", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await coordinator.defer("desktop:app")
    const [item] = await coordinator.check({ manual: true })
    expect(item.state).toBe("available")
  })

  it("clears a hold on request", async () => {
    const adapter = stubAdapter({ candidates: [candidate()] })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await coordinator.skip("desktop:app")
    await coordinator.clearHold("desktop:app")
    const [item] = await coordinator.check({ manual: false })
    expect(item.state).toBe("available")
  })
})

describe("attempt persistence and restore", () => {
  it("writes the attempt record before any bytes move", async () => {
    const writes: string[] = []
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        writes.push("install")
        return { state: "awaiting-restart" }
      },
    })
    const { coordinator, settings } = makeCoordinator([adapter], {
      persistence: {
        read: () => ({ ...DEFAULT_UPDATE_CENTER_SETTINGS, rolloutBucket: 0, snapshots: {} }),
        write: async () => {
          writes.push("persist")
        },
        writeSnapshots: async () => {
          writes.push("persist")
        },
      },
    })
    void settings
    await coordinator.check({ manual: true })
    writes.length = 0
    await coordinator.apply("desktop:app", { consented: true })
    expect(writes[0]).toBe("persist")
    expect(writes).toContain("install")
    expect(writes.indexOf("persist")).toBeLessThan(writes.indexOf("install"))
  })

  it("verifies an interrupted desktop install against the running version", async () => {
    const snapshots = {
      "desktop:app": {
        assetId: "app",
        kind: "desktop" as const,
        state: "installing" as const,
        attemptId: "att-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        startedAt: 1,
      },
    }
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, snapshots }
    const coordinator = new UpdateCoordinator({
      adapters: [stubAdapter()],
      persistence: { read: () => settings, write: async () => {}, writeSnapshots: async () => {} },
      fetchCatalog: async () => ({ status: "unconfigured" }),
      appVersion: "1.1.0",
    })
    await coordinator.restore()
    expect(coordinator.getItem("desktop:app")?.state).toBe("verified")
  })

  it("reports an interrupted install as failed when the old version still runs", async () => {
    const snapshots = {
      "desktop:app": {
        assetId: "app",
        kind: "desktop" as const,
        state: "installing" as const,
        attemptId: "att-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
      },
    }
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, snapshots }
    const coordinator = new UpdateCoordinator({
      adapters: [stubAdapter()],
      persistence: { read: () => settings, write: async () => {}, writeSnapshots: async () => {} },
      fetchCatalog: async () => ({ status: "unconfigured" }),
      appVersion: "1.0.0",
    })
    await coordinator.restore()
    const item = coordinator.getItem("desktop:app")
    expect(item?.state).toBe("failed")
    expect(item?.failure?.code).toBe("install_interrupted")
  })

  it("does not reinterpret a store handoff as an interrupted install", async () => {
    const snapshots = {
      "mobile-ios:app": {
        assetId: "app",
        kind: "mobile-ios" as const,
        state: "awaiting-store" as const,
        targetVersion: "2.0.0",
      },
    }
    const settings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, snapshots }
    const coordinator = new UpdateCoordinator({
      adapters: [stubAdapter({ kind: "mobile-ios", executor: "app-store" })],
      persistence: { read: () => settings, write: async () => {}, writeSnapshots: async () => {} },
      fetchCatalog: async () => ({ status: "unconfigured" }),
      appVersion: "1.0.0",
    })
    await coordinator.restore()
    expect(coordinator.getItem("mobile-ios:app")?.state).toBe("awaiting-store")
  })
})

describe("telemetry", () => {
  it("never carries release notes or URLs", async () => {
    const events: Record<string, unknown>[] = []
    const adapter = stubAdapter({
      candidates: [candidate({ releaseNotes: "secret", externalUrl: "https://x.test" })],
    })
    const { coordinator } = makeCoordinator([adapter], {
      telemetry: (event) => events.push(event as unknown as Record<string, unknown>),
    })
    await coordinator.check({ manual: true })
    await coordinator.apply("desktop:app", { consented: true })
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("secret")
      expect(JSON.stringify(event)).not.toContain("x.test")
    }
  })

  it("reports a store handoff as handed-off, not as success", async () => {
    const events: { outcome?: string }[] = []
    const adapter = stubAdapter({
      kind: "mobile-android",
      executor: "google-play",
      candidates: [candidate({ kind: "mobile-android", executor: "google-play" })],
      result: { state: "awaiting-store" },
    })
    const { coordinator } = makeCoordinator([adapter], {
      telemetry: (event) => events.push(event),
    })
    await coordinator.check({ manual: true })
    await coordinator.apply("mobile-android:app", { consented: true })
    expect(events.map((e) => e.outcome)).toContain("handed-off")
  })
})

describe("failures during apply", () => {
  it("classifies a thrown install error and keeps the row recoverable", async () => {
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        throw new Error("no space left on device")
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("desktop:app", { consented: true })
    expect(item.state).toBe("failed")
    expect(item.failure?.kind).toBe("disk")
  })

  it("reports a cancellation as cancelled, not as a failure", async () => {
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        throw new Error("The operation was aborted")
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const item = await coordinator.apply("desktop:app", { consented: true })
    expect(item.state).toBe("cancelled")
  })

  it("shares one apply between concurrent callers", async () => {
    let calls = 0
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return { state: "verified" }
      },
    })
    const { coordinator } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    await Promise.all([
      coordinator.apply("desktop:app", { consented: true }),
      coordinator.apply("desktop:app", { consented: true }),
    ])
    expect(calls).toBe(1)
  })
})

describe("attempt state integrity (U05, L01)", () => {
  it("returns a real character-pack diff handoff to available (L01)", async () => {
    const openDiff = jest.fn(async () => {})
    const { coordinator } = makeCoordinator([
      createCharacterPackAdapter({
        listPacks: async () => [
          {
            characterId: "ada",
            displayName: "Ada",
            pluginId: "p1",
            appliedVersion: "1.0.0",
            availableVersion: "2.0.0",
          },
        ],
        openDiff,
      }),
    ])
    await coordinator.check({ manual: true })
    expect(await coordinator.apply("character-pack:ada", { consented: true })).toMatchObject({
      state: "available",
      currentVersion: "1.0.0",
      candidate: { targetVersion: "2.0.0" },
    })
    expect(openDiff).toHaveBeenCalledWith("ada")
  })
  it.each(["awaiting-store", "current", "available"] as const)(
    "accepts an installing result of %s without claiming an uninstalled version",
    async (state) => {
      const offered = candidate()
      const onError = jest.fn()
      const { coordinator, settings } = makeCoordinator(
        [stubAdapter({ candidates: [offered], result: { state } })],
        { onError }
      )
      await coordinator.check({ manual: true })
      const item = await coordinator.apply("desktop:app", { consented: true })
      expect(item).toMatchObject({
        state,
        currentVersion: "1.0.0",
        candidate: state === "current" ? null : offered,
      })
      if (state === "current") {
        expect(item.action).toBeNull()
        expect(settings.snapshots?.[item.key].attemptId).toBeUndefined()
      }
      expect(settings.snapshots?.[item.key].state).toBe(state)
      expect(onError).not.toHaveBeenCalled()
    }
  )

  it.each(["awaiting-store", "current", "awaiting-restart"] as const)(
    "accepts the desktop result %s from downloading",
    async (state) => {
      const { coordinator } = makeCoordinator([
        stubAdapter({ candidates: [candidate()], result: { state } }),
      ])
      await coordinator.check({ manual: true })
      expect(
        (await coordinator.apply("desktop:app", { consented: true, downloadOnly: true })).state
      ).toBe(state)
    }
  )

  it.each([false, true])("retries a cancelled attempt (downloadOnly=%s)", async (downloadOnly) => {
    const apply = jest
      .fn<Promise<UpdateApplyResult>, []>()
      .mockResolvedValueOnce({ state: "cancelled" })
      .mockResolvedValueOnce({ state: "awaiting-restart" })
    const { coordinator } = makeCoordinator([stubAdapter({ candidates: [candidate()], apply })])
    await coordinator.check({ manual: true })
    await coordinator.apply("desktop:app", { consented: true })
    expect((await coordinator.apply("desktop:app", { consented: true, downloadOnly })).state).toBe(
      "awaiting-restart"
    )
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it("refuses another install when a retained candidate is awaiting restart", async () => {
    const adapter = stubAdapter({
      candidates: [candidate()],
      result: { state: "awaiting-restart" },
    })
    const onError = jest.fn()
    const { coordinator } = makeCoordinator([adapter], { onError })
    await coordinator.check({ manual: true })
    await coordinator.apply("desktop:app", { consented: true })
    await coordinator.apply("desktop:app", { consented: true })
    expect(adapter.applyCalls).toHaveLength(1)
    expect(coordinator.getItem("desktop:app")?.failure?.code).toBe("relaunch")
    expect(onError).toHaveBeenCalledWith("relaunch", expect.any(Error))
  })

  it("turns an illegal adapter result into a persisted recoverable failure", async () => {
    const onError = jest.fn()
    const { coordinator, settings } = makeCoordinator(
      [stubAdapter({ candidates: [candidate()], result: { state: "checking" } })],
      { onError }
    )
    await coordinator.check({ manual: true })
    expect(await coordinator.apply("desktop:app", { consented: true })).toMatchObject({
      state: "failed",
      failure: { kind: "unknown", code: "illegal_result_state" },
    })
    expect(settings.snapshots?.["desktop:app"]).toMatchObject({
      state: "failed",
      failure: { code: "illegal_result_state" },
    })
    expect(onError).toHaveBeenCalledWith("transition", expect.any(Error))
  })
})

describe("desktop download and restart policy (U01, U06)", () => {
  it("keeps sweep due-ness while preserving a restart row (WP-A1)", async () => {
    let now = 0
    const check = jest.fn(async () => [candidate()])
    const { coordinator } = makeCoordinator(
      [stubAdapter({ check, result: { state: "awaiting-restart" } })],
      { now: () => now, checkIntervalMs: () => 1000 }
    )
    await coordinator.check()
    await coordinator.apply("desktop:app", { consented: true })
    now = 1000
    await coordinator.check()
    expect(coordinator.getItem("desktop:app")?.state).toBe("awaiting-restart")
    expect(coordinator.isSweepDue()).toBe(false)
    await coordinator.check()
    expect(check).toHaveBeenCalledTimes(2)
    now = 2000
    check.mockRejectedValueOnce(new Error("network offline"))
    await coordinator.check()
    expect(coordinator.getItem("desktop:app")?.state).toBe("awaiting-restart")
    expect(coordinator.getItem("desktop:app")?.failure).toBeUndefined()
    expect(coordinator.isSweepDue()).toBe(false)
  })
  it.each(["windows", "linux"] as const)(
    "background-downloads %s then installs the same version on click",
    async (os) => {
      const download = jest.fn(async () => "downloaded" as const)
      const install = jest.fn(async () => "installed" as const)
      const adapter = createDesktopAdapter({
        isTauri: () => true,
        osFamily: () => os,
        appVersion: "1.0.0",
        checkForUpdate: async () => ({ version: "2.0.0" }),
        downloadUpdate: download,
        downloadAndInstallUpdate: install,
      })
      const { coordinator, settings } = makeCoordinator([adapter])
      settings.backgroundDownloadDesktop = true
      await coordinator.check()
      await coordinator.apply("desktop:app", { consented: true, downloadOnly: true })
      expect(coordinator.getItem("desktop:app")).toMatchObject({
        state: "awaiting-consent",
        action: "install-in-app",
        candidate: { targetVersion: "2.0.0" },
      })
      expect(download).toHaveBeenCalledWith(expect.any(Function), { expectedVersion: "2.0.0" })
      expect(install).not.toHaveBeenCalled()
      await coordinator.apply("desktop:app", { consented: true })
      expect(install).toHaveBeenCalledWith(expect.any(Function), { expectedVersion: "2.0.0" })
    }
  )

  it("never starts a macOS handoff or an external executor during a background sweep", async () => {
    const open = jest.fn()
    const mac = createDesktopAdapter({
      isTauri: () => true,
      osFamily: () => "macos",
      appVersion: "1.0.0",
      checkForUpdate: async () => ({ version: "2.0.0" }),
      openExternal: open,
    })
    const external = stubAdapter({
      candidates: [candidate({ assetId: "store", executor: "app-store" })],
    })
    const { coordinator, settings } = makeCoordinator([mac, external])
    settings.backgroundDownloadDesktop = true
    await coordinator.check()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(open).not.toHaveBeenCalled()
    expect(external.applyCalls).toHaveLength(0)
    expect(coordinator.getItem("desktop:app")?.state).toBe("available")
  })

  it.each(["desktop", "plugin"] as const)(
    "restarts %s through the desktop adapter and retains relaunch failures",
    async (kind) => {
      const restart = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error("restart denied"))
        .mockResolvedValue(undefined)
      const desktop = stubAdapter({
        candidates: kind === "desktop" ? [candidate()] : [],
        result: { state: "awaiting-restart" },
        restart,
      })
      const plugin = createPluginAdapter({
        checkForUpdates: async () => [
          { pluginId: "tool", currentVersion: "1.0.0", latestVersion: "2.0.0" },
        ],
        update: async () => ({ success: true, requiresRestart: true }),
      })
      const { coordinator, settings } = makeCoordinator([
        desktop,
        ...(kind === "plugin" ? [plugin] : []),
      ])
      const key = kind === "desktop" ? "desktop:app" : "plugin:tool"
      await coordinator.check({ manual: true })
      await coordinator.apply(key, { consented: true })
      expect(coordinator.getItem(key)).toMatchObject({
        state: "awaiting-restart",
        action: "restart-desktop",
      })
      await coordinator.check({ manual: true })
      expect(coordinator.getItem(key)).toMatchObject({
        state: "awaiting-restart",
        action: "restart-desktop",
      })
      await coordinator.apply(key, { consented: true })
      expect(settings.snapshots?.[key].failure?.code).toBe("relaunch")
      expect(restart).toHaveBeenCalledTimes(1)
      await coordinator.apply(key, { consented: true })
      expect(restart).toHaveBeenCalledTimes(2)
      expect(coordinator.getItem(key)?.failure).toBeUndefined()
      expect(desktop.applyCalls).toHaveLength(kind === "desktop" ? 1 : 0)
    }
  )
})

describe("checks during apply (U07)", () => {
  it.each(["candidate", "revoked", "empty", "error"] as const)(
    "keeps the active attempt intact when a check returns %s",
    async (answer) => {
      const offered = candidate()
      let finish!: (result: UpdateApplyResult) => void
      const apply = jest.fn(
        () =>
          new Promise<UpdateApplyResult>((resolve) => {
            finish = resolve
          })
      )
      const check = jest.fn<Promise<UpdateCandidate[]>, []>().mockResolvedValueOnce([offered])
      if (answer === "error") check.mockRejectedValueOnce(new Error("network offline"))
      else
        check.mockResolvedValueOnce(
          answer === "empty"
            ? []
            : [
                candidate({
                  targetVersion: "3.0.0",
                  action: "open-store",
                  externalUrl: "https://changed.test",
                  provenance: answer === "revoked" ? "revoked" : "verified",
                }),
              ]
        )
      const { coordinator, settings } = makeCoordinator([stubAdapter({ check, apply })])
      await coordinator.check({ manual: true })
      const installing = coordinator.apply("desktop:app", { consented: true })
      // The sweep also races the persistence await before adapter.apply starts.
      await coordinator.check({ manual: true })
      expect(coordinator.getItem("desktop:app")).toMatchObject({
        state: "installing",
        candidate: offered,
        action: "install-in-app",
        currentVersion: "1.0.0",
      })
      expect(coordinator.getItem("desktop:app")?.failure).toBeUndefined()
      expect(coordinator.getItem("desktop:app")?.externalUrl).toBeUndefined()
      expect(settings.snapshots?.["desktop:app"].targetVersion).toBe("1.1.0")
      finish({ state: "verified" })
      expect(await installing).toMatchObject({ state: "verified", currentVersion: "1.1.0" })
    }
  )
})

describe("catalog truth and automatic scheduling (U11, U12)", () => {
  const mobile = () =>
    createMobileAdapter("mobile-ios", {
      isNativeMobile: () => true,
      osFamily: () => "ios",
      appVersion: "1.0.0",
    })
  const entries = [
    {
      assetId: "app",
      kind: "mobile-ios" as const,
      executor: "app-store" as const,
      version: "2.0.0",
      channel: "stable" as const,
      criticality: "routine" as const,
      releasedAt: "2026-01-01T00:00:00Z",
    },
  ]

  it("starts Retry-After at the failed answer, including time spent fetching", async () => {
    let now = 1000
    const { coordinator, settings } = makeCoordinator([mobile()], {
      now: () => now,
      fetchCatalog: async () => {
        now += 30_000
        return {
          status: "unavailable",
          error: new Error("catalog fetch http 429"),
          retryAfterMs: 120_000,
        }
      },
    })
    await coordinator.check()
    expect(settings.snapshots?.["mobile-ios:mobile-ios"].nextCheckAt).toBe(151_000)
  })

  it("retains a catalog candidate on outage and honors Retry-After until a manual check", async () => {
    let now = 1000
    const fetchCatalog = jest
      .fn()
      .mockResolvedValueOnce({ status: "ok", entries })
      .mockResolvedValue({
        status: "unavailable",
        error: new Error("catalog fetch http 503"),
        retryAfterMs: 120_000,
      })
    const { coordinator, settings } = makeCoordinator([mobile()], { now: () => now, fetchCatalog })
    await coordinator.check({ manual: true })
    const offered = coordinator.getItem("mobile-ios:app")?.candidate
    await coordinator.check({ manual: true })
    expect(coordinator.getItem("mobile-ios:app")).toMatchObject({
      state: "failed",
      candidate: offered,
      action: "open-store",
      failure: { kind: "network" },
    })
    expect(settings.snapshots?.["mobile-ios:app"].nextCheckAt).toBe(now + 120_000)
    now += 60_000
    expect(coordinator.isSweepDue()).toBe(false)
    await coordinator.check()
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
    await coordinator.check({ manual: true })
    expect(fetchCatalog).toHaveBeenCalledTimes(3)
    now += 120_000
    await coordinator.check()
    expect(fetchCatalog).toHaveBeenCalledTimes(4)
  })

  it("reports a missing trust root separately from an authoritative empty catalog", async () => {
    const fetchCatalog = jest.fn().mockResolvedValue({ status: "unconfigured" })
    const { coordinator } = makeCoordinator([mobile()], { fetchCatalog })
    expect((await coordinator.check({ manual: true }))[0]).toMatchObject({
      state: "failed",
      failure: { kind: "unsupported", code: "catalog_unconfigured" },
    })
    fetchCatalog.mockResolvedValue({ status: "ok", entries: [] })
    expect((await coordinator.check({ manual: true }))[0]).toMatchObject({ state: "current" })
    expect(coordinator.getItems()[0].failure).toBeUndefined()
  })

  it("runs only due kinds, including discovery for a kind with no rows", async () => {
    let now = 0
    let supported = false
    const check = jest.fn(async () => [candidate()])
    const discover = jest.fn(async () => [])
    const { coordinator, settings } = makeCoordinator(
      [
        stubAdapter({ check }),
        stubAdapter({
          kind: "cli",
          executor: "package-manager",
          isSupported: () => supported,
          check: discover,
        }),
      ],
      { now: () => now, checkIntervalMs: () => 1000 }
    )
    await coordinator.check()
    expect(settings.snapshots?.["desktop:app"].nextCheckAt).toBe(1000)
    supported = true
    expect(coordinator.isSweepDue()).toBe(true)
    await coordinator.check()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(1)
    expect(coordinator.isSweepDue()).toBe(false)
    now = 1000
    await coordinator.check()
    expect(check).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it("schedules an authoritative empty answer at the normal interval", async () => {
    const check = jest
      .fn<Promise<UpdateCandidate[]>, []>()
      .mockResolvedValueOnce([candidate()])
      .mockResolvedValue([])
    const { coordinator, settings } = makeCoordinator([stubAdapter({ check })], {
      now: () => 100,
      checkIntervalMs: () => 1000,
    })
    await coordinator.check({ manual: true })
    await coordinator.check({ manual: true })
    expect(settings.snapshots?.["desktop:app"]).toMatchObject({
      nextCheckAt: 1100,
      failure: undefined,
    })
    await coordinator.check()
    expect(check).toHaveBeenCalledTimes(2)
  })
})

describe("disposed account scope (U10)", () => {
  it("aborts a pending check and discards its late private assets without writes or notifications", async () => {
    let finish!: (value: UpdateCandidate[]) => void
    let signal: AbortSignal | undefined
    const adapter = stubAdapter({
      check: (context) => {
        signal = context.signal
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const write = jest.fn(async () => {})
    const writeSnapshots = jest.fn(async () => {})
    const { coordinator } = makeCoordinator([adapter], {
      persistence: {
        read: () => ({ ...DEFAULT_UPDATE_CENTER_SETTINGS, rolloutBucket: 0 }),
        write,
        writeSnapshots,
      },
    })
    const pending = coordinator.check()
    await Promise.resolve()
    await Promise.resolve()
    const listener = jest.fn()
    coordinator.subscribe(listener)
    coordinator.dispose()
    finish([candidate({ assetId: "private-a" })])
    await pending
    expect(signal?.aborted).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(writeSnapshots).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(coordinator.getItems()).toEqual([])
  })

  it("aborts an apply and drops late progress/results after disposal", async () => {
    let finish!: (value: UpdateApplyResult) => void
    let applyContext: Parameters<UpdateAdapter["apply"]>[1] | undefined
    const adapter = stubAdapter({
      candidates: [candidate()],
      apply: (_candidate, context) => {
        applyContext = context
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    const { coordinator, settings } = makeCoordinator([adapter])
    await coordinator.check({ manual: true })
    const pending = coordinator.apply("desktop:app", { consented: true })
    await Promise.resolve()
    await Promise.resolve()
    const saved = JSON.stringify(settings)
    const onProgress = jest.fn()
    coordinator.subscribe(onProgress)
    coordinator.dispose()
    applyContext?.onProgress?.(10, 100)
    finish({ state: "verified" })
    await pending
    expect(applyContext?.signal?.aborted).toBe(true)
    expect(JSON.stringify(settings)).toBe(saved)
    expect(onProgress).not.toHaveBeenCalled()
  })
})
