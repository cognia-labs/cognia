/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"
import { applyProxyPasswordMutation } from "@/lib/network/proxy-credentials"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/platform/window-role", () => ({
  isMainAppWindow: jest.fn(),
}))

jest.mock("@/lib/network/proxy-credentials", () => ({
  applyProxyPasswordMutation: jest.fn().mockResolvedValue(true),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriCore = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauri = require("@/lib/tauri") as { isTauri: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const windowRole = require("@/lib/platform/window-role") as { isMainAppWindow: jest.Mock }

const { useSettingsStore } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@/stores/settings/settings-store") as typeof import("@/stores/settings/settings-store")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyStore = require("./index") as typeof import("./index")

const baseSettings = (np: Partial<typeof DEFAULT_NETWORK_PROXY_SETTINGS> = {}) => ({
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: {
    fileExtras: true,
    git: true,
    process: false,
    environment: true,
    shellAdvanced: false,
  },
  networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, ...np },
})

beforeEach(() => {
  jest.clearAllMocks()
  windowRole.isMainAppWindow.mockReturnValue(true)
  jest.spyOn(console, "warn").mockImplementation(() => {})
  jest.spyOn(console, "debug").mockImplementation(() => {})
  useSettingsStore.setState({ settings: null, loaded: false })
  proxyStore.resetApplyProxyDedupeForTesting()
})

afterEach(() => {
  // `clearMocks: true` (jest.config.ts:16) only clears call history. Without this teardown
  // the console.warn / console.debug spies installed in beforeEach leak into other suites
  // running in the same Jest worker — the pattern mirrors stores/settings/settings-store.test.ts:80-82.
  jest.restoreAllMocks()
})

describe("getNetworkProxy", () => {
  it("returns defaults when settings are unloaded", () => {
    expect(proxyStore.getNetworkProxy()).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
  })

  it("returns the persisted networkProxy", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "10.0.0.1", port: 1080 }),
      loaded: true,
    })
    expect(proxyStore.getNetworkProxy().host).toBe("10.0.0.1")
    expect(proxyStore.getNetworkProxy().port).toBe(1080)
  })
})

describe("applyProxyToRust", () => {
  it.each(["off", "manual"] as const)(
    "applies %s without a frontend keyring lookup",
    async (mode) => {
      tauri.isTauri.mockReturnValue(true)
      tauriCore.invoke.mockResolvedValue(undefined)

      await proxyStore.applyProxyToRust({
        ...DEFAULT_NETWORK_PROXY_SETTINGS,
        mode,
        host: "127.0.0.1",
        port: 7890,
      })

      expect(applyProxyPasswordMutation).not.toHaveBeenCalled()
      expect(tauriCore.invoke).toHaveBeenCalledWith(
        "proxy_apply",
        expect.objectContaining({ input: expect.objectContaining({ mode }) })
      )
    }
  )

  it("preserves native credential failures and retries the authenticated policy", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockRejectedValueOnce(new Error("PROXY_CREDENTIAL_UNAVAILABLE"))
    tauriCore.invoke.mockResolvedValueOnce(undefined)
    const settings = {
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      mode: "manual" as const,
      host: "proxy.corp",
      port: 8080,
      username: "alice",
    }

    await expect(proxyStore.applyProxyToRust(settings)).rejects.toThrow(
      "PROXY_CREDENTIAL_UNAVAILABLE"
    )
    await expect(proxyStore.applyProxyToRust(settings)).resolves.toBeUndefined()

    expect(tauriCore.invoke).toHaveBeenCalledTimes(2)
    for (const [, args] of tauriCore.invoke.mock.calls) {
      expect(args.input).toMatchObject({ mode: "manual", username: "alice" })
    }
  })

  it("is a no-op outside Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("does not invoke proxy_apply from a least-privilege secondary window", async () => {
    tauri.isTauri.mockReturnValue(true)
    windowRole.isMainAppWindow.mockReturnValue(false)

    await proxyStore.applyProxyToRust()

    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("invokes proxy_apply with a sanitized payload in Tauri", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({
        mode: "manual",
        host: "127.0.0.1",
        port: 7890,
        username: "alice",
      }),
      loaded: true,
    })
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledWith("proxy_apply", {
      input: expect.objectContaining({
        mode: "manual",
        protocol: "http",
        host: "127.0.0.1",
        port: 7890,
        username: "alice",
        proxy_websockets: true,
      }),
    })
    expect(JSON.stringify(tauriCore.invoke.mock.calls[0])).not.toContain("password")
  })

  it("signals live WebViews only after native policy is applied", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    const listener = jest.fn()
    window.addEventListener("cognia:network-proxy-applied", listener)

    await proxyStore.applyProxyToRust(DEFAULT_NETWORK_PROXY_SETTINGS)

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener("cognia:network-proxy-applied", listener)
  })

  it("dedupes consecutive identical pushes", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
    })
    await proxyStore.applyProxyToRust()
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledTimes(1)
  })

  it("re-pushes when config changes", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
    })
    await proxyStore.applyProxyToRust()
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "10.0.0.1", port: 7890 }),
      loaded: true,
    })
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledTimes(2)
  })

  it("surfaces errors so callers can block unsafe outbound traffic", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockRejectedValue(new Error("boom"))
    await expect(proxyStore.applyProxyToRust()).rejects.toThrow("boom")
  })

  it("logs the empty-config branch when proxy is inactive but Tauri is on", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    // No host/port — `isProxyActive` returns false but we still push to Rust.
    useSettingsStore.setState({
      settings: baseSettings({ mode: "off" }),
      loaded: true,
    })
    await proxyStore.applyProxyToRust()
    expect(tauriCore.invoke).toHaveBeenCalledWith(
      "proxy_apply",
      expect.objectContaining({ input: expect.objectContaining({ mode: "off" }) })
    )
  })

  it("explicit cfg argument overrides the live settings snapshot", async () => {
    tauri.isTauri.mockReturnValue(true)
    tauriCore.invoke.mockResolvedValue(undefined)
    // Live settings are off; the explicit cfg should still be sent.
    useSettingsStore.setState({
      settings: baseSettings({ mode: "off" }),
      loaded: true,
    })
    await proxyStore.applyProxyToRust({
      ...DEFAULT_NETWORK_PROXY_SETTINGS,
      mode: "manual",
      host: "10.10.10.10",
      port: 8888,
    })
    expect(tauriCore.invoke).toHaveBeenCalledWith(
      "proxy_apply",
      expect.objectContaining({
        input: expect.objectContaining({ host: "10.10.10.10", port: 8888 }),
      })
    )
  })
})

describe("maybeAutoDetectProxy", () => {
  it("is a no-op outside Tauri", async () => {
    tauri.isTauri.mockReturnValue(false)
    await proxyStore.maybeAutoDetectProxy()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("does not invoke proxy detection from a least-privilege secondary window", async () => {
    tauri.isTauri.mockReturnValue(true)
    windowRole.isMainAppWindow.mockReturnValue(false)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto" }),
      loaded: true,
    })

    await proxyStore.maybeAutoDetectProxy()

    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("is a no-op when mode is not auto", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "127.0.0.1", port: 7890 }),
      loaded: true,
    })
    await proxyStore.maybeAutoDetectProxy()
    expect(tauriCore.invoke).not.toHaveBeenCalled()
  })

  it("adopts the top candidate when it differs from the stored host/port", async () => {
    tauri.isTauri.mockReturnValue(true)
    const saveSpy = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto", host: "127.0.0.1", port: 1111 }),
      loaded: true,
      save: saveSpy,
    })
    tauriCore.invoke.mockResolvedValue([
      {
        kind: "socks5",
        host: "127.0.0.1",
        port: 1080,
        label: "SOCKS @ 1080",
        verified: true,
        verification: "socks5-connect",
      },
    ])
    await proxyStore.maybeAutoDetectProxy()
    expect(tauriCore.invoke).toHaveBeenCalledWith("proxy_detect")
    expect(saveSpy).toHaveBeenCalled()
    const patch = saveSpy.mock.calls[0][0]
    expect(patch.networkProxy.host).toBe("127.0.0.1")
    expect(patch.networkProxy.port).toBe(1080)
    expect(patch.networkProxy.protocol).toBe("socks5")
    expect(patch.networkProxy.mode).toBe("auto")
  })

  it("does not re-save when the top candidate matches the stored host/port", async () => {
    tauri.isTauri.mockReturnValue(true)
    const saveSpy = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto", host: "127.0.0.1", port: 7890 }),
      loaded: true,
      save: saveSpy,
    })
    tauriCore.invoke.mockResolvedValue([
      {
        kind: "http",
        host: "127.0.0.1",
        port: 7890,
        label: "HTTP @ 7890",
        verified: true,
        verification: "http-connect",
      },
    ])
    await proxyStore.maybeAutoDetectProxy()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it("leaves the config untouched when detection finds nothing", async () => {
    tauri.isTauri.mockReturnValue(true)
    const saveSpy = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto", host: "1.2.3.4", port: 9 }),
      loaded: true,
      save: saveSpy,
    })
    tauriCore.invoke.mockResolvedValue([])
    await proxyStore.maybeAutoDetectProxy()
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it("swallows detection errors so the caller never throws", async () => {
    tauri.isTauri.mockReturnValue(true)
    useSettingsStore.setState({
      settings: baseSettings({ mode: "auto" }),
      loaded: true,
    })
    tauriCore.invoke.mockRejectedValue(new Error("boom"))
    await expect(proxyStore.maybeAutoDetectProxy()).resolves.toBeUndefined()
  })
})

describe("useNetworkProxy hook", () => {
  function HookProbe({ onValue }: { onValue: (v: unknown) => void }) {
    const value = proxyStore.useNetworkProxy()
    onValue(value)
    return null
  }

  it("returns DEFAULT_NETWORK_PROXY_SETTINGS when settings are not loaded", () => {
    const seen: unknown[] = []
    render(<HookProbe onValue={(v) => seen.push(v)} />)
    expect(seen[0]).toEqual(DEFAULT_NETWORK_PROXY_SETTINGS)
  })

  it("returns the persisted networkProxy when settings are loaded", () => {
    useSettingsStore.setState({
      settings: baseSettings({ mode: "manual", host: "1.2.3.4", port: 9999 }),
      loaded: true,
    })
    const seen: unknown[] = []
    render(<HookProbe onValue={(v) => seen.push(v)} />)
    expect(seen[0]).toMatchObject({ host: "1.2.3.4", port: 9999 })
  })
})
