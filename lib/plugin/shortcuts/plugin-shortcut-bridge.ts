"use client"

/**
 * Plugin shortcut bridge — routes `ctx.shortcuts` registrations onto the
 * LIVE shortcut rail instead of the dead `plugin_shortcut_register` path.
 *
 * The working rail (verified end-to-end):
 *   `useShortcutStore.bind(id, chord)` → Rust `shortcut_bind` → OS press →
 *   `ShortcutRegistry::dispatch` emits `shortcut://triggered { id }`
 *   (src-tauri/src/shortcuts/registry.rs) → `hooks/system/use-tauri-events.ts`
 *   → `dispatchShortcut(id)` (lib/tray/dispatcher.ts) → `executeCommand(id)`.
 *
 * So every plugin shortcut becomes a command-registry entry whose id IS the
 * shortcut binding id — the rail needs zero changes. In the browser (no
 * Tauri) a single ref-counted `keydown` listener provides the fallback.
 *
 * Conflict policy: the Rust `ShortcutRegistry` holds user bindings too;
 * `conflictFor` consults the same namespace, so a plugin can never silently
 * override a user chord — on conflict the OS bind is skipped (recorded as a
 * silent failure) while the action stays reachable via palette/tray.
 */

import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"
import type { ShortcutOptions } from "@/types/plugin"
import { executeCommand, registerCommand } from "@/lib/plugin/commands/registry"
import { useShortcutStore } from "@/lib/shortcuts/registry"
import { normalizeKeyCombo, parseKeyEvent } from "@/lib/shortcuts/utils"
import { recordSilentFailure } from "@/lib/plugin/contracts/diagnostics-store"
import {
  getReservedPluginKeyOwner,
  rememberReservedPluginKey,
} from "@/lib/plugin/registries/createOverlayRegistry"

export interface BindPluginShortcutArgs {
  pluginId: string
  /** Chord string, e.g. `"Ctrl+Shift+Y"`. Normalised before binding. */
  chord: string
  /** Handler — ignored when `existingCommandId` is provided. */
  run?: () => void
  /**
   * Dispatch through an already-registered command (quick-action
   * accelerators) instead of registering a wrapper command.
   */
  existingCommandId?: string
  options?: ShortcutOptions
}

interface PluginShortcutBinding {
  pluginId: string
  chord: string
  commandId: string
  /** True when we registered a wrapper command that must be cleaned up. */
  ownsCommand: boolean
  /** True when the chord made it onto the OS rail (desktop only). */
  desktopBound: boolean
  preventDefault: boolean
  disposeCommand?: () => void
}

/** Per-plugin live bindings (for getRegistered + bulk teardown). */
const bindingsByPlugin = new Map<string, Set<PluginShortcutBinding>>()

/** Browser fallback: normalized chord → bindings listening on it. */
const browserBindings = new Map<string, Set<PluginShortcutBinding>>()
/** Native binding ids survive handler refresh; only their current lease unbinds. */
const desktopBindings = new Map<string, PluginShortcutBinding>()
const desktopEpochs = new Map<string, object>()
let desktopOperation: Promise<unknown> = Promise.resolve()

function onDesktopRail<T>(operation: () => Promise<T>): Promise<T> {
  const result = desktopOperation.catch(() => {}).then(operation)
  desktopOperation = result
  return result
}

/** Fire-and-forget context registrations must settle before ownership leases expire. */
export async function flushPluginShortcutOperations(): Promise<void> {
  let pending: Promise<unknown>
  do {
    pending = desktopOperation
    await pending.catch(() => {})
  } while (pending !== desktopOperation)
}
const ownershipScope = Symbol("plugin-shortcuts")

let keydownListener: ((e: KeyboardEvent) => void) | null = null

function ensureBrowserListener(): void {
  if (keydownListener || typeof window === "undefined") return
  keydownListener = (e: KeyboardEvent) => {
    const chord = normalizeKeyCombo(parseKeyEvent(e))
    const hits = browserBindings.get(chord)
    if (!hits || hits.size === 0) return
    for (const binding of hits) {
      if (binding.preventDefault) e.preventDefault()
      executeCommand(binding.commandId).catch((err) => {
        loggers.plugin.warn("plugin shortcut dispatch failed", {
          pluginId: binding.pluginId,
          commandId: binding.commandId,
          error: String(err),
        })
      })
    }
  }
  window.addEventListener("keydown", keydownListener)
}

function maybeRemoveBrowserListener(): void {
  if (!keydownListener) return
  for (const set of browserBindings.values()) {
    if (set.size > 0) return
  }
  window.removeEventListener("keydown", keydownListener)
  keydownListener = null
}

/**
 * Bind one plugin shortcut. Returns a disposer that unbinds the chord and
 * removes any wrapper command.
 */
export async function bindPluginShortcut(args: BindPluginShortcutArgs): Promise<() => void> {
  if (!isTauri()) return bindPluginShortcutInner(args)
  let epoch = desktopEpochs.get(args.pluginId)
  if (!epoch) {
    epoch = {}
    desktopEpochs.set(args.pluginId, epoch)
  }
  return onDesktopRail(async () => {
    if (desktopEpochs.get(args.pluginId) !== epoch) return () => {}
    return bindPluginShortcutInner(args)
  })
}

async function bindPluginShortcutInner(args: BindPluginShortcutArgs): Promise<() => void> {
  const chord = normalizeKeyCombo(args.chord)
  const commandId = args.existingCommandId ?? `_pshortcut:${args.pluginId}:${chord}`
  if (!isTauri()) {
    const previous = browserBindings.get(chord)?.values().next().value as
      PluginShortcutBinding | undefined
    if (previous?.pluginId === args.pluginId) teardownBinding(previous)
  }

  const binding: PluginShortcutBinding = {
    pluginId: args.pluginId,
    chord,
    commandId,
    ownsCommand: !args.existingCommandId,
    desktopBound: false,
    preventDefault: args.options?.preventDefault ?? true,
  }

  let owned = bindingsByPlugin.get(args.pluginId)
  if (!owned) {
    owned = new Set()
    bindingsByPlugin.set(args.pluginId, owned)
  }
  owned.add(binding)

  if (binding.ownsCommand) {
    // `_`-prefixed so the wrapper never shows up in the tray's
    // getCommands(true) sweep — it exists purely as a dispatch handle.
    binding.disposeCommand = registerCommand({
      id: commandId,
      title: args.options?.description,
      category: "plugins",
      pluginId: args.pluginId,
      when: args.options?.when,
      handler: () => args.run?.(),
    })
  }

  const reservedOwner = getReservedPluginKeyOwner(ownershipScope, chord)
  if (reservedOwner && reservedOwner !== args.pluginId) {
    recordSilentFailure(
      args.pluginId,
      {
        site: "shortcuts.bind",
        message: `Shortcut ${chord} is reserved by ${reservedOwner}`,
        expected: true,
      },
      null
    )
  } else if (isTauri()) {
    const store = useShortcutStore.getState()
    const conflictingCommand = await store.conflictFor(chord, commandId)
    if (!owned.has(binding)) return () => {}
    const reserved = getReservedPluginKeyOwner(ownershipScope, chord)
    const owner = conflictingCommand ?? (reserved !== args.pluginId ? reserved : undefined)
    if (owner) {
      // Never override an existing (possibly user-owned) chord. The action
      // stays reachable through the palette / tray surfaces.
      recordSilentFailure(
        args.pluginId,
        {
          site: "shortcuts.bind",
          message: `Shortcut ${chord} already bound by ${owner}; plugin binding skipped`,
          expected: true,
        },
        null
      )
    } else {
      const result = await store.bind({ id: commandId, chord, scope: "global" })
      if (!owned.has(binding)) {
        // Bulk teardown can cancel an in-flight IPC; drain it before the next bind.
        if (result.ok) {
          rememberReservedPluginKey(args.pluginId, ownershipScope, chord)
          await store.unbind(commandId)
        }
        return () => {}
      }
      binding.desktopBound = result.ok
      if (result.ok) desktopBindings.set(commandId, binding)
      if (!result.ok) {
        recordSilentFailure(
          args.pluginId,
          {
            site: "shortcuts.bind",
            message: `Failed to bind shortcut ${chord}: ${result.error ?? "unknown"}`,
            expected: false,
          },
          result.error
        )
      }
    }
  } else {
    // Browser fallback — one shared ref-counted keydown listener.
    let set = browserBindings.get(chord)
    const incumbent = set?.values().next().value as PluginShortcutBinding | undefined
    if (incumbent && incumbent.pluginId !== args.pluginId) {
      recordSilentFailure(
        args.pluginId,
        {
          site: "shortcuts.bind",
          message: `Shortcut ${chord} already bound by ${incumbent.pluginId}; plugin binding skipped`,
          expected: true,
        },
        null
      )
    }
    // Re-registering an owned chord refreshes its handler. An old disposer
    // must not remove the replacement's command.
    if (!incumbent || incumbent.pluginId === args.pluginId) {
      if (!set) {
        set = new Set()
        browserBindings.set(chord, set)
      }
      set.add(binding)
      ensureBrowserListener()
    }
  }

  return () => {
    teardownBinding(binding)
  }
}

function teardownBinding(binding: PluginShortcutBinding): void {
  if (!bindingsByPlugin.get(binding.pluginId)?.delete(binding)) return
  const ownsDesktopBinding = desktopBindings.get(binding.commandId) === binding
  if (ownsDesktopBinding || browserBindings.get(binding.chord)?.has(binding)) {
    rememberReservedPluginKey(binding.pluginId, ownershipScope, binding.chord)
  }
  if (ownsDesktopBinding) {
    desktopBindings.delete(binding.commandId)
    const store = useShortcutStore.getState()
    void onDesktopRail(async () => {
      if (!desktopBindings.has(binding.commandId)) await store.unbind(binding.commandId)
    }).catch((error) => {
      loggers.plugin.warn("plugin shortcut unbind failed", {
        pluginId: binding.pluginId,
        error: String(error),
      })
    })
  }
  const set = browserBindings.get(binding.chord)
  if (set) {
    set.delete(binding)
    if (set.size === 0) browserBindings.delete(binding.chord)
  }
  maybeRemoveBrowserListener()
  if (binding.ownsCommand) {
    binding.disposeCommand?.()
  }
}

/** Bulk teardown for plugin disable/unload. Returns the count removed. */
export function unbindAllPluginShortcuts(pluginId: string): number {
  desktopEpochs.delete(pluginId)
  const owned = bindingsByPlugin.get(pluginId)
  if (!owned) return 0
  const list = [...owned]
  for (const binding of list) teardownBinding(binding)
  bindingsByPlugin.delete(pluginId)
  return list.length
}

/** Chords currently registered by `pluginId` (for ctx.shortcuts.getRegistered). */
export function listPluginShortcuts(pluginId: string): string[] {
  return [...(bindingsByPlugin.get(pluginId) ?? [])].map((b) => b.chord)
}

/** Test-only escape hatch. */
export function __resetPluginShortcutBridgeForTesting(): void {
  for (const pluginId of [...bindingsByPlugin.keys()]) {
    unbindAllPluginShortcuts(pluginId)
  }
  bindingsByPlugin.clear()
  browserBindings.clear()
  desktopBindings.clear()
  desktopEpochs.clear()
  if (keydownListener && typeof window !== "undefined") {
    window.removeEventListener("keydown", keydownListener)
    keydownListener = null
  }
}
