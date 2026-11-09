const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkMock = jest.fn()
const invokeMock = jest.fn((command: string, args: unknown) => checkMock(command, args))
jest.mock("@tauri-apps/api/core", () => ({
  ...jest.requireActual("@tauri-apps/api/core"),
  // Bypass the global core mapper's no-op Resource.close for the real Update test.
  Resource: jest.requireActual("../../node_modules/@tauri-apps/api/core.cjs").Resource,
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}))
jest.mock(
  "@tauri-apps/plugin-updater",
  () => ({
    check: () => {
      throw new Error("use desktop_update_check")
    },
    Update: jest.fn((metadata: unknown) => metadata),
  }),
  {
    virtual: true,
  }
)

const settingsState = {
  loaded: true,
  save: jest.fn(async (_patch: unknown) => {}),
  settings: {
    updateCenter: { channel: "stable", rolloutBucket: 4321 },
    updates: {
      autoCheck: true,
      checkIntervalMinutes: 360,
      autoDownload: false,
      relaunchAfterInstall: true,
      requestTimeoutSeconds: 30,
      useProxy: true,
    },
    networkProxy: {
      mode: "off",
      protocol: "http",
      host: "",
      port: 0,
      bypass: ["localhost", "127.0.0.1", "::1"],
      proxyWebsockets: true,
      ipLookupEnabled: true,
    },
  },
}
const saveSettingsMock = jest.fn(
  async (input: unknown, _options?: unknown): Promise<unknown> => input
)
jest.mock("@/lib/db/settings", () => ({
  saveSettings: (input: unknown, options?: unknown) => saveSettingsMock(input, options),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => settingsState,
    setState: (patch: Partial<typeof settingsState>) => Object.assign(settingsState, patch),
  },
}))

const relaunchMock = jest.fn(async () => {})
jest.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }), {
  virtual: true,
})

const saveWindowStateMock = jest.fn(async (_flags?: number) => {})
jest.mock(
  "@tauri-apps/plugin-window-state",
  () => ({
    StateFlags: { SIZE: 1, POSITION: 2, MAXIMIZED: 4, VISIBLE: 8, DECORATIONS: 16, FULLSCREEN: 32 },
    saveWindowState: (flags: number) => saveWindowStateMock(flags),
  }),
  { virtual: true }
)

const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { app: { warn: (...args: unknown[]) => warnMock(...args) } },
}))

type UpdateHandleFixture = {
  version: string
  body?: string
  date?: string
  download: jest.Mock<Promise<void>, []>
  install: jest.Mock<Promise<void>, []>
  close?: jest.Mock<Promise<void>, []>
}

import { DEFAULT_UPDATE_CENTER_SETTINGS } from "@cognia/agent-config-types"
import { Update } from "@tauri-apps/plugin-updater"
import { UpdateCoordinator } from "@/lib/updates/coordinator"
import { createDesktopAdapter } from "@/lib/updates/adapters/desktop-adapter"

import {
  checkForUpdate,
  downloadAndInstallUpdate,
  downloadUpdate,
  getInstalledVersionAwaitingRestart,
  getUpdateCheckOptions,
  installUpdate,
  isUpdateErrorPhase,
  relaunchAfterUpdate,
  resolveUpdateSettings,
  subscribeInstalledVersionAwaitingRestart,
  __resetPendingUpdate,
} from "./updater"

beforeEach(() => {
  jest.clearAllMocks()
  checkMock.mockReset()
  invokeMock.mockImplementation((command: string, args: unknown) => checkMock(command, args))
  isTauriMock.mockReturnValue(true)
  settingsState.settings.updates = {
    autoCheck: true,
    checkIntervalMinutes: 360,
    autoDownload: false,
    relaunchAfterInstall: true,
    requestTimeoutSeconds: 30,
    useProxy: true,
  }
  settingsState.loaded = true
  settingsState.settings.updateCenter = { channel: "stable", rolloutBucket: 4321 }
  settingsState.settings.networkProxy = {
    mode: "off",
    protocol: "http",
    host: "",
    port: 0,
    bypass: ["localhost", "127.0.0.1", "::1"],
    proxyWebsockets: true,
    ipLookupEnabled: true,
  }
  __resetPendingUpdate()
})

async function waitForMockCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 10 && mock.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  expect(mock).toHaveBeenCalled()
}

function handle(version = "2.0.0"): UpdateHandleFixture {
  return {
    version,
    download: jest.fn(async () => {}),
    install: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  }
}

describe("offered version and resource ownership (U02, U08)", () => {
  it.each(["install", "combined"] as const)(
    "joins a running installer before reporting %s success",
    async (operation) => {
      const update = handle()
      let fail!: (error: Error) => void
      update.install.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject
          })
      )
      checkMock.mockResolvedValueOnce(update)
      const options = { expectedVersion: "2.0.0", relaunch: false }
      const first = installUpdate(options).catch((error: unknown) => error)
      await waitForMockCall(update.install)
      const second =
        operation === "install"
          ? installUpdate(options)
          : downloadAndInstallUpdate(undefined, options)
      let reportedSuccess = false
      const secondOutcome = second.then(
        (result) => {
          reportedSuccess = true
          return result
        },
        (error: unknown) => error
      )
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
      const reportedBeforeCompletion = reportedSuccess
      fail(new Error("disk write failed"))
      const [firstError, secondError] = await Promise.all([first, secondOutcome])
      expect(reportedBeforeCompletion).toBe(false)
      expect(firstError).toMatchObject({ phase: "install" })
      expect(secondError).toBe(firstError)
      expect(getInstalledVersionAwaitingRestart()).toBeNull()
    }
  )
  it.each(["windows", "linux"] as const)(
    "downloads background bytes on %s and installs that native handle only after a click (U01)",
    async (os) => {
      settingsState.settings.updates.relaunchAfterInstall = false
      const update = handle()
      const sameVersion = handle()
      checkMock.mockResolvedValueOnce(update).mockResolvedValueOnce(sameVersion)
      const coordinator = new UpdateCoordinator({
        adapters: [createDesktopAdapter({ osFamily: () => os, appVersion: "1.0.0" })],
        persistence: {
          read: () => ({
            ...DEFAULT_UPDATE_CENTER_SETTINGS,
            rolloutBucket: settingsState.settings.updateCenter.rolloutBucket,
            backgroundDownloadDesktop: true,
          }),
          write: async () => {},
          writeSnapshots: async () => {},
        },
        fetchCatalog: async () => ({ status: "unconfigured" }),
      })
      await coordinator.check()
      // Join the background operation already started by the sweep.
      await coordinator.apply("desktop:app", { consented: true, downloadOnly: true })
      expect(update.download).toHaveBeenCalledTimes(1)
      expect(update.install).not.toHaveBeenCalled()
      expect(relaunchMock).not.toHaveBeenCalled()
      expect(coordinator.getItem("desktop:app")?.state).toBe("awaiting-consent")
      await checkForUpdate()
      await coordinator.apply("desktop:app", { consented: true })
      expect(update.download).toHaveBeenCalledTimes(1)
      expect(update.install).toHaveBeenCalledTimes(1)
      expect(sameVersion.download).not.toHaveBeenCalled()
      expect(sameVersion.install).not.toHaveBeenCalled()
      expect(getInstalledVersionAwaitingRestart()).toBe("2.0.0")
    }
  )
  it.each(["download", "install", "combined"] as const)(
    "refuses a changed native version during %s",
    async (operation) => {
      const cached = handle("3.0.0")
      const fresh = handle("4.0.0")
      checkMock.mockResolvedValueOnce(cached).mockResolvedValueOnce(fresh)
      await checkForUpdate()
      const options = { expectedVersion: "2.0.0", relaunch: false }
      const result =
        operation === "download"
          ? await downloadUpdate(undefined, options)
          : operation === "install"
            ? await installUpdate(options)
            : await downloadAndInstallUpdate(undefined, options)
      expect(result).toBe("versionMismatch")
      expect(cached.close).toHaveBeenCalledTimes(1)
      expect(checkMock).toHaveBeenCalledTimes(2)
      for (const update of [cached, fresh]) {
        expect(update.download).not.toHaveBeenCalled()
        expect(update.install).not.toHaveBeenCalled()
      }
      expect(relaunchMock).not.toHaveBeenCalled()
      expect(getInstalledVersionAwaitingRestart()).toBeNull()
    }
  )

  it("rechecks a mismatched cache and installs only the offered version", async () => {
    const cached = handle("3.0.0")
    const offered = handle()
    checkMock.mockResolvedValueOnce(cached).mockResolvedValueOnce(offered)
    await checkForUpdate()
    expect(
      await downloadAndInstallUpdate(undefined, {
        expectedVersion: "2.0.0",
        relaunch: false,
      })
    ).toBe("installed")
    expect(cached.close).toHaveBeenCalledTimes(1)
    expect(cached.download).not.toHaveBeenCalled()
    expect(offered.download).toHaveBeenCalledTimes(1)
    expect(offered.install).toHaveBeenCalledTimes(1)
  })

  it.each(["2.0.0", "3.0.0"])(
    "waits for a preceding recheck without installing its undownloaded %s handle (U08)",
    async (version) => {
      const downloaded = handle()
      const replacement = handle(version)
      replacement.install.mockRejectedValue(new Error("called before download"))
      checkMock.mockResolvedValueOnce(downloaded)
      await downloadUpdate()
      let finish!: (value: UpdateHandleFixture) => void
      checkMock.mockReturnValueOnce(
        new Promise<UpdateHandleFixture>((resolve) => {
          finish = resolve
        })
      )
      const checking = checkForUpdate()
      const installing = installUpdate({ relaunch: false, expectedVersion: "2.0.0" })
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
      const startedBeforeCheck = downloaded.install.mock.calls.length
      finish(replacement)
      expect(await checking).toMatchObject({ version: "2.0.0" })
      expect(await installing).toBe("installed")
      expect(startedBeforeCheck).toBe(0)
      expect(downloaded.install).toHaveBeenCalledTimes(1)
      expect(replacement.install).not.toHaveBeenCalled()
      expect(replacement.download).not.toHaveBeenCalled()
      expect(replacement.close).toHaveBeenCalledTimes(1)
    }
  )

  it("keeps an already downloaded handle when a same-version check resolves (U08)", async () => {
    const downloaded = handle()
    const replacement = handle()
    checkMock.mockResolvedValueOnce(downloaded).mockResolvedValueOnce(replacement)
    await downloadUpdate()
    await checkForUpdate()
    expect(downloaded.close).not.toHaveBeenCalled()
    expect(replacement.close).toHaveBeenCalledTimes(1)
    expect(await installUpdate({ relaunch: false, expectedVersion: "2.0.0" })).toBe("installed")
    expect(downloaded.download).toHaveBeenCalledTimes(1)
    expect(downloaded.install).toHaveBeenCalledTimes(1)
    expect(replacement.download).not.toHaveBeenCalled()
  })

  it("keeps the selected resource when an earlier check resolves during a download request (U08)", async () => {
    const selected = handle()
    const replacement = handle("3.0.0")
    checkMock.mockResolvedValueOnce(selected)
    await checkForUpdate()
    let finish!: (value: UpdateHandleFixture) => void
    checkMock.mockReturnValueOnce(
      new Promise<UpdateHandleFixture>((resolve) => {
        finish = resolve
      })
    )
    const checking = checkForUpdate()
    const downloading = downloadUpdate(undefined, { expectedVersion: "2.0.0" })
    finish(replacement)
    expect(await checking).toMatchObject({ version: "2.0.0" })
    expect(await downloading).toBe("downloaded")
    expect(selected.close).not.toHaveBeenCalled()
    expect(selected.download).toHaveBeenCalledTimes(1)
    expect(replacement.close).toHaveBeenCalledTimes(1)
    expect(replacement.download).not.toHaveBeenCalled()
  })

  it("does not close the downloaded resource while its installer is running (U08)", async () => {
    const downloaded = handle()
    const replacement = handle()
    let finishInstall!: () => void
    downloaded.install.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve
        })
    )
    checkMock.mockResolvedValueOnce(downloaded)
    await downloadUpdate()
    let finishCheck!: (value: UpdateHandleFixture) => void
    checkMock.mockReturnValueOnce(
      new Promise<UpdateHandleFixture>((resolve) => {
        finishCheck = resolve
      })
    )
    const checking = checkForUpdate()
    const installing = installUpdate({ relaunch: false })
    finishCheck(replacement)
    await checking
    await waitForMockCall(downloaded.install)
    const closedDuringInstall = downloaded.close!.mock.calls.length
    finishInstall()
    expect(await installing).toBe("installed")
    expect(closedDuringInstall).toBe(0)
    expect(replacement.close).toHaveBeenCalledTimes(1)
    expect(replacement.install).not.toHaveBeenCalled()
  })

  it("does not report another caller's download or installed marker as the expected version", async () => {
    const update = handle()
    let finish!: () => void
    update.download.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    checkMock.mockResolvedValueOnce(update)
    const first = downloadUpdate(undefined, { expectedVersion: "2.0.0" })
    await waitForMockCall(update.download)
    const second = downloadUpdate(undefined, { expectedVersion: "3.0.0" })
    finish()
    expect(await first).toBe("downloaded")
    expect(await second).toBe("versionMismatch")
    expect(await installUpdate({ expectedVersion: "2.0.0", relaunch: false })).toBe("installed")
    expect(await installUpdate({ expectedVersion: "3.0.0" })).toBe("versionMismatch")
    expect(await downloadAndInstallUpdate(undefined, { expectedVersion: "3.0.0" })).toBe(
      "versionMismatch"
    )
  })
})

describe("resolveUpdateSettings", () => {
  it("merges defaults for an older settings row", () => {
    expect(resolveUpdateSettings({ autoCheck: false })).toEqual({
      autoCheck: false,
      checkIntervalMinutes: 360,
      autoDownload: false,
      relaunchAfterInstall: true,
      requestTimeoutSeconds: 30,
      useProxy: true,
    })
  })

  it("clamps invalid numeric preferences", () => {
    expect(
      resolveUpdateSettings({
        checkIntervalMinutes: 1,
        requestTimeoutSeconds: 999,
      })
    ).toEqual(expect.objectContaining({ checkIntervalMinutes: 15, requestTimeoutSeconds: 300 }))
    expect(
      resolveUpdateSettings({
        checkIntervalMinutes: Number.NaN,
        requestTimeoutSeconds: Number.POSITIVE_INFINITY,
      })
    ).toEqual(expect.objectContaining({ checkIntervalMinutes: 360, requestTimeoutSeconds: 30 }))
  })
})

describe("checkForUpdate", () => {
  it("constructs a real plugin Update with usable download/install resource ids (U04)", async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: unknown) => invokeMock(command, args),
        },
      },
    })
    try {
      const ActualUpdate = jest.requireActual<typeof import("@tauri-apps/plugin-updater")>(
        "@tauri-apps/plugin-updater"
      ).Update
      jest.mocked(Update).mockImplementationOnce((metadata) => new ActualUpdate(metadata))
      const metadata = {
        rid: 73,
        currentVersion: "1.0.0",
        version: "2.0.0",
        rawJson: {},
        body: "notes",
      }
      checkMock
        .mockResolvedValueOnce(metadata)
        .mockResolvedValueOnce(74)
        .mockResolvedValue(undefined)
      await expect(checkForUpdate({ channel: "beta", rolloutBucket: 4321 })).resolves.toMatchObject(
        { version: "2.0.0", body: "notes" }
      )
      await expect(downloadAndInstallUpdate(undefined, { relaunch: false })).resolves.toBe(
        "installed"
      )
      expect(Update).toHaveBeenCalledWith(metadata)
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:updater|download",
        expect.objectContaining({ rid: 73, timeout: 30_000 })
      )
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:updater|install",
        expect.objectContaining({ updateRid: 73, bytesRid: 74 })
      )
      expect(invokeMock).toHaveBeenCalledWith("plugin:resources|close", { rid: 73 })
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("shares only concurrent checks with the same policy (U04)", async () => {
    let finish!: (value: UpdateHandleFixture) => void
    checkMock.mockReturnValueOnce(
      new Promise<UpdateHandleFixture>((resolve) => {
        finish = resolve
      })
    )
    checkMock.mockResolvedValueOnce(null)
    const stable = checkForUpdate({ channel: "stable", rolloutBucket: 4321 })
    const beta = checkForUpdate({ channel: "beta", rolloutBucket: 4321 })
    await waitForMockCall(checkMock)
    expect(checkMock).toHaveBeenCalledTimes(1)
    const old = handle()
    finish(old)
    await expect(stable).resolves.toMatchObject({ version: "2.0.0" })
    await expect(beta).resolves.toBeNull()
    expect(old.close).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenLastCalledWith("desktop_update_check", {
      channel: "beta",
      bucket: 4321,
      timeoutMs: 30_000,
    })
  })

  it("waits for a protected download before changing channel (U04)", async () => {
    const old = handle()
    let finishDownload!: () => void
    old.download.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve
        })
    )
    checkMock.mockResolvedValueOnce(old).mockResolvedValueOnce(null)
    await checkForUpdate({ channel: "stable", rolloutBucket: 4321 })
    const downloading = downloadUpdate()
    await waitForMockCall(old.download)
    const beta = checkForUpdate({ channel: "beta", rolloutBucket: 4321 })
    await Promise.resolve()
    expect(old.close).not.toHaveBeenCalled()
    expect(checkMock).toHaveBeenCalledTimes(1)
    finishDownload()
    await downloading
    await expect(beta).resolves.toBeNull()
    expect(old.close).toHaveBeenCalledTimes(1)
  })

  it("protects a download that starts before a queued policy check resumes (U04)", async () => {
    const original = handle()
    let finishCheck!: (value: UpdateHandleFixture) => void
    let finishDownload!: () => void
    original.download.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve
        })
    )
    checkMock
      .mockReturnValueOnce(
        new Promise<UpdateHandleFixture>((resolve) => {
          finishCheck = resolve
        })
      )
      .mockResolvedValueOnce(null)
    const stable = checkForUpdate({ channel: "stable", rolloutBucket: 4321 })
    const beta = checkForUpdate({ channel: "beta", rolloutBucket: 4321 })
    // The channel switch is queued, but this consumer starts downloading as
    // soon as its own check resolves, before the queued check gets another turn.
    const downloading = stable.then(() => downloadUpdate())
    await waitForMockCall(checkMock)
    finishCheck(original)
    await waitForMockCall(original.download)
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
    const closedWhileDownloading = original.close!.mock.calls.length
    const checksWhileDownloading = checkMock.mock.calls.length
    finishDownload()
    await expect(downloading).resolves.toBe("downloaded")
    await expect(beta).resolves.toBeNull()
    expect(closedWhileDownloading).toBe(0)
    expect(checksWhileDownloading).toBe(1)
    expect(original.close).toHaveBeenCalledTimes(1)
  })

  it("carries channel, cohort and timeout to the app command (U04)", async () => {
    settingsState.settings.updates.requestTimeoutSeconds = 45
    checkMock.mockResolvedValueOnce(null)
    await checkForUpdate({ channel: "beta", rolloutBucket: 9876 })
    expect(invokeMock).toHaveBeenCalledWith("desktop_update_check", {
      channel: "beta",
      bucket: 9876,
      timeoutMs: 45_000,
    })
  })

  it("uses bucket zero only for a manual native check (U04)", async () => {
    checkMock.mockResolvedValue(null)
    await checkForUpdate({ channel: "canary", rolloutBucket: 9876, manual: true })
    await checkForUpdate({ channel: "canary", rolloutBucket: 9876 })
    expect(invokeMock.mock.calls.map(([, args]) => args)).toEqual([
      { channel: "canary", bucket: 0, timeoutMs: 30_000 },
      { channel: "canary", bucket: 9876, timeoutMs: 30_000 },
    ])
    expect(settingsState.settings.updateCenter.rolloutBucket).toBe(4321)
  })

  it.each([
    { channel: "beta" as const, rolloutBucket: 4321 },
    { channel: "stable" as const, rolloutBucket: 9876 },
  ])("drops downloaded handles from another policy: %j (U04)", async (policy) => {
    const first = handle()
    const next = handle()
    checkMock.mockResolvedValueOnce(first).mockResolvedValueOnce(next)
    await checkForUpdate({ channel: "stable", rolloutBucket: 4321 })
    await downloadUpdate()
    await checkForUpdate(policy)
    await downloadUpdate()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(next.download).toHaveBeenCalledTimes(1)
  })

  it("returns null off the desktop shell without touching the plugin", async () => {
    isTauriMock.mockReturnValue(false)
    expect(await checkForUpdate()).toBeNull()
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("returns null when already current", async () => {
    checkMock.mockResolvedValueOnce(null)
    expect(await checkForUpdate()).toBeNull()
  })

  it("maps an available update to version + notes", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.2.3",
      body: "Notes",
      date: "2026-07-18T00:00:00Z",
      downloadAndInstall: jest.fn(),
    })
    expect(await checkForUpdate()).toEqual({
      version: "1.2.3",
      body: "Notes",
      date: "2026-07-18T00:00:00Z",
    })
  })

  it("passes the timeout while the native host owns active proxy routing", async () => {
    settingsState.settings.updates.requestTimeoutSeconds = 45
    settingsState.settings.networkProxy = {
      ...settingsState.settings.networkProxy,
      mode: "manual",
      host: "127.0.0.1",
      port: 7890,
    }
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(checkMock).toHaveBeenCalledWith("desktop_update_check", {
      channel: "stable",
      bucket: 4321,
      timeoutMs: 45_000,
    })
  })

  it("blocks instead of bypassing an active global proxy when updater proxy use is disabled", async () => {
    settingsState.settings.updates.useProxy = false
    settingsState.settings.networkProxy = {
      ...settingsState.settings.networkProxy,
      mode: "manual",
      host: "127.0.0.1",
      port: 7890,
    }
    await expect(checkForUpdate()).rejects.toEqual(
      expect.objectContaining({
        code: "network",
        phase: "check",
        message: expect.stringContaining("PROXY_TRANSPORT_UNSUPPORTED"),
      })
    )
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("permits an explicit direct updater request when the global proxy is off", async () => {
    settingsState.settings.updates.useProxy = false
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(checkMock).toHaveBeenCalledWith("desktop_update_check", {
      channel: "stable",
      bucket: 4321,
      timeoutMs: 30_000,
    })
  })

  it("fails closed before settings hydration completes", async () => {
    settingsState.loaded = false

    await expect(checkForUpdate()).rejects.toEqual(
      expect.objectContaining({
        code: "network",
        phase: "check",
        message: expect.stringContaining("PROXY_NOT_INITIALIZED"),
      })
    )
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("deduplicates concurrent checks", async () => {
    let resolveCheck!: (value: null) => void
    checkMock.mockReturnValueOnce(new Promise<null>((resolve) => (resolveCheck = resolve)))

    const first = checkForUpdate()
    const second = checkForUpdate()
    await waitForMockCall(checkMock)
    expect(checkMock).toHaveBeenCalledTimes(1)
    resolveCheck(null)

    await expect(Promise.all([first, second])).resolves.toEqual([null, null])
  })

  it("closes a superseded native update handle", async () => {
    const close = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({
      version: "1.2.3",
      download: jest.fn(),
      install: jest.fn(),
      close,
    })
    await checkForUpdate()
    checkMock.mockResolvedValueOnce(null)

    await checkForUpdate()

    expect(close).toHaveBeenCalledTimes(1)
  })

  it("does not fail a successful check when native resource cleanup fails", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.2.3",
      download: jest.fn(),
      install: jest.fn(),
      close: jest.fn(async () => {
        throw new Error("already closed")
      }),
    })
    await checkForUpdate()
    checkMock.mockResolvedValueOnce(null)
    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it("propagates a check failure", async () => {
    checkMock.mockRejectedValueOnce(new Error("network"))
    await expect(checkForUpdate()).rejects.toMatchObject({
      name: "AppUpdateError",
      code: "network",
      phase: "check",
      message: "network",
    })
  })

  it("classifies a denied Tauri capability as a permission error", async () => {
    checkMock.mockRejectedValueOnce(new Error("updater.check not allowed by ACL"))
    await expect(checkForUpdate()).rejects.toEqual(
      expect.objectContaining({ code: "permission", phase: "check" })
    )
  })

  it("narrows classified errors by phase", async () => {
    checkMock.mockRejectedValueOnce(new Error("network"))
    const error = await checkForUpdate().catch((caught: unknown) => caught)

    expect(isUpdateErrorPhase(error, "check")).toBe(true)
    expect(isUpdateErrorPhase(error, "download")).toBe(false)
    expect(isUpdateErrorPhase(new Error("network"), "check")).toBe(false)
  })

  it.each([
    ["request timed out", "timeout"],
    ["invalid minisign signature", "signature"],
    ["unexpected updater response", "unknown"],
  ])("classifies '%s' as %s", async (message, code) => {
    checkMock.mockRejectedValueOnce(new Error(message))
    await expect(checkForUpdate()).rejects.toEqual(
      expect.objectContaining({ code, phase: "check" })
    )
  })
})

describe("getUpdateCheckOptions", () => {
  it("reads the persisted policy and keeps the cohort unchanged", () => {
    settingsState.settings.updateCenter = { channel: "canary", rolloutBucket: 9876 }
    expect(getUpdateCheckOptions()).toEqual({ channel: "canary", rolloutBucket: 9876 })
    expect(saveSettingsMock).not.toHaveBeenCalled()
  })

  it("generates and persists one shared bucket on first use", () => {
    settingsState.settings.updateCenter = {
      channel: "beta",
      rolloutBucket: undefined as unknown as number,
    }
    const first = getUpdateCheckOptions()
    const second = getUpdateCheckOptions()
    expect(first).toEqual(second)
    expect(first.rolloutBucket).toBeGreaterThanOrEqual(0)
    expect(first.rolloutBucket).toBeLessThan(10_000)
    expect(saveSettingsMock).toHaveBeenCalledTimes(1)
    expect(saveSettingsMock).toHaveBeenCalledWith(expect.any(Function), { mirrorToHost: false })
    const merge = saveSettingsMock.mock.calls[0][0] as (current: unknown) => unknown
    // Only the cohort is merged into the row read at write time, so snapshots
    // the Update Center wrote meanwhile survive.
    const persistedSnapshots = {
      "desktop:app": { assetId: "app", kind: "desktop", state: "current" },
    }
    expect(merge({ updateCenter: { channel: "beta", snapshots: persistedSnapshots } })).toEqual({
      updateCenter: expect.objectContaining({
        rolloutBucket: first.rolloutBucket,
        snapshots: persistedSnapshots,
      }),
    })
  })

  it("keeps a bucket another writer persisted first", () => {
    settingsState.settings.updateCenter = {
      channel: "stable",
      rolloutBucket: undefined as unknown as number,
    }
    getUpdateCheckOptions()
    const merge = saveSettingsMock.mock.calls[0][0] as (current: unknown) => unknown
    expect(merge({ updateCenter: { channel: "stable", rolloutBucket: 42 } })).toEqual({})
  })
})

describe("downloadUpdate + installUpdate", () => {
  it("downloads once and can install without relaunching", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    const close = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", download, install, close })

    expect(await downloadUpdate()).toBe("downloaded")
    expect(await downloadUpdate()).toBe("downloaded")
    expect(download).toHaveBeenCalledTimes(1)

    expect(await installUpdate({ relaunch: false })).toBe("installed")
    expect(install).toHaveBeenCalledTimes(1)
    expect(relaunchMock).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("suppresses repeated update work after install until the process restarts", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    const listener = jest.fn()
    const unsubscribe = subscribeInstalledVersionAwaitingRestart(listener)
    checkMock.mockResolvedValueOnce({ version: "2.0.0", download, install })

    expect(await installUpdate({ relaunch: false })).toBe("installed")
    expect(getInstalledVersionAwaitingRestart()).toBe("2.0.0")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(await checkForUpdate()).toBeNull()
    expect(await downloadUpdate()).toBe("noLongerAvailable")
    expect(await installUpdate({ relaunch: false })).toBe("installed")
    expect(await downloadAndInstallUpdate(undefined, { relaunch: false })).toBe("installed")

    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("waits for a preceding check before starting a download", async () => {
    let resolveCheck!: (value: UpdateHandleFixture) => void
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    checkMock.mockReturnValueOnce(
      new Promise<UpdateHandleFixture>((resolve) => {
        resolveCheck = resolve
      })
    )

    const checking = checkForUpdate()
    const downloading = downloadUpdate()
    resolveCheck({ version: "2.0.0", download, install })

    await checking
    await expect(downloading).resolves.toBe("downloaded")
    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it("deduplicates concurrent downloads", async () => {
    let resolveDownload!: () => void
    const download = jest.fn(() => new Promise<void>((resolve) => (resolveDownload = resolve)))
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
    })

    const first = downloadUpdate()
    await waitForMockCall(download)
    const second = downloadUpdate()
    expect(download).toHaveBeenCalledTimes(1)
    resolveDownload()
    await expect(Promise.all([first, second])).resolves.toEqual(["downloaded", "downloaded"])
  })

  it("keeps checks on the active handle while a download is running", async () => {
    let resolveDownload!: () => void
    const download = jest.fn(() => new Promise<void>((resolve) => (resolveDownload = resolve)))
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      body: "notes",
      download,
      install: jest.fn(async () => {}),
    })
    const pending = downloadUpdate()
    await waitForMockCall(download)

    await expect(checkForUpdate()).resolves.toEqual({
      version: "2.0.0",
      body: "notes",
      date: undefined,
    })
    expect(checkMock).toHaveBeenCalledTimes(1)
    resolveDownload()
    await pending
  })

  it("supports web no-ops for download, install, and relaunch", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(downloadUpdate()).resolves.toBe("web")
    await expect(installUpdate()).resolves.toBe("web")
    await expect(relaunchAfterUpdate()).resolves.toBeUndefined()
  })

  it("classifies install and relaunch failures by phase", async () => {
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {
        throw new Error("disk write failed")
      }),
    })
    await expect(installUpdate()).rejects.toEqual(
      expect.objectContaining({ code: "install", phase: "install" })
    )

    __resetPendingUpdate()
    relaunchMock.mockRejectedValueOnce(new Error("restart failed"))
    await expect(relaunchAfterUpdate()).rejects.toEqual(
      expect.objectContaining({ code: "relaunch", phase: "relaunch" })
    )
  })
})

describe("downloadAndInstallUpdate", () => {
  it("returns 'web' off the desktop shell", async () => {
    isTauriMock.mockReturnValue(false)
    expect(await downloadAndInstallUpdate()).toBe("web")
    expect(checkMock).not.toHaveBeenCalled()
  })

  it("returns 'noLongerAvailable' when no handle is cached and a re-check finds nothing", async () => {
    checkMock.mockResolvedValueOnce(null)
    expect(await downloadAndInstallUpdate()).toBe("noLongerAvailable")
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it("downloads, installs and relaunches when an update is pending (no cache)", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", download, install })
    expect(await downloadAndInstallUpdate()).toBe("relaunching")
    expect(download).toHaveBeenCalled()
    expect(install).toHaveBeenCalled()
    expect(saveWindowStateMock).toHaveBeenCalledWith(1 | 2 | 4 | 16)
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("does not block relaunch when saving window state fails", async () => {
    saveWindowStateMock.mockRejectedValueOnce(new Error("state file unavailable"))

    await expect(relaunchAfterUpdate()).resolves.toBeUndefined()

    expect(warnMock).toHaveBeenCalledWith("window state save failed before updater relaunch", {
      error: "state file unavailable",
    })
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("reuses the handle cached by checkForUpdate without a second check()", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "2.0.0", body: "x", download, install })
    await checkForUpdate()
    expect(checkMock).toHaveBeenCalledTimes(1)

    expect(await downloadAndInstallUpdate()).toBe("relaunching")
    // No second network round-trip: the cached handle was reused.
    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalled()
    expect(install).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
  })

  it("re-checks when the cached handle has aged past its TTL", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_000)
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    await checkForUpdate()
    expect(checkMock).toHaveBeenCalledTimes(1)

    // Jump past the 10-minute reuse window: the stale handle must be discarded.
    nowSpy.mockReturnValue(1_000 + 11 * 60 * 1000)
    const freshDownload = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({
      version: "2.0.1",
      download: freshDownload,
      install: jest.fn(async () => {}),
    })
    expect(await downloadAndInstallUpdate()).toBe("relaunching")
    expect(checkMock).toHaveBeenCalledTimes(2)
    expect(freshDownload).toHaveBeenCalled()
    expect(relaunchMock).toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it("clears the cache after a current check so install re-checks", async () => {
    checkMock.mockResolvedValueOnce(null)
    await checkForUpdate()
    checkMock.mockResolvedValueOnce(null)
    expect(await downloadAndInstallUpdate()).toBe("noLongerAvailable")
    expect(checkMock).toHaveBeenCalledTimes(2)
  })

  it("streams normalized download progress to the callback", async () => {
    const download = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } })
      onEvent?.({ event: "Finished" })
    })
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    const ticks: Array<{ downloaded: number; total?: number }> = []
    await downloadAndInstallUpdate((p) => ticks.push(p))
    expect(ticks).toEqual([
      { downloaded: 0, total: 100 },
      { downloaded: 40, total: 100 },
      { downloaded: 100, total: 100 },
      { downloaded: 100, total: 100 },
    ])
  })

  it("tolerates a missing content length (indeterminate progress)", async () => {
    const download = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: {} })
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } })
      onEvent?.({ event: "Finished" })
    })
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    const ticks: Array<{ downloaded: number; total?: number }> = []
    await downloadAndInstallUpdate((p) => ticks.push(p))
    expect(ticks).toEqual([
      { downloaded: 0, total: undefined },
      { downloaded: 25, total: undefined },
      { downloaded: 25, total: undefined },
    ])
  })

  it("propagates an install failure before relaunch", async () => {
    const download = jest.fn(async () => {
      throw new Error("disk full")
    })
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    await expect(downloadAndInstallUpdate()).rejects.toThrow("disk full")
    expect(relaunchMock).not.toHaveBeenCalled()
  })
})
