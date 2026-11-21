"use client"

/**
 * Push the user's terminal profiles to the host that will spawn them.
 *
 * A remote spawn frame carries a profile **id** (plus an idempotency requestId)
 * and nothing else — `TerminalHost::spawn_local` refuses non-local identities,
 * so the shell, cwd, env, and sandbox flags never cross the streaming socket.
 *
 * Two commands, because they are two different authorities:
 *   * local PTY → `terminal_host_service`, the desktop's own command;
 *   * remote host → `terminal_host_sync_profiles`, capability-gated on
 *     `terminal.open`, device-scoped on the host, and `approval: "interactive"`
 *     (requiring a device-bound `adminLease` on explicit user actions).
 *
 * Every per-target table replacement is serialized on that target's queue and
 * merges saved profiles, registered transient profiles (e.g. external agent
 * CLIs), and active in-flight launch profiles (unique per launch so concurrent
 * ad-hoc or worktree-overridden named launches never overwrite one another or
 * erase pending agent profiles — T01, T02, T05, T13, T14).
 */

import { transport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"

import { getObservedTerminalHostId } from "./host-capabilities"
import {
  callWithTerminalAdminLease,
  currentTerminalTargetKey,
  endpointTargetKey,
  type BoundTerminalRemoteTarget,
} from "./host-target"
import { selectTerminalTransportChain } from "./pick-transport"
import { profileToSpawnFields, type TerminalProfile } from "./profiles"
import { buildSynchronizedConnectRequest } from "./ssh-forwarding"
import { type SshConnectRequest, type SshHostProfile } from "./ssh-profiles"
import type { SpawnRequest } from "./types"

export const ADHOC_PROFILE_ID = "__adhoc"

export interface TerminalProfileHostDefaults {
  enableShellIntegration?: boolean
  forceUtf8?: boolean
  sandboxed?: boolean
  sshProfiles?: SshHostProfile[]
  /**
   * Legacy single-slot ad-hoc spawn request; preserved for direct callers while
   * orchestrator launches mint distinct in-flight identities via
   * {@link acquireRemoteLaunchProfile}.
   */
  adHoc?: SpawnRequest
  /** Explicit user-launched profiles, kept outside persistent settings. */
  transientProfiles?: readonly SynchronizedTerminalProfile[]
  /**
   * Request an interactive `adminLease` when synchronizing to a remote host.
   * Enabled for explicit user gestures (terminal spawn, settings save, cleanup);
   * kept false for passive background boot warming.
   */
  interactive?: boolean
  /** Bound target key for multi-step operations that captured their Host up front. */
  targetKey?: string
  /** Bound RPC transport for the captured target. */
  targetTransport?: Pick<Transport, "call">
}

export interface SynchronizedTerminalProfile {
  profileId: string
  request: SpawnRequest
}

export interface SynchronizedSshProfile {
  profileId: string
  request: SshConnectRequest
}

/**
 * Strip renderer-only fields (`origin`) so every wire payload conforms to
 * `protocol/companion-request-schemas.json` (`additionalProperties: false`).
 */
export function sanitizeWireSpawnRequest(req: SpawnRequest): SpawnRequest {
  const wire: SpawnRequest = {
    shell: req.shell,
    rows: req.rows,
    cols: req.cols,
  }
  if (req.profileId !== undefined) wire.profileId = req.profileId
  if (req.args !== undefined) wire.args = [...req.args]
  if (req.cwd !== undefined) wire.cwd = req.cwd
  if (req.env !== undefined) wire.env = { ...req.env }
  if (req.projectId !== undefined) wire.projectId = req.projectId
  if (req.extensionId !== undefined) wire.extensionId = req.extensionId
  if (req.enableShellIntegration !== undefined) {
    wire.enableShellIntegration = req.enableShellIntegration
  }
  if (req.forceUtf8 !== undefined) wire.forceUtf8 = req.forceUtf8
  if (req.sandboxed !== undefined) wire.sandboxed = req.sandboxed
  if (req.sandboxNetwork !== undefined) wire.sandboxNetwork = req.sandboxNetwork
  return wire
}

export function buildSynchronizedTerminalProfiles(
  profiles: TerminalProfile[] | undefined,
  defaults: TerminalProfileHostDefaults = {}
): SynchronizedTerminalProfile[] {
  return (profiles ?? []).flatMap((profile) => {
    const fields = profileToSpawnFields(profile)
    if (!fields) return []
    return [
      {
        profileId: profile.id,
        request: sanitizeWireSpawnRequest({
          ...fields,
          rows: 24,
          cols: 80,
          enableShellIntegration: defaults.enableShellIntegration ?? true,
          forceUtf8: defaults.forceUtf8 ?? true,
          sandboxed: defaults.sandboxed ?? false,
          sandboxNetwork: true,
        }),
      },
    ]
  })
}

export function buildSynchronizedSshProfiles(
  profiles: SshHostProfile[] | undefined
): SynchronizedSshProfile[] {
  const all = profiles ?? []
  return all.flatMap((profile) => {
    const request = buildSynchronizedConnectRequest(profile, all)
    return request ? [{ profileId: profile.id, request }] : []
  })
}

interface TransientProfile {
  request: SpawnRequest
  target?: string
  removing?: boolean
}

const transientProfiles = new Map<string, TransientProfile>()
const inFlightLaunchesByTarget = new Map<string, Map<string, SpawnRequest>>()
const targetSyncQueues = new Map<string, Promise<void>>()

interface TargetSyncState {
  revision: string
  hostId: string | null
  promise: Promise<void>
}
const syncedByTarget = new Map<string, TargetSyncState>()

function enqueueTargetSync(targetKey: string, task: () => Promise<void>): Promise<void> {
  const prior = targetSyncQueues.get(targetKey) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(task)
  targetSyncQueues.set(targetKey, next)
  return next
}

function addInFlightLaunch(targetKey: string, launchId: string, request: SpawnRequest): void {
  let map = inFlightLaunchesByTarget.get(targetKey)
  if (!map) {
    map = new Map()
    inFlightLaunchesByTarget.set(targetKey, map)
  }
  map.set(launchId, sanitizeWireSpawnRequest(request))
}

function removeInFlightLaunch(targetKey: string, launchId: string): void {
  const map = inFlightLaunchesByTarget.get(targetKey)
  if (!map) return
  map.delete(launchId)
  if (map.size === 0) inFlightLaunchesByTarget.delete(targetKey)
}

function collectTargetExtras(
  targetKey: string | undefined,
  explicit: readonly SynchronizedTerminalProfile[] | undefined
): SynchronizedTerminalProfile[] {
  const merged = new Map<string, SpawnRequest>()
  for (const entry of explicit ?? []) {
    merged.set(entry.profileId, sanitizeWireSpawnRequest(entry.request))
  }
  if (targetKey) {
    for (const [profileId, profile] of transientProfiles.entries()) {
      if (profile.target === targetKey && !profile.removing && !merged.has(profileId)) {
        merged.set(profileId, sanitizeWireSpawnRequest(profile.request))
      }
    }
    const launches = inFlightLaunchesByTarget.get(targetKey)
    if (launches) {
      for (const [launchId, req] of launches.entries()) {
        merged.set(launchId, req)
      }
    }
  }
  return [...merged.entries()].map(([profileId, request]) => ({ profileId, request }))
}

export async function syncTerminalHostProfiles(
  profiles: TerminalProfile[] | undefined,
  defaults: TerminalProfileHostDefaults = {},
  call?: typeof transport.call
): Promise<void> {
  const isLocal = !defaults.targetTransport && selectTerminalTransportChain()[0] === "tauri-channel"
  if (isLocal) {
    const synchronized = buildSynchronizedTerminalProfiles(profiles, defaults)
    for (const profile of defaults.transientProfiles ?? []) {
      if (synchronized.some((saved) => saved.profileId === profile.profileId)) {
        throw new Error("transient terminal profile conflicts with a saved profile")
      }
      synchronized.push({
        profileId: profile.profileId,
        request: sanitizeWireSpawnRequest(profile.request),
      })
    }
    const invoke = call ?? transport.call.bind(transport)
    await invoke("terminal_host_service", {
      action: {
        kind: "syncProfiles",
        profiles: synchronized,
        sshProfiles: buildSynchronizedSshProfiles(defaults.sshProfiles),
      },
    })
    return
  }

  const targetKey = defaults.targetKey ?? (await resolveDefaultRemoteTargetKey())
  await enqueueTargetSync(targetKey, async () => {
    const synchronized = buildSynchronizedTerminalProfiles(profiles, defaults)
    const extras = collectTargetExtras(targetKey, defaults.transientProfiles)
    for (const profile of extras) {
      if (synchronized.some((saved) => saved.profileId === profile.profileId)) {
        throw new Error("transient terminal profile conflicts with a saved profile")
      }
      synchronized.push(profile)
    }
    const remote = defaults.adHoc
      ? [
          ...synchronized.filter((entry) => entry.profileId !== ADHOC_PROFILE_ID),
          { profileId: ADHOC_PROFILE_ID, request: sanitizeWireSpawnRequest(defaults.adHoc) },
        ]
      : synchronized

    if (call) {
      await call("terminal_host_sync_profiles", { profiles: remote })
      return
    }
    if (defaults.interactive) {
      await callWithTerminalAdminLease(
        "terminal_host_sync_profiles",
        { profiles: remote },
        {
          transport: defaults.targetTransport,
          targetKey,
        }
      )
      return
    }
    const caller = defaults.targetTransport ?? transport
    await caller.call("terminal_host_sync_profiles", { profiles: remote })
  })
}

function computeSettingsRevision(terminal: SettingsSnapshot["terminal"]): string {
  return JSON.stringify([
    terminal?.profiles ?? [],
    terminal?.enableShellIntegration ?? true,
    terminal?.forceUtf8 ?? true,
    terminal?.sandboxed ?? false,
  ])
}

async function resolveDefaultRemoteTargetKey(): Promise<string> {
  const syncKey = currentTerminalTargetKey()
  if (syncKey !== "default") return syncKey
  try {
    return await currentProfileTarget()
  } catch {
    return syncKey
  }
}

/**
 * Make sure the currently selected remote host knows this device's saved
 * profiles.
 *
 * Keyed per `(targetKey, hostId, settingsRevision)` so:
 *   * a local desktop no-op never marks a subsequent remote Host as synced,
 *   * a failed sync is evicted and retried on the next attempt,
 *   * switching Hosts, re-pairing, editing profiles, or restarting the Host
 *     process (`hostId` change) re-synchronizes instead of serving stale state.
 */
export function ensureTerminalHostProfilesSynced(options?: {
  interactive?: boolean
  waitForSettingsLoad?: boolean
  targetKey?: string
  targetTransport?: Pick<Transport, "call">
  call?: typeof transport.call
}): Promise<void> {
  const chain = selectTerminalTransportChain()
  if (!options?.targetTransport && (chain.length === 0 || chain[0] === "tauri-channel")) {
    return Promise.resolve()
  }

  return (async () => {
    const targetKey = options?.targetKey ?? (await resolveDefaultRemoteTargetKey())
    const { snapshot: settings, loaded: settingsWereLoaded } = options?.waitForSettingsLoad
      ? { snapshot: await settingsLoaded(), loaded: true }
      : await currentSettingsSnapshot()
    const terminal = settings.terminal
    const revision = computeSettingsRevision(terminal)
    const observedHostId = getObservedTerminalHostId()
    const existing = syncedByTarget.get(targetKey)
    if (
      settingsWereLoaded &&
      existing &&
      existing.revision === revision &&
      (observedHostId === null || existing.hostId === null || existing.hostId === observedHostId)
    ) {
      if (observedHostId && existing.hostId === null) {
        existing.hostId = observedHostId
      }
      return existing.promise
    }

    const entry: TargetSyncState = {
      revision,
      hostId: observedHostId,
      promise: Promise.resolve(),
    }
    entry.promise = (async () => {
      try {
        await syncTerminalHostProfiles(
          terminal?.profiles,
          {
            enableShellIntegration: terminal?.enableShellIntegration,
            forceUtf8: terminal?.forceUtf8,
            sandboxed: terminal?.sandboxed,
            interactive: options?.interactive,
            targetKey,
            targetTransport: options?.targetTransport,
          },
          options?.call
        )
        entry.hostId = getObservedTerminalHostId() ?? entry.hostId
      } catch (error) {
        if (syncedByTarget.get(targetKey) === entry) {
          syncedByTarget.delete(targetKey)
        }
        if (options?.interactive) throw error
      }
    })()
    if (settingsWereLoaded) {
      syncedByTarget.set(targetKey, entry)
    }
    return entry.promise
  })()
}

async function currentSettingsSnapshot(): Promise<{
  snapshot: SettingsSnapshot
  loaded: boolean
}> {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  const state = useSettingsStore.getState()
  return {
    snapshot: (state.settings ?? {}) as SettingsSnapshot,
    loaded: Boolean(state.loaded),
  }
}

async function immediateSettingsSnapshot(): Promise<SettingsSnapshot> {
  return (await currentSettingsSnapshot()).snapshot
}

/** Settings as soon as they are loaded, or immediately if they already are. */
async function settingsLoaded(): Promise<SettingsSnapshot> {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  const state = useSettingsStore.getState()
  if (state.loaded) return (state.settings ?? {}) as SettingsSnapshot
  return new Promise<SettingsSnapshot>((resolve) => {
    const stop = useSettingsStore.subscribe((next) => {
      if (!next.loaded) return
      stop()
      resolve((next.settings ?? {}) as SettingsSnapshot)
    })
  })
}

interface SettingsSnapshot {
  terminal?: {
    profiles?: TerminalProfile[]
    enableShellIntegration?: boolean
    forceUtf8?: boolean
    sandboxed?: boolean
  }
}

/** Test-only: reset synchronization caches and queues. */
export function __resetTerminalHostProfileSyncForTests(): void {
  syncedByTarget.clear()
  transientProfiles.clear()
  inFlightLaunchesByTarget.clear()
  targetSyncQueues.clear()
}

export interface TransientProfileSyncDeps {
  call?: typeof transport.call
  readSettings?: typeof settingsLoaded
  resolveTarget?: () => Promise<string>
  target?: BoundTerminalRemoteTarget
}

/** Register fixed argv before the ordinary orchestrator chooses its transport. */
export function registerTransientTerminalProfile(request: SpawnRequest): void {
  const id = request.profileId
  if (
    !id ||
    id === "default" ||
    id === ADHOC_PROFILE_ID ||
    id.startsWith(`${ADHOC_PROFILE_ID}:`) ||
    id.startsWith("__launch:")
  ) {
    throw new Error("transient terminal profile needs a distinct identity")
  }
  if (transientProfiles.has(id)) throw new Error("transient terminal profile is already registered")
  transientProfiles.set(id, {
    request: sanitizeWireSpawnRequest(request),
  })
}

export function hasTransientTerminalProfile(profileId: string): boolean {
  return transientProfiles.has(profileId)
}

async function currentProfileTarget(): Promise<string> {
  const { defaultCompanionEndpointResolver } = await import("@/lib/tauri/companion-endpoint")
  const endpoint = await defaultCompanionEndpointResolver()
  if (!endpoint) throw new Error("terminal host is unavailable for profile synchronization")
  return endpointTargetKey(endpoint)
}

function syncTransientProfiles(target: string, deps: TransientProfileSyncDeps): Promise<void> {
  const resolveTarget =
    deps.resolveTarget ?? (deps.target ? async () => deps.target!.key : currentProfileTarget)
  return (async () => {
    if ((await resolveTarget()) !== target) {
      throw new Error("select the original terminal host to synchronize its agent profile")
    }
    const terminal = (await (deps.readSettings ?? settingsLoaded)()).terminal
    if ((await resolveTarget()) !== target) {
      throw new Error("select the original terminal host to synchronize its agent profile")
    }
    await deps.target?.assertCurrent()
    await syncTerminalHostProfiles(
      terminal?.profiles,
      {
        enableShellIntegration: terminal?.enableShellIntegration,
        forceUtf8: terminal?.forceUtf8,
        sandboxed: terminal?.sandboxed,
        interactive: true,
        targetKey: target,
        targetTransport: deps.target?.transport,
        transientProfiles: [...transientProfiles.entries()].flatMap(([profileId, profile]) =>
          profile.target === target && !profile.removing
            ? [{ profileId, request: profile.request }]
            : []
        ),
      },
      deps.call
    )
  })()
}

/** Remove host launch metadata after its process has been terminated. Retryable. */
export async function removeTransientTerminalProfile(
  profileId: string,
  deps: TransientProfileSyncDeps = {}
): Promise<void> {
  const profile = transientProfiles.get(profileId)
  if (!profile) return
  if (!profile.target) {
    transientProfiles.delete(profileId)
    return
  }
  profile.removing = true
  try {
    await syncTransientProfiles(profile.target, deps)
    if (transientProfiles.get(profileId) === profile) transientProfiles.delete(profileId)
  } catch (error) {
    throw error
  }
}

export interface RemoteLaunchProfileLease {
  /** Wire profile identifier to pass in the `Spawn` frame. */
  profileId: string
  /** Logical user/agent profile identifier, if the launch originated from one. */
  logicalProfileId?: string
  /** Release ephemeral in-flight launch state once `Spawn` settles. */
  release(): void
}

/**
 * Synchronize the exact resolved launch request onto the bound target Host and
 * return a collision-free wire `profileId` plus a cleanup handle.
 *
 *   - Registered transient profiles (e.g. external agent CLIs) keep their
 *     explicit `profileId` so `rehydrateTerminalProfile` can locate them.
 *   - Host-owned SSH profiles (`shell === ""`) carry no client `SpawnRequest`
 *     and resolve against the Host desktop's `ssh_profiles` map directly.
 *   - Named user profiles and ad-hoc launches each receive a unique per-launch
 *     wire id (`__launch:<id>:<uuid>` / `__adhoc:<uuid>`) carrying the exact
 *     worktree `cwd`, `projectId`, `sandboxed`, and plugin-accepted fields, so
 *     concurrent launches never overwrite one another and named launches never
 *     drop per-turn overrides (T01, T02, T13, T14).
 */
export async function acquireRemoteLaunchProfile(
  request: SpawnRequest,
  deps: TransientProfileSyncDeps = {}
): Promise<RemoteLaunchProfileLease> {
  const resolveTarget =
    deps.resolveTarget ?? (deps.target ? async () => deps.target!.key : currentProfileTarget)

  if (request.profileId && request.profileId.trim().length > 0) {
    const transient = transientProfiles.get(request.profileId)
    if (transient) {
      if (transient.removing) throw new Error("transient terminal profile cleanup is pending")
      transient.request = sanitizeWireSpawnRequest(request)
      const target = await resolveTarget()
      if (transient.target && transient.target !== target) {
        throw new Error("terminal agent profile belongs to another host")
      }
      transient.target = target
      await syncTransientProfiles(target, deps)
      return {
        profileId: request.profileId,
        logicalProfileId: request.profileId,
        release() {},
      }
    }

    // Host-mediated SSH connects send `shell: ""` and resolve `ssh_profiles`
    // registered by the Host's own desktop.
    if (request.shell.trim().length === 0) {
      return {
        profileId: request.profileId,
        logicalProfileId: request.profileId,
        release() {},
      }
    }
  }

  const target = await resolveTarget()
  const terminal = (await (deps.readSettings ?? immediateSettingsSnapshot)()).terminal
  if ((await resolveTarget()) !== target) {
    throw new Error("selected terminal host changed before profile synchronization")
  }
  await deps.target?.assertCurrent()

  if (
    request.profileId &&
    (terminal?.profiles ?? []).some((saved) => saved.id === request.profileId) === false &&
    request.profileId !== "default"
  ) {
    // Still honor an explicit custom profileId with a non-empty shell by
    // syncing its exact launch fields under a distinct launch slot.
  }

  const logicalProfileId =
    request.profileId && request.profileId.trim().length > 0 ? request.profileId : undefined
  const launchId = logicalProfileId
    ? `__launch:${logicalProfileId}:${crypto.randomUUID()}`
    : `${ADHOC_PROFILE_ID}:${crypto.randomUUID()}`

  addInFlightLaunch(target, launchId, {
    ...request,
    profileId: logicalProfileId,
  })
  try {
    await syncTerminalHostProfiles(
      terminal?.profiles,
      {
        enableShellIntegration: terminal?.enableShellIntegration,
        forceUtf8: terminal?.forceUtf8,
        sandboxed: terminal?.sandboxed,
        interactive: true,
        targetKey: target,
        targetTransport: deps.target?.transport,
      },
      deps.call
    )
    return {
      profileId: launchId,
      logicalProfileId,
      release: () => removeInFlightLaunch(target, launchId),
    }
  } catch (error) {
    removeInFlightLaunch(target, launchId)
    throw error
  }
}

export async function ensureRemoteSpawnProfile(
  request: SpawnRequest,
  deps: TransientProfileSyncDeps = {}
): Promise<string> {
  const lease = await acquireRemoteLaunchProfile(request, deps)
  return lease.profileId
}
