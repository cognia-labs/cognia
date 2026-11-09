"use client"

import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  DEFAULT_UPDATE_SETTINGS,
  type UpdateChannel,
  type UpdateSettings,
} from "@cognia/agent-config-types"

import { isTauri } from "@/lib/tauri"
import { isProxyActive } from "@/lib/network/proxy-config"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { loggers } from "@cognia/logging"
import { isValidRolloutBucket, normalizeRolloutBucket } from "./update-cohort"

/** Policy shared by native discovery and every manual entry point. */
export interface UpdateCheckOptions {
  channel: UpdateChannel
  rolloutBucket: number
  manual?: boolean
}

/**
 * Establish one cohort synchronously, then persist it just like the coordinator.
 * This lives in the foundation so the native bridge never imports lib/updates.
 */
export function getUpdateCheckOptions(): UpdateCheckOptions {
  const state = useSettingsStore.getState()
  if (state.loaded === false || !state.settings) {
    throw new Error("PROXY_NOT_INITIALIZED: updater routing policy is still loading")
  }
  const center = { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...state.settings.updateCenter }
  const rolloutBucket = normalizeRolloutBucket(center.rolloutBucket)
  if (rolloutBucket !== center.rolloutBucket) {
    useSettingsStore.setState({
      settings: { ...state.settings, updateCenter: { ...center, rolloutBucket } },
    })
    // Merge only the cohort into the persisted row: a whole `updateCenter`
    // copied from memory would overwrite snapshots the Update Center is
    // writing concurrently. A cohort generated elsewhere first wins.
    void saveSettings(
      (current) => {
        const persisted = { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...current.updateCenter }
        if (isValidRolloutBucket(persisted.rolloutBucket)) return {}
        return { updateCenter: { ...persisted, rolloutBucket } }
      },
      { mirrorToHost: false }
    ).catch((error: unknown) => {
      loggers.app.warn("update cohort persistence failed", { error: String(error) })
    })
  }
  return { channel: center.channel, rolloutBucket }
}

/** Available update surfaced to the UI. */
export interface AvailableUpdate {
  version: string
  body?: string
  date?: string
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }

interface DownloadOptions {
  timeout?: number
}

type CheckOptions = DownloadOptions

/** Structural subset of the Tauri updater resource used by this module. */
interface UpdateHandle {
  version: string
  body?: string
  date?: string
  download: (onEvent?: (event: DownloadEvent) => void, options?: DownloadOptions) => Promise<void>
  install: () => Promise<void>
  close?: () => Promise<void>
}

export interface UpdateProgress {
  downloaded: number
  total?: number
}

export type UpdateProgressHandler = (progress: UpdateProgress) => void

export type UpdatePhase = "check" | "download" | "install" | "relaunch"
export type UpdateErrorCode =
  | "permission"
  | "timeout"
  | "signature"
  | "network"
  | "download"
  | "install"
  | "relaunch"
  | "unknown"

/** Stable error contract shared by the About card and background initializer. */
export class AppUpdateError extends Error {
  readonly code: UpdateErrorCode
  readonly phase: UpdatePhase
  readonly cause: unknown

  constructor(code: UpdateErrorCode, phase: UpdatePhase, message: string, cause: unknown) {
    super(message)
    this.name = "AppUpdateError"
    this.code = code
    this.phase = phase
    this.cause = cause
  }
}

/** Narrow a classified updater failure without coupling callers to message text. */
export function isUpdateErrorPhase(error: unknown, phase: UpdatePhase): error is AppUpdateError {
  return error instanceof AppUpdateError && error.phase === phase
}

const PENDING_UPDATE_TTL_MS = 10 * 60 * 1000
const MIN_CHECK_INTERVAL_MINUTES = 15
const MAX_CHECK_INTERVAL_MINUTES = 7 * 24 * 60
const MIN_REQUEST_TIMEOUT_SECONDS = 5
const MAX_REQUEST_TIMEOUT_SECONDS = 5 * 60

let pendingUpdate: UpdateHandle | null = null
let pendingUpdateAt = 0
let pendingPolicy: string | null = null
let checkPolicy: string | null = null
let lastCheckOptions: UpdateCheckOptions | undefined
let pendingDownloaded = false
let installedVersionAwaitingRestart: string | null = null
const installedRestartListeners = new Set<() => void>()
let checkInFlight: Promise<AvailableUpdate | null> | null = null
let downloadInFlight: Promise<DownloadUpdateResult> | null = null
let installInFlight: Promise<InstallUpdateResult> | null = null

function setInstalledVersionAwaitingRestart(version: string | null): void {
  if (installedVersionAwaitingRestart === version) return
  installedVersionAwaitingRestart = version
  for (const listener of installedRestartListeners) listener()
}

/** Current installed version that still requires this process to restart. */
export function getInstalledVersionAwaitingRestart(): string | null {
  return installedVersionAwaitingRestart
}

/** Subscribe UI surfaces to the shared installed-pending-restart state. */
export function subscribeInstalledVersionAwaitingRestart(listener: () => void): () => void {
  installedRestartListeners.add(listener)
  return () => installedRestartListeners.delete(listener)
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Merge forward and validate updater preferences loaded from older settings rows. */
export function resolveUpdateSettings(raw?: Partial<UpdateSettings> | null): UpdateSettings {
  return {
    autoCheck: raw?.autoCheck ?? DEFAULT_UPDATE_SETTINGS.autoCheck,
    checkIntervalMinutes: clampInteger(
      raw?.checkIntervalMinutes,
      DEFAULT_UPDATE_SETTINGS.checkIntervalMinutes,
      MIN_CHECK_INTERVAL_MINUTES,
      MAX_CHECK_INTERVAL_MINUTES
    ),
    autoDownload: raw?.autoDownload ?? DEFAULT_UPDATE_SETTINGS.autoDownload,
    relaunchAfterInstall: raw?.relaunchAfterInstall ?? DEFAULT_UPDATE_SETTINGS.relaunchAfterInstall,
    requestTimeoutSeconds: clampInteger(
      raw?.requestTimeoutSeconds,
      DEFAULT_UPDATE_SETTINGS.requestTimeoutSeconds,
      MIN_REQUEST_TIMEOUT_SECONDS,
      MAX_REQUEST_TIMEOUT_SECONDS
    ),
    useProxy: raw?.useProxy ?? DEFAULT_UPDATE_SETTINGS.useProxy,
  }
}

function currentUpdateSettings(): UpdateSettings {
  const store = useSettingsStore as typeof useSettingsStore & {
    getState?: () => { settings?: { updates?: Partial<UpdateSettings> } | null }
  }
  return resolveUpdateSettings(store.getState?.().settings?.updates)
}

function requestOptions(): { check: CheckOptions; download: DownloadOptions } {
  const store = useSettingsStore as typeof useSettingsStore & {
    getState?: () => {
      loaded?: boolean
      settings?: {
        updates?: Partial<UpdateSettings>
        networkProxy?: Parameters<typeof isProxyActive>[0]
      } | null
    }
  }
  const state = store.getState?.()
  if (state?.loaded === false) {
    throw new Error("PROXY_NOT_INITIALIZED: updater routing policy is still loading")
  }

  const settings = resolveUpdateSettings(state?.settings?.updates)
  const timeout = settings.requestTimeoutSeconds * 1000
  const activeGlobalProxy = isProxyActive(state?.settings?.networkProxy)
  if (!activeGlobalProxy) {
    return { check: { timeout }, download: { timeout } }
  }
  if (!settings.useProxy) {
    throw new Error(
      "PROXY_TRANSPORT_UNSUPPORTED: updater proxy use is disabled while the global proxy is active"
    )
  }

  // The native host mirrors its keyring-hydrated policy into the updater
  // plugin's process environment. Keeping the endpoint out of renderer IPC is
  // required for authenticated proxies.
  return { check: { timeout }, download: { timeout } }
}

function availableFromHandle(handle: UpdateHandle | null): AvailableUpdate | null {
  if (!handle) return null
  return { version: handle.version, body: handle.body, date: handle.date }
}

async function closeHandle(handle: UpdateHandle | null): Promise<void> {
  if (!handle?.close) return
  try {
    await handle.close()
  } catch {
    // Resource cleanup must not mask a successful check/install result.
  }
}

async function replacePendingUpdate(
  handle: UpdateHandle | null,
  policy: string | null = null
): Promise<void> {
  const previous = pendingUpdate
  pendingUpdate = handle
  pendingPolicy = handle ? policy : null
  pendingUpdateAt = handle ? Date.now() : 0
  pendingDownloaded = false
  if (previous && previous !== handle) await closeHandle(previous)
}

function classifyError(error: unknown, phase: UpdatePhase): AppUpdateError {
  if (error instanceof AppUpdateError) return error
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  let code: UpdateErrorCode
  if (normalized.includes("proxy_")) {
    code = "network"
  } else if (
    normalized.includes("not allowed") ||
    normalized.includes("permission") ||
    normalized.includes("capability") ||
    normalized.includes("acl")
  ) {
    code = "permission"
  } else if (normalized.includes("timed out") || normalized.includes("timeout")) {
    code = "timeout"
  } else if (
    normalized.includes("signature") ||
    normalized.includes("public key") ||
    normalized.includes("minisign")
  ) {
    code = "signature"
  } else if (
    normalized.includes("network") ||
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("offline") ||
    normalized.includes("dns") ||
    normalized.includes("connection")
  ) {
    code = "network"
  } else if (phase === "download") {
    code = "download"
  } else if (phase === "install") {
    code = "install"
  } else if (phase === "relaunch") {
    code = "relaunch"
  } else {
    code = "unknown"
  }
  return new AppUpdateError(code, phase, message, error)
}

function policyKey(options: UpdateCheckOptions): string {
  return `${options.channel}:${options.manual ? 0 : options.rolloutBucket}`
}

/**
 * Check the signed release endpoint once. Concurrent callers share the same
 * policy's request; active downloads and installs retain their native resource.
 */
function startCheck(options: UpdateCheckOptions): Promise<AvailableUpdate | null> {
  const policy = policyKey(options)
  if (checkInFlight) {
    if (checkPolicy === policy) return checkInFlight
    // A consumer may start a download as the preceding check resolves. Re-enter
    // the public guard before switching policy so that resource stays protected.
    return checkInFlight.catch(() => undefined).then(() => checkForUpdate(options))
  }
  lastCheckOptions = { ...options }
  checkPolicy = policy

  const task = (async () => {
    try {
      const { Update } = await import("@tauri-apps/plugin-updater")
      const { invoke } = await import("@tauri-apps/api/core")
      const { timeout } = requestOptions().check
      // Native bestRolling only admits state=rolling; inRollout refuses rollout<=0.
      // Bucket zero bypasses positive percentages for manual Check, never a pause
      // or revocation. Keep the persisted device cohort unchanged.
      const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>(
        "desktop_update_check",
        {
          channel: options.channel,
          bucket: options.manual ? 0 : options.rolloutBucket,
          timeoutMs: timeout,
        }
      )
      const update: UpdateHandle | null = metadata ? new Update(metadata) : null
      if (
        pendingUpdate &&
        pendingPolicy === policy &&
        (downloadInFlight ||
          installInFlight ||
          (pendingDownloaded && update?.version === pendingUpdate.version))
      ) {
        const kept = pendingUpdate
        if (update !== kept) await closeHandle(update)
        return availableFromHandle(kept)
      }
      await replacePendingUpdate(update, policy)
      return availableFromHandle(update)
    } catch (error) {
      throw classifyError(error, "check")
    } finally {
      checkInFlight = null
      checkPolicy = null
    }
  })()
  checkInFlight = task
  return task
}

export function checkForUpdate(options?: UpdateCheckOptions): Promise<AvailableUpdate | null> {
  if (!isTauri()) return Promise.resolve(null)
  if (installedVersionAwaitingRestart) return Promise.resolve(null)
  try {
    options ??= getUpdateCheckOptions()
  } catch (error) {
    return Promise.reject(classifyError(error, "check"))
  }
  if ((downloadInFlight || installInFlight) && pendingUpdate) {
    if (pendingPolicy === policyKey(options))
      return Promise.resolve(availableFromHandle(pendingUpdate))
    // Never close a resource while the plugin is downloading/installing it.
    return Promise.allSettled([downloadInFlight, installInFlight]).then(() =>
      checkForUpdate(options)
    )
  }
  return startCheck(options)
}

async function ensurePendingUpdate(expectedVersion?: string): Promise<UpdateHandle | null> {
  // A check that started just before a download/install owns pendingUpdate.
  // Let it finish before reading the handle so it cannot replace and close a
  // resource while that resource is being downloaded or installed.
  if (checkInFlight) await checkInFlight
  if (installedVersionAwaitingRestart) return null
  if (
    pendingUpdate &&
    (!expectedVersion || pendingUpdate.version === expectedVersion) &&
    (pendingDownloaded || Date.now() - pendingUpdateAt <= PENDING_UPDATE_TTL_MS)
  ) {
    return pendingUpdate
  }
  if (pendingUpdate) await replacePendingUpdate(null)
  // This check is part of the download operation itself. Calling the public
  // function here would mistake our own `downloadInFlight` lock for a
  // competing download and skip the required fetch when the cache is empty.
  await startCheck(lastCheckOptions ?? getUpdateCheckOptions())
  return pendingUpdate
}

function progressListener(onProgress?: UpdateProgressHandler): (event: DownloadEvent) => void {
  let downloaded = 0
  let total: number | undefined
  return (event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength
        downloaded = 0
        break
      case "Progress":
        downloaded += event.data.chunkLength
        if (total !== undefined) downloaded = Math.min(downloaded, total)
        break
      case "Finished":
        downloaded = total ?? downloaded
        break
    }
    onProgress?.({ downloaded, total })
  }
}

export interface UpdateTargetOptions {
  /** Exact version the caller offered; another release requires a new offer. */
  expectedVersion?: string
}

function versionMatches(version: string | undefined | null, options: UpdateTargetOptions): boolean {
  return !options.expectedVersion || version === options.expectedVersion
}

export type DownloadUpdateResult = "downloaded" | "noLongerAvailable" | "versionMismatch" | "web"

/** Download and verify the pending package without installing it. */
export function downloadUpdate(
  onProgress?: UpdateProgressHandler,
  options: UpdateTargetOptions = {}
): Promise<DownloadUpdateResult> {
  if (!isTauri()) return Promise.resolve("web")
  if (installedVersionAwaitingRestart) return Promise.resolve("noLongerAvailable")
  if (downloadInFlight)
    return downloadInFlight.then((result) =>
      result === "downloaded" &&
      !versionMatches(pendingUpdate?.version ?? installedVersionAwaitingRestart, options)
        ? "versionMismatch"
        : result
    )

  const task = (async () => {
    try {
      const handle = await ensurePendingUpdate(options.expectedVersion)
      if (!handle) return "noLongerAvailable" as const
      if (!versionMatches(handle.version, options)) return "versionMismatch" as const
      if (pendingDownloaded) return "downloaded" as const
      await handle.download(progressListener(onProgress), requestOptions().download)
      if (pendingUpdate === handle) pendingDownloaded = true
      return "downloaded" as const
    } catch (error) {
      throw classifyError(error, "download")
    } finally {
      downloadInFlight = null
    }
  })()
  downloadInFlight = task
  return task
}

export type InstallUpdateResult =
  "relaunching" | "installed" | "noLongerAvailable" | "versionMismatch" | "web"

export interface InstallUpdateOptions extends UpdateTargetOptions {
  /** Defaults to the persisted `updates.relaunchAfterInstall` preference. */
  relaunch?: boolean
}

/**
 * Restart the app, saving window geometry first so it comes back where it was.
 *
 * Not update-specific despite living here: a plugin runtime left dirty can
 * only be cleared by a restart, and DevTools offers that as an action rather
 * than as a sentence telling the user to do it themselves.
 */
export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return
  try {
    try {
      const { saveWindowState, StateFlags } = await import("@tauri-apps/plugin-window-state")
      await saveWindowState(
        StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED | StateFlags.DECORATIONS
      )
    } catch (error) {
      loggers.app.warn("window state save failed before updater relaunch", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch (error) {
    throw classifyError(error, "relaunch")
  }
}

/** Install an already-downloaded update, downloading first when necessary. */
export function installUpdate(options: InstallUpdateOptions = {}): Promise<InstallUpdateResult> {
  if (!isTauri()) return Promise.resolve("web")
  if (installInFlight)
    return installInFlight.then((result) =>
      (result === "installed" || result === "relaunching") &&
      !versionMatches(installedVersionAwaitingRestart, options)
        ? "versionMismatch"
        : result
    )
  if (installedVersionAwaitingRestart)
    return Promise.resolve(
      versionMatches(installedVersionAwaitingRestart, options) ? "installed" : "versionMismatch"
    )

  const task = (async () => {
    if (checkInFlight) await checkInFlight
    const downloadResult = await downloadUpdate(undefined, options)
    if (downloadResult !== "downloaded") return downloadResult
    if (checkInFlight) await checkInFlight
    const handle = pendingUpdate
    if (!handle) return "noLongerAvailable" as const
    if (!versionMatches(handle.version, options)) return "versionMismatch" as const

    // The Windows NSIS installer terminates this process as part of the
    // install, so anything after `await install()` may simply never run. Mark
    // the version as installed-pending-restart BEFORE handing control to the
    // installer and roll the marker back only if the call actually returns an
    // error. Relying on the post-await line is how a successful Windows
    // install came back looking like it never happened.
    const previousMarker = installedVersionAwaitingRestart
    setInstalledVersionAwaitingRestart(handle.version)
    try {
      await handle.install()
    } catch (error) {
      setInstalledVersionAwaitingRestart(previousMarker)
      throw classifyError(error, "install")
    }

    pendingUpdate = null
    pendingPolicy = null
    pendingUpdateAt = 0
    pendingDownloaded = false
    await closeHandle(handle)

    const shouldRelaunch = options.relaunch ?? currentUpdateSettings().relaunchAfterInstall
    if (!shouldRelaunch) return "installed" as const
    await relaunchAfterUpdate()
    return "relaunching" as const
  })().finally(() => {
    installInFlight = null
  })
  installInFlight = task
  return task
}

/** Complete the common manual flow through the same separate download/install APIs. */
export async function downloadAndInstallUpdate(
  onProgress?: UpdateProgressHandler,
  options: InstallUpdateOptions = {}
): Promise<InstallUpdateResult> {
  if (installInFlight) return installUpdate(options)
  if (installedVersionAwaitingRestart)
    return versionMatches(installedVersionAwaitingRestart, options)
      ? "installed"
      : "versionMismatch"
  const downloadResult = await downloadUpdate(onProgress, options)
  if (downloadResult !== "downloaded") return downloadResult
  return installUpdate(options)
}

/** Test-only reset for native resource and in-flight state. */
export function __resetPendingUpdate(): void {
  const handle = pendingUpdate
  pendingUpdate = null
  pendingPolicy = null
  pendingUpdateAt = 0
  pendingDownloaded = false
  setInstalledVersionAwaitingRestart(null)
  checkInFlight = null
  checkPolicy = null
  lastCheckOptions = undefined
  downloadInFlight = null
  installInFlight = null
  void closeHandle(handle)
}

/** Relaunch after a previously installed update. */
export async function relaunchAfterUpdate(): Promise<void> {
  return relaunchApp()
}
