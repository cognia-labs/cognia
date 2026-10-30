/**
 * Renderer side of VS Code extensions' terminals: each one is a tab in the
 * terminal dock.
 *
 *   - A process terminal is a dock PTY spawned for the extension (its
 *     `terminal:spawn` permission), tagged with its id and named as it asked;
 *     `sendText` writes into it (`terminal:write`).
 *   - An extension terminal (`Pseudoterminal`) is an `ExtensionPtySession`:
 *     what the extension writes is pushed into the tab, and what the user
 *     types and the tab's size are sent back to it.
 *
 * The host learns which of its terminals is the dock's active tab, the first
 * time the user types into one, and how each one ended: closed by the user,
 * by the extension (`dispose`), or by itself (the process exited, or the
 * `Pseudoterminal` closed).
 *
 * When an extension's host stops, its extension terminals close with it; its
 * process terminals stay open in the dock for the user, no longer tracked.
 */

import { loggers } from "@cognia/logging"

import { listPluginPermissions } from "@/lib/plugin/core/transport"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type { BaseTerminalSession } from "@/lib/terminal/base-session"
import {
  getLiveSession,
  registerLiveSession,
  unregisterLiveSession,
} from "@/lib/terminal/session-registry"
import { killFromDock, spawnFromDock, wireSessionToStore } from "@/lib/terminal/spawn-orchestrator"
import type { TabColorPreset } from "@/lib/terminal/tab-appearance"
import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { isTauri } from "@/lib/native/utils"

import { ExtensionPtySession } from "./extension-pty-session"
import { listProjectWorkspaceFolders } from "./lsp-workspace-manager"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"

const log = loggers.plugin.child("vscode-terminals")

/** VS Code's `TerminalExitReason`. */
export const TERMINAL_EXIT_REASON = { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 }

/** The size an extension terminal opens with, before its tab reports one. */
export const INITIAL_DIMENSIONS = { columns: 80, rows: 24 }

/** `ThemeColor` ids VS Code extensions give terminals → the dock's tab colors. */
const TAB_COLORS: Record<string, TabColorPreset> = {
  "terminal.ansiRed": "red",
  "terminal.ansiBrightRed": "red",
  "terminal.ansiGreen": "green",
  "terminal.ansiBrightGreen": "green",
  "terminal.ansiYellow": "yellow",
  "terminal.ansiBrightYellow": "yellow",
  "terminal.ansiBlue": "blue",
  "terminal.ansiBrightBlue": "blue",
  "terminal.ansiMagenta": "purple",
  "terminal.ansiBrightMagenta": "purple",
  "terminal.ansiCyan": "cyan",
  "terminal.ansiBrightCyan": "cyan",
}

export interface VscodeTerminalSpawn {
  profileLaunchId?: string
  pluginId: string
  name?: string
  shell: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  projectId?: string
}

export interface VscodeTerminalDependencies {
  localProfileTarget(): boolean
  wantsEnabled(pluginId: string): Promise<boolean>
  activateProfile(id: string): Promise<void>
  callProvider(
    pluginId: string,
    method: string,
    payload: unknown,
    signal: AbortSignal
  ): Promise<unknown>
  permissions(pluginId: string): Promise<readonly string[]>
  /**
   * Spawn a dock PTY for the extension; resolves with the new session's id,
   * tab title and, when the host reports one, its process id.
   */
  spawn(
    request: VscodeTerminalSpawn
  ): Promise<{ sessionId: string; title: string; processId?: number }>
  /** Give an extension terminal a dock tab. */
  addPtySession(session: ExtensionPtySession, title: string): void
  session(sessionId: string): BaseTerminalSession | undefined
  /** Close a tab, ending what runs in it. */
  kill(sessionId: string): Promise<void>
  /** Drop a finished tab whose session already ended. */
  remove(sessionId: string): void
  hasTab(sessionId: string): boolean
  /** The active tab in the dock's current project. */
  activeSessionId(): string | null
  activeProjectId(): string | null
  /** Make `sessionId` the active tab of its project (or none), without opening the dock. */
  setActive(projectId: string | null, sessionId: string | null): void
  /** Open the dock on `sessionId`. */
  show(sessionId: string): void
  /** Close the dock if it is showing `sessionId`. */
  hide(sessionId: string): void
  setTitle(sessionId: string, title: string): void
  setColor(sessionId: string, color: TabColorPreset): void
  /** The folder a terminal opens in when the extension names none. */
  defaultCwd(): string | undefined
  /** Run `listener` when the dock's tabs or active tab change. */
  subscribe(listener: () => void): () => void
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
}

export function createVscodeTerminalDependencies(input: {
  sendToHost: VscodeTerminalDependencies["sendToHost"]
}): VscodeTerminalDependencies {
  const store = () => useTerminalStore.getState()
  return {
    ...input,
    localProfileTarget: () => isTauri() && useRemoteHostStore.getState().activeHostId === null,
    wantsEnabled: async (pluginId) => {
      if (!usePluginStore.getState().plugins[pluginId]) return false
      return (
        (
          await (
            await import("@/lib/plugin/core/manager")
          )
            .getPluginManager()
            .getPluginLifecycleState(pluginId)
        ).intent !== "disabled"
      )
    },
    activateProfile: async (id) =>
      (await import("@/lib/plugin/core/manager"))
        .getPluginManager()
        .handleActivationEvent(`onTerminalProfile:${id}`),
    callProvider: async (...args) =>
      (await import("@/lib/plugin/core/vscode-loader")).callVscodeProvider(...args),
    permissions: (pluginId) => listPluginPermissions(pluginId),
    async spawn(request) {
      const outcome = await spawnFromDock({
        req: {
          shell: request.shell,
          args: request.args,
          cwd: request.cwd,
          env: request.env,
          projectId: request.projectId,
          extensionId: request.pluginId,
          rows: INITIAL_DIMENSIONS.rows,
          cols: INITIAL_DIMENSIONS.columns,
          enableShellIntegration: true,
        },
        store: store(),
        ...(request.profileLaunchId
          ? {
              spawn: async (req: import("@/lib/terminal/types").SpawnRequest) => {
                assertProfileLaunch(request.pluginId, request.profileLaunchId!)
                const { TerminalSession } = await import("@/lib/terminal/session")
                assertProfileLaunch(request.pluginId, request.profileLaunchId!)
                return TerminalSession.spawn(req)
              },
            }
          : {}),
        ...(request.name ? { title: request.name } : {}),
      })
      if (outcome.kind === "denied") {
        throw new Error(
          `A terminal policy denied the terminal${outcome.reason ? `: ${outcome.reason}` : ""}`
        )
      }
      if (outcome.kind === "error") throw new Error(outcome.message)
      const processId = getLiveSession(outcome.sessionId)?.info.processId
      return {
        sessionId: outcome.sessionId,
        title: store().sessions[outcome.sessionId]?.title ?? outcome.shell,
        ...(typeof processId === "number" ? { processId } : {}),
      }
    },
    addPtySession(session, title) {
      // As `connectSerialFromDock` does for a serial port.
      const hooks = getPluginEventHooks()
      registerLiveSession(session)
      store().registerSession(session.info, { title })
      wireSessionToStore(session, store(), hooks)
      hooks.dispatchTerminalLifecycle({
        kind: "spawned",
        sessionId: session.info.id,
        projectId: session.info.projectId,
        extensionId: session.info.extensionId,
      })
    },
    session: (sessionId) => getLiveSession(sessionId),
    kill: (sessionId) => killFromDock(sessionId, store()),
    remove(sessionId) {
      unregisterLiveSession(sessionId)
      store().removeSession(sessionId)
    },
    hasTab: (sessionId) => sessionId in store().sessions,
    activeSessionId: () =>
      store().getActiveSession(useProjectStore.getState().activeProjectId ?? null),
    activeProjectId: () => useProjectStore.getState().activeProjectId ?? null,
    setActive: (projectId, sessionId) => store().setActiveSession(projectId, sessionId),
    show(sessionId) {
      const row = store().sessions[sessionId]
      if (!row) return
      store().setActiveSession(row.projectId, sessionId)
      store().setPanelOpen(true)
    },
    hide(sessionId) {
      const row = store().sessions[sessionId]
      if (!row || !store().panelOpen) return
      if (store().getActiveSession(row.projectId) === sessionId) store().setPanelOpen(false)
    },
    setTitle: (sessionId, title) => store().setSessionTitle(sessionId, title),
    setColor: (sessionId, color) => store().setTabAppearance(sessionId, { color }),
    defaultCwd: () => listProjectWorkspaceFolders()[0]?.path,
    subscribe(listener) {
      const stopTerminals = useTerminalStore.subscribe(listener)
      const stopProjects = useProjectStore.subscribe(listener)
      return () => {
        stopTerminals()
        stopProjects()
      }
    },
  }
}

interface Tracked {
  profileLaunchId?: string
  pluginId: string
  terminalId: string
  sessionId: string
  kind: "process" | "pty"
  /** The extension disposed it. */
  disposed: boolean
  /** The extension's `Pseudoterminal` closed itself. */
  ended: boolean
  interacted: boolean
  /** `sendText` is writing: what the session receives now is not the user's. */
  sending: boolean
  stops: Array<() => void>
}

let deps: VscodeTerminalDependencies | null = null
let stopWatching: (() => void) | null = null
/** `plugin\u0000terminal` → its tab. */
const terminals = new Map<string, Tracked>()
/** Per extension, the active terminal it was last told. */
const reportedActive = new Map<string, string | null>()
const profileProviders = new Map<string, { pluginId: string; id: string; token: string }>()
const profileListeners = new Set<() => void>()
const profileLaunches = new Map<
  string,
  {
    pluginId: string
    id: string
    projectId: string | null
    token?: string
    controller: AbortController
  }
>()

export interface VscodeTerminalProfileDescriptor {
  pluginId: string
  id: string
  title: string
}
const profileKey = (pluginId: string, id: string) => JSON.stringify([pluginId, id])
const profilesChanged = () => {
  for (const listener of profileListeners) listener()
}

export function subscribeVscodeTerminalProfiles(listener: () => void): () => void {
  profileListeners.add(listener)
  const stopPlugins = usePluginStore.subscribe(listener)
  return () => {
    profileListeners.delete(listener)
    stopPlugins()
  }
}

export async function listVscodeTerminalProfiles(): Promise<VscodeTerminalProfileDescriptor[]> {
  if (!deps && (!isTauri() || useRemoteHostStore.getState().activeHostId !== null)) return []
  const d = profileDependencies()
  if (!d.localProfileTarget()) return []
  const declared = Object.values(usePluginStore.getState().plugins).flatMap((plugin) =>
    (plugin.manifest.vscodeExtension?.terminalProfiles ?? []).map((profile) => ({
      pluginId: plugin.manifest.id,
      id: profile.id,
      title: profile.title ?? profile.id,
    }))
  )
  const combined = new Map(
    declared.map((profile) => [profileKey(profile.pluginId, profile.id), profile])
  )
  for (const provider of profileProviders.values())
    if (!combined.has(profileKey(provider.pluginId, provider.id)))
      combined.set(profileKey(provider.pluginId, provider.id), { ...provider, title: provider.id })
  const available = await Promise.all(
    [...combined.values()].map(async (profile) =>
      (await d.wantsEnabled(profile.pluginId)) ? profile : undefined
    )
  )
  return available.filter((profile): profile is VscodeTerminalProfileDescriptor => Boolean(profile))
}

function assertProfileLaunch(pluginId: string, launchId: string): void {
  const launch = profileLaunches.get(launchId)
  if (
    !launch ||
    launch.pluginId !== pluginId ||
    launch.controller.signal.aborted ||
    !requireDeps().localProfileTarget() ||
    launch.projectId !== requireDeps().activeProjectId()
  )
    throw new Error("Terminal profile launch was cancelled or its local workspace target changed")
}

/** Discovery must work before the first dormant extension loads the shared RPC services. */
function profileDependencies(): VscodeTerminalDependencies {
  if (!deps)
    configureVscodeTerminals(
      createVscodeTerminalDependencies({
        sendToHost: async (...args) =>
          (await import("@/lib/plugin/core/vscode-loader")).invokeVscodeRpc(...args),
      })
    )
  return requireDeps()
}

export async function openVscodeTerminalProfile(
  pluginId: string,
  id: string,
  signal?: AbortSignal
): Promise<string> {
  const d = profileDependencies()
  if (!d.localProfileTarget())
    throw new Error("Extension terminal profiles require the local desktop Host")
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const launchId = globalThis.crypto.randomUUID()
  const launch = {
    pluginId,
    id,
    projectId: d.activeProjectId(),
    controller,
    token: undefined as string | undefined,
  }
  profileLaunches.set(launchId, launch)
  const timer = setTimeout(
    () => controller.abort(new DOMException("Terminal profile timed out", "TimeoutError")),
    30_000
  )
  let succeeded = false
  try {
    if (!(await d.wantsEnabled(pluginId)))
      throw new Error("Terminal profile owner is disabled or unavailable")
    await requirePermission(pluginId, "terminal:spawn")
    assertProfileLaunch(pluginId, launchId)
    await d.activateProfile(id)
    assertProfileLaunch(pluginId, launchId)
    if (!(await d.wantsEnabled(pluginId))) throw new Error("Terminal profile owner was disabled")
    const provider = profileProviders.get(profileKey(pluginId, id))
    if (!provider) throw new Error(`No terminal profile provider registered for ${id}`)
    launch.token = provider.token
    const result = (await d.callProvider(
      pluginId,
      "provideTerminalProfile",
      { token: provider.token, profileLaunchId: launchId },
      controller.signal
    )) as { terminalId?: unknown } | null
    assertProfileLaunch(pluginId, launchId)
    if (
      profileProviders.get(profileKey(pluginId, id)) !== provider ||
      !(await d.wantsEnabled(pluginId))
    )
      throw new Error("Terminal profile provider was removed")
    assertProfileLaunch(pluginId, launchId)
    const terminal =
      typeof result?.terminalId === "string"
        ? terminals.get(keyOf(pluginId, result.terminalId))
        : undefined
    if (!terminal || terminal.profileLaunchId !== launchId || !d.hasTab(terminal.sessionId))
      throw new Error("Terminal profile did not create a terminal")
    d.show(terminal.sessionId)
    succeeded = true
    return terminal.sessionId
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    if (!succeeded) {
      controller.abort()
      for (const entry of terminals.values())
        if (entry.profileLaunchId === launchId) {
          try {
            await d.kill(entry.sessionId)
          } catch (error) {
            log.warn("Failed to close a cancelled terminal profile", { error })
          }
        }
    }
    profileLaunches.delete(launchId)
  }
}

const keyOf = (pluginId: string, terminalId: string) => `${pluginId}\u0000${terminalId}`

function requireDeps(): VscodeTerminalDependencies {
  if (!deps) throw new Error("VS Code terminals are not available yet")
  return deps
}

export function configureVscodeTerminals(next: VscodeTerminalDependencies | null): void {
  stopWatching?.()
  stopWatching = null
  deps = next
  if (next) stopWatching = next.subscribe(() => watchDock())
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  const value = payload as Record<string, unknown>
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== "string" || !result) {
    throw new Error(`VS Code RPC payload requires non-empty ${field}`)
  }
  return result
}

async function requirePermission(pluginId: string, permission: string): Promise<void> {
  const granted = await requireDeps().permissions(pluginId)
  if (!granted.includes(permission)) {
    throw new Error(`VS Code extension ${pluginId} requires permission ${permission}`)
  }
}

function tracked(value: Record<string, unknown>, context: RpcContext): Tracked {
  const terminalId = requiredString(value, "terminalId")
  const entry = terminals.get(keyOf(context.pluginId, terminalId))
  if (!entry) throw new Error(`Terminal ${terminalId} has ended`)
  return entry
}

function notify(pluginId: string, method: string, payload: Record<string, unknown>): void {
  void requireDeps()
    .sendToHost(pluginId, method, payload)
    .catch((error: unknown) => {
      log.debug("terminal report not delivered", {
        pluginId,
        method,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

/** Tell the host how a terminal ended, once, and stop tracking it. */
function ended(entry: Tracked, code: number | null, reason: number): void {
  const key = keyOf(entry.pluginId, entry.terminalId)
  if (terminals.get(key) !== entry) return
  terminals.delete(key)
  for (const stop of entry.stops.splice(0)) stop()
  notify(entry.pluginId, "terminal:closed", {
    terminalId: entry.terminalId,
    ...(code !== null ? { code } : {}),
    reason,
  })
  watchDock()
}

function reasonOf(entry: Tracked): number {
  if (entry.disposed) return TERMINAL_EXIT_REASON.Extension
  if (entry.ended) return TERMINAL_EXIT_REASON.Process
  // Otherwise only the dock ends an extension terminal: the user closed it.
  if (entry.kind === "pty") return TERMINAL_EXIT_REASON.User
  // A closed tab is gone; a process that exited leaves its tab showing so.
  return requireDeps().hasTab(entry.sessionId)
    ? TERMINAL_EXIT_REASON.Process
    : TERMINAL_EXIT_REASON.User
}

function markInteracted(entry: Tracked): void {
  if (entry.interacted) return
  entry.interacted = true
  notify(entry.pluginId, "terminal:interacted", { terminalId: entry.terminalId })
}

/** Follow the session's end, and (for a process terminal) the user's typing. */
function follow(entry: Tracked, session: BaseTerminalSession): void {
  entry.stops.push(
    session.onExit((code) => {
      // The dock removes a closed tab right after killing its session; wait
      // for that so a tab the user closed is not taken for a process exit.
      setTimeout(() => ended(entry, code, reasonOf(entry)), 0)
    })
  )
  if (entry.kind !== "process") return
  const write = session.write
  const wrapped: typeof session.write = (data) => {
    if (!entry.sending) markInteracted(entry)
    return write.call(session, data)
  }
  ;(session as { write: typeof session.write }).write = wrapped
  entry.stops.push(() => {
    if (session.write === wrapped) (session as { write: typeof session.write }).write = write
  })
}

/** Report each extension's active terminal when it changes; notice tabs closed without an exit. */
function watchDock(): void {
  const d = deps
  if (!d) return
  for (const entry of [...terminals.values()]) {
    if (!d.hasTab(entry.sessionId) && !d.session(entry.sessionId)) {
      ended(entry, null, reasonOf(entry))
    }
  }
  const activeSession = d.activeSessionId()
  const plugins = new Set([
    ...reportedActive.keys(),
    ...[...terminals.values()].map((t) => t.pluginId),
  ])
  for (const pluginId of plugins) {
    const active =
      [...terminals.values()].find(
        (entry) => entry.pluginId === pluginId && entry.sessionId === activeSession
      )?.terminalId ?? null
    if ((reportedActive.get(pluginId) ?? null) === active) continue
    reportedActive.set(pluginId, active)
    notify(pluginId, "terminal:activeChanged", { terminalId: active })
  }
}

async function createProcessTerminal(
  pluginId: string,
  terminalId: string,
  value: Record<string, unknown>
): Promise<{ name: string; processId?: number }> {
  const d = requireDeps()
  const name = typeof value.name === "string" && value.name ? value.name : undefined
  if (value.strictEnv === true || Array.isArray(value.unsetEnv)) {
    appendVscodeLog(pluginId, {
      level: "warn",
      kind: "terminal",
      message: `Terminal "${name ?? terminalId}": strictEnv and unsetting variables are not supported; the shell inherits the app's environment`,
    })
  }
  const env =
    value.env && typeof value.env === "object" && !Array.isArray(value.env)
      ? Object.fromEntries(
          Object.entries(value.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined
  const projectId = d.activeProjectId()
  const previous = d.activeSessionId()
  const { sessionId, title, processId } = await d.spawn({
    pluginId,
    ...(typeof value.profileLaunchId === "string"
      ? { profileLaunchId: value.profileLaunchId }
      : {}),
    name,
    shell: typeof value.shellPath === "string" ? value.shellPath : "",
    args: Array.isArray(value.shellArgs) ? value.shellArgs.map(String) : undefined,
    cwd: typeof value.cwd === "string" && value.cwd ? value.cwd : d.defaultCwd(),
    env,
    projectId: projectId ?? undefined,
  })
  if (typeof value.profileLaunchId === "string") {
    try {
      assertProfileLaunch(pluginId, value.profileLaunchId)
    } catch (error) {
      await d.kill(sessionId)
      throw error
    }
  }
  const entry: Tracked = {
    pluginId,
    ...(typeof value.profileLaunchId === "string"
      ? { profileLaunchId: value.profileLaunchId }
      : {}),
    terminalId,
    sessionId,
    kind: "process",
    disposed: false,
    ended: false,
    interacted: false,
    sending: false,
    stops: [],
  }
  terminals.set(keyOf(pluginId, terminalId), entry)
  const session = d.session(sessionId)
  if (session) follow(entry, session)
  if (value.hideFromUser === true) d.setActive(projectId, previous)
  applyColor(sessionId, value.color)
  watchDock()
  // `Terminal.processId` in the host; undefined when the host reported none.
  return { name: name ?? title, ...(processId === undefined ? {} : { processId }) }
}

function createPtyTerminal(
  pluginId: string,
  terminalId: string,
  value: Record<string, unknown>
): { dimensions: typeof INITIAL_DIMENSIONS } {
  const d = requireDeps()
  const name = typeof value.name === "string" ? value.name : ""
  const entry: Tracked = {
    pluginId,
    terminalId,
    sessionId: "",
    ...(typeof value.profileLaunchId === "string"
      ? { profileLaunchId: value.profileLaunchId }
      : {}),
    kind: "pty",
    disposed: false,
    ended: false,
    interacted: false,
    sending: false,
    stops: [],
  }
  const session = new ExtensionPtySession(
    { extensionId: pluginId, name, projectId: d.activeProjectId() },
    {
      onInput: (data) => {
        markInteracted(entry)
        notify(pluginId, "terminal:ptyInput", { terminalId, data })
      },
      onResize: (columns, rows) =>
        notify(pluginId, "terminal:ptyResize", { terminalId, columns, rows }),
      onKill: () => undefined,
    }
  )
  entry.sessionId = session.id
  terminals.set(keyOf(pluginId, terminalId), entry)
  d.addPtySession(session, name)
  follow(entry, session)
  applyColor(session.id, value.color)
  watchDock()
  return { dimensions: INITIAL_DIMENSIONS }
}

function applyColor(sessionId: string, color: unknown): void {
  const preset = typeof color === "string" ? TAB_COLORS[color] : undefined
  if (preset) requireDeps().setColor(sessionId, preset)
}

export function installVscodeTerminalHandlers(): Array<() => void> {
  return [
    registerMethod("terminal:registerProfile", (payload, context) => {
      const value = owned(payload, context)
      const id = requiredString(value, "id")
      const key = profileKey(context.pluginId, id)
      if (profileProviders.has(key)) throw new Error(`Terminal profile ${id} is already registered`)
      profileProviders.set(key, {
        pluginId: context.pluginId,
        id,
        token: requiredString(value, "token"),
      })
      profilesChanged()
      return null
    }),
    registerMethod("terminal:unregisterProfile", (payload, context) => {
      const value = owned(payload, context)
      const id = requiredString(value, "id")
      const provider = profileProviders.get(profileKey(context.pluginId, id))
      if (provider?.token !== requiredString(value, "token")) return null
      profileProviders.delete(profileKey(context.pluginId, id))
      for (const launch of profileLaunches.values())
        if (launch.pluginId === context.pluginId && launch.id === id) launch.controller.abort()
      profilesChanged()
      return null
    }),
    registerMethod("terminal:create", async (payload, context) => {
      const value = owned(payload, context)
      const terminalId = requiredString(value, "terminalId")
      if (terminals.has(keyOf(context.pluginId, terminalId))) {
        throw new Error(`Terminal ${terminalId} already exists`)
      }
      await requirePermission(context.pluginId, "terminal:spawn")
      if (value.profileLaunchId !== undefined) {
        assertProfileLaunch(context.pluginId, requiredString(value, "profileLaunchId"))
      }
      return value.kind === "pty"
        ? createPtyTerminal(context.pluginId, terminalId, value)
        : createProcessTerminal(context.pluginId, terminalId, value)
    }),
    registerMethod("terminal:sendText", async (payload, context) => {
      const value = owned(payload, context)
      const entry = tracked(value, context)
      if (typeof value.data !== "string") throw new Error("terminal:sendText needs data")
      await requirePermission(context.pluginId, "terminal:write")
      const session = requireDeps().session(entry.sessionId)
      if (!session) throw new Error(`Terminal ${entry.terminalId} has ended`)
      entry.sending = true
      const writing = session.write(value.data)
      entry.sending = false
      await writing
      return null
    }),
    registerMethod("terminal:show", (payload, context) => {
      requireDeps().show(tracked(owned(payload, context), context).sessionId)
      return null
    }),
    registerMethod("terminal:hide", (payload, context) => {
      requireDeps().hide(tracked(owned(payload, context), context).sessionId)
      return null
    }),
    registerMethod("terminal:dispose", async (payload, context) => {
      const value = owned(payload, context)
      const terminalId = requiredString(value, "terminalId")
      const entry = terminals.get(keyOf(context.pluginId, terminalId))
      // Already gone: disposing twice, or after the user closed it.
      if (!entry) return null
      entry.disposed = true
      await requireDeps().kill(entry.sessionId)
      return null
    }),
    registerMethod("terminal:rename", (payload, context) => {
      const value = owned(payload, context)
      const entry = tracked(value, context)
      requireDeps().setTitle(entry.sessionId, requiredString(value, "name"))
      return null
    }),
    registerMethod("terminal:ptyWrite", (payload, context) => {
      const value = owned(payload, context)
      const entry = tracked(value, context)
      const session = requireDeps().session(entry.sessionId)
      if (session instanceof ExtensionPtySession && typeof value.data === "string") {
        session.push(value.data)
      }
      return null
    }),
    registerMethod("terminal:ptyClose", (payload, context) => {
      const value = owned(payload, context)
      const entry = tracked(value, context)
      const code = typeof value.code === "number" ? value.code : null
      entry.ended = true
      const d = requireDeps()
      ended(entry, code, TERMINAL_EXIT_REASON.Process)
      const session = d.session(entry.sessionId)
      if (session instanceof ExtensionPtySession) session.finish(code)
      // As in VS Code, a terminal that ended well closes; a failure stays to be read.
      if (!code) d.remove(entry.sessionId)
      return null
    }),
  ]
}

/** The extension's host stopped: its extension terminals end; its shells stay with the user. */
export function clearVscodeTerminalsForPlugin(pluginId: string): void {
  for (const [key, provider] of profileProviders)
    if (provider.pluginId === pluginId) profileProviders.delete(key)
  for (const launch of profileLaunches.values())
    if (launch.pluginId === pluginId) launch.controller.abort()
  profilesChanged()
  reportedActive.delete(pluginId)
  for (const [key, entry] of [...terminals]) {
    if (entry.pluginId !== pluginId) continue
    terminals.delete(key)
    for (const stop of entry.stops.splice(0)) stop()
    if (entry.kind === "pty" && deps) void deps.kill(entry.sessionId).catch(() => undefined)
  }
}

export function __resetVscodeTerminalsForTesting(): void {
  for (const launch of profileLaunches.values()) launch.controller.abort()
  profileLaunches.clear()
  profileProviders.clear()
  profileListeners.clear()
  for (const entry of terminals.values()) for (const stop of entry.stops) stop()
  terminals.clear()
  reportedActive.clear()
  configureVscodeTerminals(null)
}
