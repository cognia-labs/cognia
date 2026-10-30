/**
 * @jest-environment jsdom
 *
 * Tests for the plugin shortcut bridge: browser keydown fallback (chord
 * normalization, preventDefault, ref-counted listener), desktop bind via
 * the live shortcut rail (conflict skip, unbind on teardown), wrapper
 * command lifecycle, and per-plugin bulk teardown.
 */

import { fireEvent, waitFor } from "@testing-library/dom"

import {
  __resetPluginShortcutBridgeForTesting,
  bindPluginShortcut,
  flushPluginShortcutOperations,
  listPluginShortcuts,
  unbindAllPluginShortcuts,
} from "./plugin-shortcut-bridge"
import {
  __resetCommandRegistryForTesting,
  getCommand,
  registerCommand,
} from "@/lib/plugin/commands/registry"
import { useShortcutStore, __resetShortcutStoreForTesting } from "@/lib/shortcuts/registry"
import { reservePluginOwnership } from "@/lib/plugin/registries/createOverlayRegistry"
import { runMarketplaceInstall } from "@/lib/plugin/marketplace/install-flow"

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => []),
  getPlugin: jest.fn(async () => null),
  setPluginConfig: jest.fn(),
}))

const isTauriMock = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: () => isTauriMock(),
}))

const recordSilentFailure = jest.fn()
jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  recordSilentFailure: (...args: unknown[]) => recordSilentFailure(...args),
}))

afterEach(async () => {
  __resetPluginShortcutBridgeForTesting()
  await flushPluginShortcutOperations()
  __resetCommandRegistryForTesting()
  __resetShortcutStoreForTesting()
  isTauriMock.mockReset().mockReturnValue(false)
  recordSilentFailure.mockClear()
})

describe("browser fallback", () => {
  it("reserves a paused consumer's chord without running its old handler", async () => {
    const original = jest.fn()
    const replacement = jest.fn()
    await bindPluginShortcut({ pluginId: "consumer", chord: "Ctrl+Y", run: original })
    const reservation = reservePluginOwnership("consumer")
    try {
      unbindAllPluginShortcuts("consumer")
      await bindPluginShortcut({ pluginId: "provider", chord: "Ctrl+Y", run: replacement })
      fireEvent.keyDown(window, { key: "y", ctrlKey: true })
      expect(original).not.toHaveBeenCalled()
      expect(replacement).not.toHaveBeenCalled()
      await bindPluginShortcut({ pluginId: "consumer", chord: "Ctrl+Y", run: original })
      fireEvent.keyDown(window, { key: "y", ctrlKey: true })
      expect(original).toHaveBeenCalledTimes(1)
    } finally {
      reservation.dispose()
    }
  })
  it("a stale rejected binding cannot remove a later successful wrapper", async () => {
    const disposeFirst = await bindPluginShortcut({
      pluginId: "first",
      chord: "Ctrl+Y",
      run: jest.fn(),
    })
    const disposeRejected = await bindPluginShortcut({
      pluginId: "second",
      chord: "Ctrl+Y",
      run: jest.fn(),
    })
    disposeFirst()
    const run = jest.fn()
    await bindPluginShortcut({ pluginId: "second", chord: "Ctrl+Y", run })
    disposeRejected()
    fireEvent.keyDown(window, { key: "y", ctrlKey: true })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it("refreshes an owned chord and ignores its stale disposer", async () => {
    const old = jest.fn()
    const current = jest.fn()
    const disposeOld = await bindPluginShortcut({ pluginId: "same", chord: "Ctrl+Y", run: old })
    await bindPluginShortcut({ pluginId: "same", chord: "Ctrl+Y", run: current })
    disposeOld()
    fireEvent.keyDown(window, { key: "y", ctrlKey: true })
    expect(old).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(1)
  })

  it("cleans up a rejected plugin's wrapper on bulk teardown", async () => {
    await bindPluginShortcut({ pluginId: "first", chord: "Ctrl+Y", run: jest.fn() })
    await bindPluginShortcut({ pluginId: "second", chord: "Ctrl+Y", run: jest.fn() })
    unbindAllPluginShortcuts("second")
    expect(getCommand("_pshortcut:second:ctrl+y")).toBeUndefined()
    expect(getCommand("_pshortcut:first:ctrl+y")).toBeDefined()
  })
  it("keeps the first plugin handler when another plugin claims the same chord", async () => {
    const first = jest.fn()
    const second = jest.fn()
    await bindPluginShortcut({ pluginId: "first", chord: "Ctrl+Y", run: first })
    const disposeRejected = await bindPluginShortcut({
      pluginId: "second",
      chord: "Ctrl+Y",
      run: second,
    })
    fireEvent.keyDown(window, { key: "y", ctrlKey: true })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    disposeRejected()
    fireEvent.keyDown(window, { key: "y", ctrlKey: true })
    expect(first).toHaveBeenCalledTimes(2)
  })

  it("fires the handler on a matching (normalized) chord", async () => {
    const run = jest.fn()
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Shift+Ctrl+Y", run })

    fireEvent.keyDown(window, { key: "y", ctrlKey: true, shiftKey: true })

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("registers a hidden wrapper command as the dispatch handle", async () => {
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Y", run: () => {} })

    expect(getCommand("_pshortcut:plug-a:ctrl+y")).toBeDefined()
  })

  it("dispatches through an existing command id when provided", async () => {
    const handler = jest.fn()
    registerCommand({ id: "qa:plug-a:sync", pluginId: "plug-a", handler })
    await bindPluginShortcut({
      pluginId: "plug-a",
      chord: "Ctrl+U",
      existingCommandId: "qa:plug-a:sync",
    })

    fireEvent.keyDown(window, { key: "u", ctrlKey: true })

    expect(handler).toHaveBeenCalled()
    // No wrapper command was created for an existing id.
    expect(getCommand("_pshortcut:plug-a:ctrl+u")).toBeUndefined()
  })

  it("ignores non-matching chords", async () => {
    const run = jest.fn()
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Y", run })

    fireEvent.keyDown(window, { key: "y", altKey: true })

    expect(run).not.toHaveBeenCalled()
  })

  it("disposer removes the binding, the wrapper command, and (last one out) the listener", async () => {
    const run = jest.fn()
    const dispose = await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Y", run })

    dispose()
    fireEvent.keyDown(window, { key: "y", ctrlKey: true })

    expect(run).not.toHaveBeenCalled()
    expect(getCommand("_pshortcut:plug-a:ctrl+y")).toBeUndefined()
    expect(listPluginShortcuts("plug-a")).toEqual([])
  })
})

describe("desktop rail", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
  })

  it("keeps the current OS binding when a predecessor is disposed", async () => {
    const bound = new Set<string>()
    const unbind = jest.fn(async (id: string) => {
      bound.delete(id)
    })
    useShortcutStore.setState({
      conflictFor: async () => null,
      bind: async ({ id }: { id: string }) => {
        bound.add(id)
        return { ok: true }
      },
      unbind,
    } as never)
    const disposeOld = await bindPluginShortcut({
      pluginId: "same",
      chord: "Ctrl+Y",
      run: jest.fn(),
    })
    const disposeCurrent = await bindPluginShortcut({
      pluginId: "same",
      chord: "Ctrl+Y",
      run: jest.fn(),
    })
    disposeOld()
    expect(bound.has("_pshortcut:same:ctrl+y")).toBe(true)
    disposeCurrent()
    await waitFor(() => expect(bound.size).toBe(0))
    expect(unbind).toHaveBeenCalledTimes(1)
  })

  it("does not let a stale OS binding delete an already disposed replacement", async () => {
    const unbind = jest.fn(async () => undefined)
    useShortcutStore.setState({
      conflictFor: async () => null,
      bind: async () => ({ ok: true }),
      unbind,
    } as never)
    const old = await bindPluginShortcut({ pluginId: "same", chord: "Ctrl+Y", run: jest.fn() })
    const current = await bindPluginShortcut({ pluginId: "same", chord: "Ctrl+Y", run: jest.fn() })
    current()
    old()
    await waitFor(() => expect(unbind).toHaveBeenCalledTimes(1))
  })

  it("serializes overlapping refreshes and keeps the newest binding lease", async () => {
    let finish!: (value: { ok: true }) => void
    const bind = jest
      .fn(async () => ({ ok: true }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
    const unbind = jest.fn(async () => undefined)
    useShortcutStore.setState({ conflictFor: async () => null, bind, unbind } as never)
    const old = bindPluginShortcut({ pluginId: "same", chord: "Ctrl+Y", run: jest.fn() })
    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
    const current = bindPluginShortcut({ pluginId: "same", chord: "Ctrl+Y", run: jest.fn() })
    await Promise.resolve()
    expect(bind).toHaveBeenCalledTimes(1)
    finish({ ok: true })
    const disposeOld = await old
    const disposeCurrent = await current
    disposeOld()
    await Promise.resolve()
    expect(unbind).not.toHaveBeenCalled()
    disposeCurrent()
    await waitFor(() => expect(unbind).toHaveBeenCalledTimes(1))
  })

  it("drains a cancelled in-flight OS bind and skips queued registrations after bulk teardown", async () => {
    let finish!: (value: { ok: true }) => void
    const bind = jest.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve
        })
    )
    const unbind = jest.fn(async () => undefined)
    useShortcutStore.setState({ conflictFor: async () => null, bind, unbind } as never)
    const pending = bindPluginShortcut({ pluginId: "pending", chord: "Ctrl+Y", run: jest.fn() })
    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
    const queued = bindPluginShortcut({ pluginId: "pending", chord: "Ctrl+Z", run: jest.fn() })
    unbindAllPluginShortcuts("pending")
    expect(getCommand("_pshortcut:pending:ctrl+y")).toBeUndefined()
    finish({ ok: true })
    await pending
    await queued
    expect(bind).toHaveBeenCalledTimes(1)
    expect(unbind).toHaveBeenCalledWith("_pshortcut:pending:ctrl+y")
    expect(listPluginShortcuts("pending")).toEqual([])
  })

  it("reserves a paused owner's chord acquired before its bind response completes", async () => {
    let finish!: (value: { ok: true }) => void
    const bind = jest
      .fn(async () => ({ ok: true }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
    useShortcutStore.setState({
      conflictFor: async () => null,
      bind,
      unbind: async () => undefined,
    } as never)
    const pending = bindPluginShortcut({ pluginId: "consumer", chord: "Ctrl+Y", run: jest.fn() })
    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1))
    const reservation = reservePluginOwnership("consumer")
    try {
      unbindAllPluginShortcuts("consumer")
      const contender = bindPluginShortcut({
        pluginId: "provider",
        chord: "Ctrl+Y",
        run: jest.fn(),
      })
      finish({ ok: true })
      await pending
      await contender
      expect(bind).toHaveBeenCalledTimes(1)
    } finally {
      reservation.dispose()
    }
  })

  it("keeps root reservations until fire-and-forget native registrations have drained", async () => {
    let finish!: (value: { ok: true }) => void
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let restored!: () => void
    const restoreQueued = new Promise<void>((resolve) => {
      restored = resolve
    })
    let owner: string | null = null
    const bind = jest
      .fn(async ({ id }: { id: string }) => {
        owner = id
        return { ok: true }
      })
      .mockImplementationOnce(({ id }) => {
        owner = id
        start()
        return new Promise((resolve) => {
          finish = resolve
        })
      })
    useShortcutStore.setState({
      bind,
      conflictFor: async (_chord: string, id: string) => (owner && owner !== id ? owner : null),
      unbind: async (id: string) => {
        if (owner === id) owner = null
      },
    } as never)
    const first = bindPluginShortcut({ pluginId: "consumer", chord: "Ctrl+Y", run: jest.fn() })
    await started
    let settled = false
    const pending = runMarketplaceInstall({
      pluginId: "target",
      pauseBeforeInstall: ["consumer"],
      client: {
        getPlugin: async () => ({
          manifest: {
            id: "target",
            name: "Target",
            description: "Target plugin",
            version: "1.0.0",
            type: "frontend",
            capabilities: [],
          },
        }),
        installPlugin: async () => {
          void bindPluginShortcut({ pluginId: "provider", chord: "Ctrl+Y", run: jest.fn() })
        },
      },
      requestConflictReview: async () => "continue",
      requestPermissionReview: async () => "approve",
      requestConfig: async () => ({ result: "cancel" }),
      resolveConflictingPlugins: async () => {
        unbindAllPluginShortcuts("consumer")
        return async () => {
          void bindPluginShortcut({ pluginId: "consumer", chord: "Ctrl+Y", run: jest.fn() })
          restored()
        }
      },
    }).then((result) => {
      settled = true
      return result
    })
    await restoreQueued
    await Promise.resolve()
    expect(settled).toBe(false)
    finish({ ok: true })
    await first
    expect(await pending).toEqual({ status: "installed", pluginId: "target" })
    expect(bind.mock.calls.map(([args]) => args.id)).toEqual([
      "_pshortcut:consumer:ctrl+y",
      "_pshortcut:consumer:ctrl+y",
    ])
    expect(owner).toBe("_pshortcut:consumer:ctrl+y")
  })

  it("binds the chord through the shortcut store when free", async () => {
    const bind = jest.fn(async () => ({ ok: true }))
    const conflictFor = jest.fn(async () => null)
    useShortcutStore.setState({ bind, conflictFor } as never)

    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+Shift+P", run: () => {} })

    expect(conflictFor).toHaveBeenCalledWith("ctrl+shift+p", "_pshortcut:plug-a:ctrl+shift+p")
    expect(bind).toHaveBeenCalledWith({
      id: "_pshortcut:plug-a:ctrl+shift+p",
      chord: "ctrl+shift+p",
      scope: "global",
    })
  })

  it("never overrides an existing chord — skips the OS bind and records a silent failure", async () => {
    const bind = jest.fn(async () => ({ ok: true }))
    const conflictFor = jest.fn(async () => "user.binding")
    useShortcutStore.setState({ bind, conflictFor } as never)

    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+K", run: () => {} })

    expect(bind).not.toHaveBeenCalled()
    expect(recordSilentFailure).toHaveBeenCalledWith(
      "plug-a",
      expect.objectContaining({ site: "shortcuts.bind", expected: true }),
      null
    )
    // The dispatch command still exists — reachable via palette/tray.
    expect(getCommand("_pshortcut:plug-a:ctrl+k")).toBeDefined()
  })

  it("unbinds the OS chord on teardown", async () => {
    const bind = jest.fn(async () => ({ ok: true }))
    const conflictFor = jest.fn(async () => null)
    const unbind = jest.fn(async () => {})
    useShortcutStore.setState({ bind, conflictFor, unbind } as never)

    const dispose = await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+P", run: () => {} })
    dispose()

    await waitFor(() => expect(unbind).toHaveBeenCalledWith("_pshortcut:plug-a:ctrl+p"))
  })

  it("records a silent failure when the bind itself fails", async () => {
    const bind = jest.fn(async () => ({ ok: false, error: "RegisterHotKey failed" }))
    const conflictFor = jest.fn(async () => null)
    useShortcutStore.setState({ bind, conflictFor } as never)

    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+J", run: () => {} })

    expect(recordSilentFailure).toHaveBeenCalledWith(
      "plug-a",
      expect.objectContaining({ site: "shortcuts.bind", expected: false }),
      "RegisterHotKey failed"
    )
  })
})

describe("unbindAllPluginShortcuts", () => {
  it("drops every binding owned by the plugin and leaves others intact", async () => {
    const runA = jest.fn()
    const runB = jest.fn()
    await bindPluginShortcut({ pluginId: "plug-a", chord: "Ctrl+1", run: runA })
    await bindPluginShortcut({ pluginId: "plug-b", chord: "Ctrl+2", run: runB })

    const removed = unbindAllPluginShortcuts("plug-a")

    expect(removed).toBe(1)
    fireEvent.keyDown(window, { key: "1", ctrlKey: true })
    fireEvent.keyDown(window, { key: "2", ctrlKey: true })
    expect(runA).not.toHaveBeenCalled()
    expect(runB).toHaveBeenCalled()
  })
})
